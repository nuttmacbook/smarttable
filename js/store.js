// โมเดลข้อมูล: ส่งออก/นำเข้า JSON + migrate v1->v2->v3->v4 + ตรวจโครงสร้าง + cascade (pure ไม่แตะ storage/DOM)
// production-only (O20): ไม่มี localStorage persistence และไม่มี seed — ข้อมูลอยู่ที่เซิร์ฟเวอร์ ย้ายข้อมูลเดิมด้วยนำเข้าไฟล์ JSON (v1–v4)
// v4: plans (แผนการเรียน), group.subjectIds/planId, กฎ hours บล็อก (ข้อมูลเดิมที่เกินเก็บเป็น legacyViolations)
// v3: subject.teacherIds (0..n), entry.teacherId (เลือกจาก teacherIds)
// v2: groups = กลุ่มเรียน (เดิม rooms/roomId), rooms = ห้องเรียน (สถานที่ใหม่), entries[].roomId = ห้องเรียน|null
import { STATE_VERSION, SUBJECT_TYPES, LEVELS } from './constants.js';
import { validateAll, hoursViolations } from './scheduler.js';
import { RESERVED_IDS, textIssues } from './validate.js';

export function emptyState() {
  return { version: STATE_VERSION, subjects: [], teachers: [], groups: [], rooms: [], plans: [], entries: [] };
}

let counter = 0;
export function uid(prefix = 'id') {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------- migration v1 -> v2 -> v3 -> v4 ----------
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const arr = (x) => (Array.isArray(x) ? x : []);
const MAX_YEAR = new Map([['ปวช.', 3], ['ปวส.', 2]]); // Map กัน level ชื่อ constructor/__proto__ (W-02)
const keep = (row, fn) => (isObj(row) ? fn(row) : row);

function migrateLevel(level, year) {
  if (LEVELS.includes(level)) return level;
  if (!MAX_YEAR.has(level)) return level; // ค่าแปลก คงไว้ให้ตัวตรวจ import รายงาน
  const y = Number.isInteger(year) && year >= 1 && year <= MAX_YEAR.get(level) ? year : 1;
  return `${level}${y}`;
}

// v1 -> v2 (ผลลัพธ์ยังมี subject.teacherId)
function v1ToV2(raw) {
  const groups = arr(raw.rooms).map((r) =>
    keep(r, ({ year, level, ...rest }) => ({ ...rest, level: migrateLevel(level, year) })),
  );
  const levelOfGroup = new Map(groups.filter(isObj).map((g) => [g.id, g.level]));
  const entries = arr(raw.entries).map((e) =>
    keep(e, ({ roomId, ...rest }) => ({ ...rest, groupId: roomId, roomId: null })),
  );
  const subjects = arr(raw.subjects).map((s) =>
    keep(s, (x) => {
      const used = new Set(
        entries.filter((e) => isObj(e) && e.subjectId === x.id).map((e) => levelOfGroup.get(e.groupId)),
      );
      used.delete(undefined);
      const levels = used.size ? LEVELS.filter((l) => used.has(l)) : [...LEVELS];
      return { ...x, teacherId: x.teacherId || null, levels };
    }),
  );
  return { version: 2, subjects, teachers: arr(raw.teachers), groups, rooms: [], entries };
}

// v2 -> v3: teacherIds = [teacherId] (ลบ teacherId); entry.teacherId = ครูคนเดียวของวิชาเดิม | null
function v2ToV3(v2) {
  const oldTeacher = new Map();
  const subjects = arr(v2.subjects).map((s) =>
    keep(s, ({ teacherId, ...rest }) => {
      if (isObj(s)) oldTeacher.set(s.id, teacherId || null);
      return { ...rest, teacherIds: Array.isArray(s.teacherIds) ? s.teacherIds : teacherId ? [teacherId] : [] };
    }),
  );
  const entries = arr(v2.entries).map((e) =>
    keep(e, (x) => ({ ...x, roomId: x.roomId ?? null, teacherId: x.teacherId ?? oldTeacher.get(x.subjectId) ?? null })),
  );
  return { ...v2, version: 3, subjects, entries };
}

// v3 -> v4: plans=[]; group.subjectIds = วิชาที่กลุ่มมี entry (เรียงตามรหัสวิชา); group.planId = null
function v3ToV4(v3) {
  const subjects = arr(v3.subjects);
  const codeOf = new Map(subjects.filter(isObj).map((s) => [s.id, String(s.code ?? '')]));
  const used = new Map();
  for (const e of arr(v3.entries)) {
    if (!isObj(e) || !codeOf.has(e.subjectId)) continue;
    if (!used.has(e.groupId)) used.set(e.groupId, new Set());
    used.get(e.groupId).add(e.subjectId);
  }
  const groups = arr(v3.groups).map((g) =>
    keep(g, (x) => ({
      ...x,
      subjectIds: Array.isArray(x.subjectIds)
        ? x.subjectIds
        : [...(used.get(x.id) ?? [])].sort((a, b) => codeOf.get(a).localeCompare(codeOf.get(b)) || (a < b ? -1 : 1)),
      planId: x.planId ?? null,
    })),
  );
  return { ...v3, version: STATE_VERSION, groups, plans: arr(v3.plans) };
}

// รับ object ดิบ (v1 ไม่มี version/1, v2, v3 หรือ v4) คืน state v4 ไม่แก้ของเดิม (idempotent)
export function migrateState(raw) {
  if (!isObj(raw)) return raw;
  const v = raw.version;
  if (v === STATE_VERSION) {
    return {
      ...raw,
      subjects: arr(raw.subjects),
      teachers: arr(raw.teachers),
      groups: arr(raw.groups).map((g) => keep(g, (x) => ({ ...x, planId: x.planId ?? null }))),
      rooms: arr(raw.rooms),
      plans: arr(raw.plans),
      entries: arr(raw.entries).map((e) =>
        keep(e, (x) => ({ ...x, roomId: x.roomId ?? null, teacherId: x.teacherId ?? null })),
      ),
    };
  }
  if (v === 3) return v3ToV4({ ...raw, groups: arr(raw.groups), rooms: arr(raw.rooms) });
  if (v === 2) return v3ToV4(v2ToV3({ ...raw, groups: arr(raw.groups), rooms: arr(raw.rooms) }));
  if (v === undefined || v === 1) return v3ToV4(v2ToV3(v1ToV2(raw)));
  return raw; // เวอร์ชันไม่รู้จัก ให้ตัวตรวจปฏิเสธ
}

// ---------- validate ----------
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const KEYS = ['subjects', 'teachers', 'groups', 'rooms', 'plans', 'entries'];
const REQUIRED = {
  subjects: ['id', 'name'],
  teachers: ['id', 'name'],
  groups: ['id', 'name'],
  rooms: ['id', 'name'],
  plans: ['id', 'name'],
  entries: ['id', 'groupId', 'day', 'period', 'subjectId'],
};
const LABEL = { subjects: 'รายวิชา', teachers: 'ครู', groups: 'กลุ่มเรียน', rooms: 'ห้องเรียน', plans: 'แผนการเรียน' };

// ตรวจโครงสร้าง (ไม่ตรวจชน/hours) รับข้อความ JSON หรือ object; ข้อมูล v1/v2/v3 จะ migrate ให้ก่อน
// คืน { ok, state?, errors:[string], migrated? }
export function parseState(text) {
  let data;
  try {
    data = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    return { ok: false, errors: ['ไฟล์ไม่ใช่ JSON ที่ถูกต้อง'] };
  }
  if (!isObj(data)) return { ok: false, errors: ['รูปแบบข้อมูลไม่ถูกต้อง'] };

  const isV1 = data.version === undefined || data.version === 1;
  if (!isV1 && ![2, 3, STATE_VERSION].includes(data.version)) {
    return { ok: false, errors: [`เวอร์ชันข้อมูลไม่รองรับ (ต้องเป็น ${STATE_VERSION}, 3, 2 หรือ 1)`] };
  }
  const errors = [];
  let need = KEYS;
  if (data.version === 3 || data.version === 2) need = KEYS.filter((k) => k !== 'plans');
  if (isV1) need = ['subjects', 'teachers', 'rooms', 'entries'];
  for (const k of need) {
    if (!Array.isArray(data[k])) errors.push(`ข้อมูล "${k}" ต้องเป็นรายการ`);
  }
  if (errors.length) return { ok: false, errors };

  const d = migrateState(data);

  for (const k of KEYS) {
    const ids = new Set();
    d[k].forEach((row, i) => {
      if (!isObj(row)) {
        errors.push(`${LABEL[k] ?? 'ตารางสอน'} [${i}] ไม่ใช่ข้อมูลที่ถูกต้อง`);
        return;
      }
      for (const f of REQUIRED[k]) {
        if (row[f] === undefined || row[f] === null || row[f] === '') errors.push(`${k}[${i}] ขาดฟิลด์ ${f}`);
      }
      if (ids.has(row.id)) errors.push(`${k}: id "${row.id}" ซ้ำ`);
      if (typeof row.id === 'string' && RESERVED_IDS.has(row.id)) errors.push(`${k}: id "${row.id}" เป็นชื่อสงวน ใช้ไม่ได้`);
      ids.add(row.id);
    });
  }
  if (errors.length) return { ok: false, errors };

  // ข้อความ: ไม่มีอักขระควบคุม/กำกับทิศทาง/zero-width และไม่ยาวเกินกำหนด (ชื่อ/รหัส ≤200, อื่น ๆ ≤500)
  const TEXT = {
    subjects: [['code', 200], ['name', 200], ['note', 500]],
    teachers: [['name', 200], ['dept', 500]],
    groups: [['name', 200], ['major', 500]],
    rooms: [['name', 200], ['building', 500], ['note', 500]],
    plans: [['name', 200], ['note', 500]],
  };
  for (const [k, fields] of Object.entries(TEXT)) {
    d[k].forEach((row, i) => {
      for (const [f, max] of fields) {
        const v = row[f];
        if (v === undefined || v === null || v === '') continue;
        const issue = typeof v === 'string' ? textIssues(v, { max }) : 'ต้องเป็นข้อความ';
        if (issue) errors.push(`${LABEL[k]} [${i}]: ฟิลด์ ${f} ${issue}`);
      }
    });
  }

  for (const k of Object.keys(LABEL)) {
    d[k].forEach((row, i) => {
      if (!isText(row.name)) errors.push(`${LABEL[k]} [${i}]: ชื่อต้องเป็นข้อความไม่ว่าง`);
    });
  }
  const uniqueNames = (key, label) => {
    const names = new Set();
    for (const r of d[key]) {
      const n = typeof r.name === 'string' ? r.name.trim() : '';
      if (!n) continue;
      if (names.has(n)) errors.push(`${label} "${n}" ชื่อซ้ำ`);
      names.add(n);
    }
  };
  uniqueNames('rooms', 'ห้องเรียน');
  uniqueNames('plans', 'แผนการเรียน');
  for (const g of d.groups) {
    if (!LEVELS.includes(g.level)) {
      errors.push(`กลุ่มเรียน ${g.name}: ระดับ "${g.level}" ไม่ถูกต้อง (ต้องเป็น ${LEVELS.join(', ')})`);
    }
  }

  const codes = new Set();
  const teacherIds = new Set(d.teachers.map((t) => t.id));
  const subjectIds = new Set(d.subjects.map((s) => s.id));
  const idsBySubject = new Map();
  d.subjects.forEach((sub, i) => {
    if (!isText(sub.code)) errors.push(`รายวิชา [${i}]: รหัสวิชาต้องเป็นข้อความไม่ว่าง`);
    else {
      if (codes.has(sub.code)) errors.push(`รหัสวิชา ${sub.code} ซ้ำ`);
      codes.add(sub.code);
    }
    const label = `วิชา ${sub.code || sub.id}`;
    if (!SUBJECT_TYPES.some((t) => t.id === sub.type)) {
      errors.push(`${label}: ประเภทต้องเป็น general หรือ vocational`);
    }
    if (!Number.isInteger(sub.hours) || sub.hours <= 0) {
      errors.push(`${label}: ชม./สัปดาห์ ต้องเป็นจำนวนเต็มบวก`);
    }
    // ครูผู้สอน 0..n คน ต้องมีครูจริง ไม่ซ้ำ
    if (!Array.isArray(sub.teacherIds)) {
      errors.push(`${label}: teacherIds ต้องเป็นรายการ`);
    } else {
      idsBySubject.set(sub.id, sub.teacherIds);
      const seen = new Set();
      for (const tid of sub.teacherIds) {
        if (!teacherIds.has(tid)) errors.push(`${label}: ไม่พบครูผู้สอน id "${tid}"`);
        else if (seen.has(tid)) errors.push(`${label}: ครูผู้สอน id "${tid}" ซ้ำ`);
        seen.add(tid);
      }
    }
    if (!Array.isArray(sub.levels) || sub.levels.length === 0) {
      errors.push(`${label}: ต้องระบุระดับที่เปิดสอนอย่างน้อย 1 ระดับ`);
    } else if (sub.levels.some((l) => !LEVELS.includes(l))) {
      errors.push(`${label}: ระดับที่เปิดสอนต้องเป็นค่าใน ${LEVELS.join(', ')}`);
    }
  });

  // v4: plans / group.subjectIds / group.planId
  const subjectList = (list, label) => {
    if (!Array.isArray(list)) {
      errors.push(`${label}: subjectIds ต้องเป็นรายการ`);
      return;
    }
    const seen = new Set();
    for (const sid of list) {
      if (!subjectIds.has(sid)) errors.push(`${label}: ไม่พบรายวิชา id "${sid}"`);
      else if (seen.has(sid)) errors.push(`${label}: รายวิชา id "${sid}" ซ้ำ`);
      seen.add(sid);
    }
  };
  const planIds = new Set(d.plans.map((p) => p.id));
  d.plans.forEach((p) => {
    if (!LEVELS.includes(p.level)) {
      errors.push(`แผนการเรียน ${p.name}: ระดับ "${p.level}" ไม่ถูกต้อง (ต้องเป็น ${LEVELS.join(', ')})`);
    }
    subjectList(p.subjectIds, `แผนการเรียน ${p.name}`);
  });
  d.groups.forEach((g) => {
    subjectList(g.subjectIds, `กลุ่มเรียน ${g.name}`);
    if (g.planId !== null && g.planId !== undefined && !planIds.has(g.planId)) {
      errors.push(`กลุ่มเรียน ${g.name}: ไม่พบแผนการเรียน id "${g.planId}"`);
    }
  });

  const roomIds = new Set(d.rooms.map((r) => r.id));
  d.entries.forEach((e, i) => {
    if (e.roomId !== null && e.roomId !== undefined && !roomIds.has(e.roomId)) {
      errors.push(`ตารางสอน [${i}]: ไม่พบห้องเรียน id "${e.roomId}"`);
    }
    if (e.teacherId !== null && e.teacherId !== undefined) {
      const list = idsBySubject.get(e.subjectId);
      if (list && !list.includes(e.teacherId)) {
        errors.push(`ตารางสอน [${i}]: ครู id "${e.teacherId}" ไม่ได้เป็นครูผู้สอนของวิชานี้`);
      }
    }
  });
  if (errors.length) return { ok: false, errors };

  const state = { version: STATE_VERSION };
  for (const k of KEYS) state[k] = d[k];
  state.entries = state.entries.map((e) => ({ ...e, roomId: e.roomId ?? null, teacherId: e.teacherId ?? null }));
  return { ok: true, state, errors: [], migrated: data.version !== STATE_VERSION };
}

// ---------- กฎ hours: ข้อมูลเดิมที่เกิน ----------
// รายการที่ลงเกิน hours อยู่แล้ว (ข้อมูลเดิม) — [] ถ้าไม่มี; รูปเดียวกับ conflict type 'hours' ใน validateAll
export function legacyViolations(state) {
  return hoursViolations(state);
}

// ตัดคาบส่วนเกินออก: ต่อ กลุ่มเรียน+วิชา เก็บ hours คาบแรก (เรียง วัน→คาบ) ตัดที่ลงทีหลังสุดออก
// คืน { state, removed:[{entryId, groupId, groupName, subjectId, subjectCode, subjectName, day, period}] }
export function trimOverHours(state) {
  const buckets = new Map();
  for (const e of state.entries) {
    const k = `${e.groupId}\u0000${e.subjectId}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }
  const drop = new Map();
  for (const list of buckets.values()) {
    const subject = state.subjects.find((s) => s.id === list[0].subjectId);
    const hours = Number(subject && subject.hours);
    if (!subject || !Number.isFinite(hours) || hours <= 0 || list.length <= hours) continue;
    const sorted = [...list].sort((a, b) => a.day - b.day || a.period - b.period);
    for (const e of sorted.slice(hours)) drop.set(e.id, subject);
  }
  if (drop.size === 0) return { state, removed: [] };
  const removed = state.entries
    .filter((e) => drop.has(e.id))
    .sort((a, b) => a.day - b.day || a.period - b.period)
    .map((e) => {
      const g = state.groups.find((x) => x.id === e.groupId);
      const s = drop.get(e.id);
      return {
        entryId: e.id, groupId: e.groupId, groupName: g ? g.name : e.groupId,
        subjectId: s.id, subjectCode: s.code, subjectName: s.name, day: e.day, period: e.period,
      };
    });
  return { state: { ...state, entries: state.entries.filter((e) => !drop.has(e.id)) }, removed };
}

const uniqOrdered = (list) => [...new Set(list)];

// ---------- แผนการเรียน ----------
// ผูกวิชาของแผนเข้ากลุ่มเรียน (pure) mode 'replace' | 'merge' ไม่ลบ entry เดิม
// replace: group.subjectIds = วิชาของแผนที่ระดับตรง + วิชาที่กลุ่มมี entry อยู่แต่หลุดจากแผน (คงไว้ + warning)
// merge: เพิ่มเฉพาะวิชาของแผนที่ยังไม่มี
// คืน { ok, state?, errors, added:[subjectId], skipped:[{subjectId,reason,message}], kept:[subjectId], warnings:[string] }
export function applyPlan(state, groupId, planId, { mode = 'replace' } = {}) {
  const fail = (message) => ({ ok: false, errors: [message], added: [], skipped: [], kept: [], warnings: [] });
  const group = state.groups.find((g) => g.id === groupId);
  const plan = state.plans.find((p) => p.id === planId);
  if (!group) return fail('ไม่พบกลุ่มเรียนที่เลือก');
  if (!plan) return fail('ไม่พบแผนการเรียนที่เลือก');
  if (mode !== 'replace' && mode !== 'merge') return fail('mode ต้องเป็น replace หรือ merge');

  const warnings = [];
  const skipped = [];
  const eligible = [];
  if (plan.level !== group.level) {
    warnings.push(`แผนการเรียน ${plan.name} เป็นระดับ ${plan.level} แต่กลุ่มเรียน ${group.name} เป็นระดับ ${group.level}`);
  }
  for (const sid of plan.subjectIds) {
    const s = state.subjects.find((x) => x.id === sid);
    if (!s) {
      skipped.push({ subjectId: sid, reason: 'missing', message: `ไม่พบรายวิชา id "${sid}"` });
    } else if (!s.levels.includes(group.level)) {
      skipped.push({
        subjectId: sid,
        reason: 'level',
        message: `วิชา ${s.code} ${s.name} เปิดสอนระดับ ${s.levels.join(', ')} ไม่รวมระดับ ${group.level} ของกลุ่มเรียน ${group.name}`,
      });
    } else eligible.push(sid);
  }

  const before = group.subjectIds || [];
  let next;
  const kept = [];
  if (mode === 'merge') {
    next = [...before, ...eligible.filter((id) => !before.includes(id))];
  } else {
    next = [...eligible];
    // วิชาที่กลุ่มมี entry อยู่แล้วต้องไม่หลุดจาก subjectIds แม้ไม่อยู่ในแผน (ไม่ลบ entry เดิม)
    const usedIds = uniqOrdered(state.entries.filter((e) => e.groupId === groupId).map((e) => e.subjectId));
    for (const id of usedIds) {
      if (!next.includes(id)) {
        next.push(id);
        kept.push(id);
        const s = state.subjects.find((x) => x.id === id);
        warnings.push(`วิชา ${s ? `${s.code} ${s.name}` : id} ไม่อยู่ในแผน แต่กลุ่มเรียน ${group.name} ลงคาบไว้แล้ว จึงคงไว้ในรายวิชาของกลุ่ม`);
      }
    }
  }
  const added = next.filter((id) => !before.includes(id));
  return {
    ok: true,
    state: { ...state, groups: state.groups.map((g) => (g.id === groupId ? { ...g, subjectIds: next, planId } : g)) },
    errors: [],
    added,
    skipped,
    kept,
    warnings,
  };
}

// นำเข้า JSON (v1-v4): ตรวจโครงสร้าง + validateAll (รวม hours) ถ้าชน/เกินจะไม่ผ่าน
// ตัวเลือก trimOverHours:true = ตัดคาบที่เกิน hours ออกก่อนตรวจ (รายงานใน trimmed)
// คืน { ok, state?, errors:[string], conflicts, migrated?, trimmed:[...] }
export function importJSON(text, { trimOverHours: trim = false } = {}) {
  const r = parseState(text);
  if (!r.ok) return { ok: false, errors: r.errors, conflicts: [], trimmed: [] };
  let state = r.state;
  let trimmed = [];
  if (trim) ({ state, removed: trimmed } = trimOverHours(state));
  const conflicts = validateAll(state);
  if (conflicts.length) {
    return { ok: false, errors: conflicts.map((c) => c.message), conflicts, trimmed };
  }
  return { ok: true, state, errors: [], conflicts: [], migrated: r.migrated, trimmed };
}

export function exportJSON(state) {
  return JSON.stringify(state, null, 2);
}

// ---------- cascade / ข้อมูลกำพร้า (pure: ไม่แก้ state เดิม คืน state ใหม่) ----------

// รายการอ้างอิงที่ชี้ไปหาของที่ไม่มีอยู่แล้ว (ควรเป็น [] เสมอหลังลบ/แก้)
// { kind:'entry'|'subject'|'group'|'plan', id, field, ref }
export function findOrphans(state) {
  const ids = (k) => new Set((state[k] || []).map((x) => x.id));
  const groups = ids('groups');
  const rooms = ids('rooms');
  const teachers = ids('teachers');
  const plans = ids('plans');
  const subjectIds = ids('subjects');
  const subjects = new Map((state.subjects || []).map((s) => [s.id, s]));
  const out = [];
  for (const s of state.subjects || []) {
    for (const t of Array.isArray(s.teacherIds) ? s.teacherIds : []) {
      if (!teachers.has(t)) out.push({ kind: 'subject', id: s.id, field: 'teacherIds', ref: t });
    }
  }
  for (const g of state.groups || []) {
    for (const sid of Array.isArray(g.subjectIds) ? g.subjectIds : []) {
      if (!subjectIds.has(sid)) out.push({ kind: 'group', id: g.id, field: 'subjectIds', ref: sid });
    }
    if (g.planId != null && !plans.has(g.planId)) out.push({ kind: 'group', id: g.id, field: 'planId', ref: g.planId });
  }
  for (const p of state.plans || []) {
    for (const sid of Array.isArray(p.subjectIds) ? p.subjectIds : []) {
      if (!subjectIds.has(sid)) out.push({ kind: 'plan', id: p.id, field: 'subjectIds', ref: sid });
    }
  }
  for (const e of state.entries || []) {
    const subj = subjects.get(e.subjectId);
    if (!groups.has(e.groupId)) out.push({ kind: 'entry', id: e.id, field: 'groupId', ref: e.groupId });
    if (!subj) out.push({ kind: 'entry', id: e.id, field: 'subjectId', ref: e.subjectId });
    if (e.roomId != null && !rooms.has(e.roomId)) out.push({ kind: 'entry', id: e.id, field: 'roomId', ref: e.roomId });
    if (e.teacherId != null && (!teachers.has(e.teacherId) || (subj && !(subj.teacherIds || []).includes(e.teacherId)))) {
      out.push({ kind: 'entry', id: e.id, field: 'teacherId', ref: e.teacherId });
    }
  }
  return out;
}

// ผลลัพธ์ทุก helper: { state, affected:{...จำนวนที่ถูกแก้/ลบ}, orphans:[], conflicts:[] }
const done = (state, affected) => ({ state, affected, orphans: findOrphans(state), conflicts: validateAll(state) });

// ลบครู: ถอดจาก subject.teacherIds ทุกวิชา, entry.teacherId ที่ตรง -> null
export function removeTeacher(state, teacherId) {
  const subjectsUpdated = state.subjects.filter((s) => (s.teacherIds || []).includes(teacherId)).length;
  const entriesCleared = state.entries.filter((e) => e.teacherId === teacherId).length;
  const next = {
    ...state,
    teachers: state.teachers.filter((t) => t.id !== teacherId),
    subjects: state.subjects.map((s) =>
      (s.teacherIds || []).includes(teacherId) ? { ...s, teacherIds: s.teacherIds.filter((t) => t !== teacherId) } : s,
    ),
    entries: state.entries.map((e) => (e.teacherId === teacherId ? { ...e, teacherId: null } : e)),
  };
  return done(next, { subjectsUpdated, entriesCleared });
}

// ลบห้องเรียน: entry ที่ใช้ห้องนั้น -> roomId=null
export function removeRoom(state, roomId) {
  const entriesCleared = state.entries.filter((e) => e.roomId === roomId).length;
  const next = {
    ...state,
    rooms: state.rooms.filter((r) => r.id !== roomId),
    entries: state.entries.map((e) => (e.roomId === roomId ? { ...e, roomId: null } : e)),
  };
  return done(next, { entriesCleared });
}

// ลบกลุ่มเรียน: ลบ entry ของกลุ่มนั้น
export function removeGroup(state, groupId) {
  const entriesRemoved = state.entries.filter((e) => e.groupId === groupId).length;
  const next = {
    ...state,
    groups: state.groups.filter((g) => g.id !== groupId),
    entries: state.entries.filter((e) => e.groupId !== groupId),
  };
  return done(next, { entriesRemoved });
}

// ลบรายวิชา: ลบ entry ของวิชานั้น + ถอดจาก group.subjectIds / plan.subjectIds
export function removeSubject(state, subjectId) {
  const entriesRemoved = state.entries.filter((e) => e.subjectId === subjectId).length;
  const strip = (list) => (Array.isArray(list) && list.includes(subjectId) ? list.filter((s) => s !== subjectId) : list);
  const groupsUpdated = (state.groups || []).filter((g) => Array.isArray(g.subjectIds) && g.subjectIds.includes(subjectId)).length;
  const plansUpdated = (state.plans || []).filter((p) => Array.isArray(p.subjectIds) && p.subjectIds.includes(subjectId)).length;
  const next = {
    ...state,
    subjects: state.subjects.filter((s) => s.id !== subjectId),
    groups: (state.groups || []).map((g) => (g.subjectIds && g.subjectIds.includes(subjectId) ? { ...g, subjectIds: strip(g.subjectIds) } : g)),
    plans: (state.plans || []).map((p) => (p.subjectIds && p.subjectIds.includes(subjectId) ? { ...p, subjectIds: strip(p.subjectIds) } : p)),
    entries: state.entries.filter((e) => e.subjectId !== subjectId),
  };
  return done(next, { entriesRemoved, groupsUpdated, plansUpdated });
}

// ลบแผนการเรียน: group.planId ที่ตรง -> null (คง subjectIds ของกลุ่มไว้)
export function removePlan(state, planId) {
  const groupsUpdated = (state.groups || []).filter((g) => g.planId === planId).length;
  const next = {
    ...state,
    plans: (state.plans || []).filter((p) => p.id !== planId),
    groups: (state.groups || []).map((g) => (g.planId === planId ? { ...g, planId: null } : g)),
  };
  return done(next, { groupsUpdated });
}

// แก้ครูผู้สอนของวิชา: ถ้ามี entry ยังอ้างครูที่ถูกเอาออก -> ไม่ทำ (ok:false) ถ้า clearEntries=true จะตั้ง entry.teacherId=null ให้
// คืน { ok, state, errors:[string], affected:{entriesCleared}, orphans, conflicts }
export function setSubjectTeachers(state, subjectId, teacherIds, { clearEntries = false } = {}) {
  const subject = state.subjects.find((s) => s.id === subjectId);
  if (!subject) return { ok: false, state, errors: ['ไม่พบรายวิชา'], affected: {}, orphans: [], conflicts: [] };
  const known = new Set(state.teachers.map((t) => t.id));
  const list = [...new Set(teacherIds)];
  const bad = list.filter((t) => !known.has(t));
  if (bad.length) {
    return { ok: false, state, errors: [`ไม่พบครู id ${bad.join(', ')}`], affected: {}, orphans: [], conflicts: [] };
  }
  const stale = state.entries.filter((e) => e.subjectId === subjectId && e.teacherId != null && !list.includes(e.teacherId));
  if (stale.length && !clearEntries) {
    return {
      ok: false,
      state,
      errors: [`มี ${stale.length} คาบที่ยังใช้ครูที่ถูกเอาออก ต้องเปลี่ยนครูของคาบเหล่านั้นก่อน`],
      affected: {},
      orphans: [],
      conflicts: [],
    };
  }
  const staleIds = new Set(stale.map((e) => e.id));
  const next = {
    ...state,
    subjects: state.subjects.map((s) => (s.id === subjectId ? { ...s, teacherIds: list } : s)),
    entries: state.entries.map((e) => (staleIds.has(e.id) ? { ...e, teacherId: null } : e)),
  };
  return { ok: true, errors: [], ...done(next, { entriesCleared: stale.length }) };
}
