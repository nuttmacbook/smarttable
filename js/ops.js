// ops engine ร่วมไคลเอนต์/เซิร์ฟเวอร์ — pure ไม่แตะ DOM/storage/network ไม่ mutate input
//   applyOp(state, op) -> { ok:true, state, changes, warnings, remaining } | { ok:false, errors:[{type,message,...}] }
// ทุก op: ตรวจโครงสร้าง (parseState) + validateAll(next) (รวม hours) ก่อนคืน ok
// ข้อมูลเดิมที่ผิดกฎอยู่แล้ว (legacy, เช่น hours เกิน): op ที่เป็น "ซ่อม" (entry.remove/move, *.delete ของกลุ่ม/วิชา, subject.upsert)
// ทำได้ถ้าไม่ทำให้แย่ลงและไม่เกิดรายการผิดใหม่; op อื่นถูกบล็อกจนกว่าข้อมูลจะไม่ผิดกฎ
import { checkPlacement, validateAll } from './scheduler.js';
import {
  parseState, applyPlan, removeTeacher, removeRoom, removeGroup, removeSubject, removePlan, trimOverHours, uid,
} from './store.js';
import { importWorkbook } from './importer.js';
import { isValidId, validateId, sanitizeText, hasUnsafeChars } from './validate.js';

export const OP_TYPES = [
  'subject.upsert', 'subject.delete', 'teacher.upsert', 'teacher.delete', 'group.upsert', 'group.delete',
  'room.upsert', 'room.delete', 'plan.upsert', 'plan.delete', 'group.applyPlan',
  'entry.place', 'entry.move', 'entry.update', 'entry.remove', 'entry.placeMany', 'entry.removeMany', 'state.import',
];

// id ต้องตรง regex และไม่ใช่ชื่อสงวนของ Object.prototype (W-02) — ตัวตรวจอยู่ที่ js/validate.js
export { isValidId };

const COLLECTIONS = ['subjects', 'teachers', 'groups', 'rooms', 'plans', 'entries'];
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const err = (type, message, extra = {}) => ({ type, message, ...extra });
const fail = (...errors) => ({ ok: false, errors });

// ---------- diff ----------
// changes = { subjects:{upsert:[row],remove:[id]}, teachers:..., groups:..., rooms:..., plans:..., entries:... }
export function diffState(before, after) {
  const changes = {};
  for (const k of COLLECTIONS) {
    const a = new Map((before[k] || []).map((r) => [r.id, JSON.stringify(r)]));
    const b = new Map((after[k] || []).map((r) => [r.id, r]));
    const upsert = [];
    for (const [id, row] of b) if (a.get(id) !== JSON.stringify(row)) upsert.push(row);
    const remove = [...a.keys()].filter((id) => !b.has(id));
    changes[k] = { upsert, remove };
  }
  return changes;
}

// สรุปจำนวนรายการที่ op กระทบ ต่อคอลเลกชัน: { subjects:{added,updated,removed}, ..., total:{added,updated,removed} }
// ใช้เขียนข้อความ confirm ก่อน/หลังทำ op ทำลายล้าง (เช่น state.import แบบ replace) — คำนวณจาก before/after เดียวกับที่เซิร์ฟเวอร์ใช้
export function summarizeChanges(before, after) {
  const total = { added: 0, updated: 0, removed: 0 };
  const out = {};
  for (const k of COLLECTIONS) {
    const prev = new Map((before[k] || []).map((r) => [r.id, JSON.stringify(r)]));
    const next = new Map((after[k] || []).map((r) => [r.id, JSON.stringify(r)]));
    let added = 0;
    let updated = 0;
    for (const [id, json] of next) {
      if (!prev.has(id)) added += 1;
      else if (prev.get(id) !== json) updated += 1;
    }
    const removed = [...prev.keys()].filter((id) => !next.has(id)).length;
    out[k] = { added, updated, removed };
    total.added += added;
    total.updated += updated;
    total.removed += removed;
  }
  return { ...out, total };
}

// นำ changes (delta จาก applyOp/เซิร์ฟเวอร์) ไปปรับ state: ลบ id ที่ remove, แทนที่/เพิ่มแถว upsert (pure)
// ใช้ฝั่ง remote เมื่อเซิร์ฟเวอร์ตอบ delta แทน state เต็ม (id ที่เซิร์ฟเวอร์สร้างจึงตรงกันเสมอ)
export function applyChanges(state, changes) {
  const next = { ...state };
  for (const k of COLLECTIONS) {
    const c = changes && changes[k];
    if (!c) continue;
    const drop = new Set(c.remove || []);
    const up = new Map((c.upsert || []).map((r) => [r.id, r]));
    const seen = new Set();
    const list = (state[k] || []).filter((r) => !drop.has(r.id)).map((r) => {
      if (!up.has(r.id)) return r;
      seen.add(r.id);
      return up.get(r.id);
    });
    for (const [id, r] of up) if (!seen.has(id)) list.push(r);
    next[k] = list;
  }
  return next;
}

// ---------- ตรวจผลหลังแก้ ----------
const conflictKey = (c) =>
  c.type === 'hours'
    ? `hours:${c.groupId}|${c.subjectId}`
    : `${c.type}:${[c.entryId, c.otherEntryId].filter(Boolean).sort().join('|')}`;

const REPAIR = new Set(['entry.remove', 'entry.removeMany', 'entry.move', 'group.delete', 'subject.delete', 'subject.upsert']);

function conflictError(c) {
  const e = { type: c.type, message: c.message };
  for (const k of ['entryId', 'otherEntryId', 'groupId', 'subjectId', 'hours', 'used']) if (c[k] !== undefined) e[k] = c[k];
  return e;
}

function finish(before, next, op, { strict = false, trim = false, warnings = [], extra = {} } = {}) {
  const parsed = parseState(next);
  if (!parsed.ok) return fail(...parsed.errors.map((m) => err('invalid', m)));
  let state = parsed.state;
  let trimmed = [];
  if (trim) ({ state, removed: trimmed } = trimOverHours(state));

  const conflicts = validateAll(state);
  if (conflicts.length) {
    const repair = !strict && REPAIR.has(op.type);
    const beforeMap = new Map(validateAll(before).map((c) => [conflictKey(c), c]));
    const old = [];
    const fresh = [];
    for (const c of conflicts) {
      const prev = beforeMap.get(conflictKey(c));
      if (prev && !strict && !(c.type === 'hours' && c.used > prev.used)) old.push(c);
      else fresh.push(c);
    }
    if (fresh.length > 0) return fail(...fresh.map(conflictError));
    if (!repair) {
      return fail(
        err('legacy', `ข้อมูลเดิมมี ${old.length} รายการที่ผิดกฎ (เช่น เกินชั่วโมง/ชน) ต้องแก้ก่อนจึงจะทำรายการนี้ได้`),
        ...old.map(conflictError),
      );
    }
  }
  return {
    ok: true,
    state,
    changes: diffState(before, state),
    affected: summarizeChanges(before, state),
    warnings,
    remaining: conflicts.map(conflictError),
    ...(trimmed.length ? { trimmed } : {}),
    ...extra,
  };
}

// ---------- upsert / delete ----------
const FIELDS = {
  subjects: ['id', 'code', 'name', 'type', 'credits', 'hours', 'theory', 'practice', 'teacherIds', 'levels', 'note'],
  teachers: ['id', 'name', 'dept'],
  groups: ['id', 'name', 'level', 'major', 'subjectIds', 'planId'],
  rooms: ['id', 'name', 'building', 'capacity', 'note'],
  plans: ['id', 'name', 'level', 'subjectIds', 'note'],
  entries: ['id', 'groupId', 'day', 'period', 'subjectId', 'roomId', 'teacherId'],
};
const DEFAULTS = {
  subjects: () => ({ credits: 0, teacherIds: [], note: '' }),
  teachers: () => ({ dept: '' }),
  groups: () => ({ major: '', subjectIds: [], planId: null }),
  rooms: () => ({ building: '', note: '' }),
  plans: () => ({ subjectIds: [], note: '' }),
};
const TEXT_FIELDS = ['code', 'name', 'dept', 'major', 'building', 'note'];

// ทำความสะอาดข้อความ (ตัดอักขระควบคุม/กำกับทิศทาง/zero-width, NFC, trim) เฉพาะฟิลด์ข้อความ
// notes (array) รับข้อความเตือนเมื่อมีการตัดอักขระออก เพื่อให้ผู้ใช้รู้ว่าค่าถูกแก้
const pickRow = (key, row, notes = []) => {
  const picked = {};
  for (const f of FIELDS[key]) {
    if (!has(row, f)) continue;
    const isText = typeof row[f] === 'string' && TEXT_FIELDS.includes(f);
    picked[f] = isText ? sanitizeText(row[f], { max: 100000, multiline: f === 'note' }) : row[f];
    if (isText && hasUnsafeChars(row[f])) notes.push(`ตัดอักขระควบคุม/กำกับทิศทาง/zero-width ออกจากฟิลด์ ${f} (id ${row.id})`);
  }
  return picked;
};

function upsert(state, key, row, op) {
  if (!isObj(row)) return fail(err('invalid', 'ต้องส่งข้อมูลรายการ (object)'));
  const idCheck = validateId(row.id);
  if (!idCheck.ok) return fail(err('invalid', idCheck.message, { field: 'id' }));
  const list = state[key];
  const existing = list.find((r) => r.id === row.id);
  const notes = [];
  const picked = pickRow(key, row, notes);
  const merged = existing ? { ...existing, ...picked } : { ...DEFAULTS[key](), ...picked };
  if (key === 'groups') {
    const n = typeof merged.name === 'string' ? merged.name.trim() : '';
    if (n && list.some((g) => g.id !== merged.id && typeof g.name === 'string' && g.name.trim() === n)) {
      return fail(err('duplicate', `ชื่อกลุ่มเรียน "${n}" ซ้ำกับกลุ่มที่มีอยู่`, { field: 'name' }));
    }
  }
  const nextList = existing ? list.map((r) => (r.id === row.id ? merged : r)) : [...list, merged];
  return finish(state, { ...state, [key]: nextList }, op, { warnings: notes });
}

const needId = (op, field = 'id') => (isValidId(op[field]) ? null : fail(err('invalid', `ต้องระบุ ${field} ให้ถูกต้อง`, { field })));
const exists = (list, id, label) => (list.some((r) => r.id === id) ? null : fail(err('notfound', `ไม่พบ${label}`, { id })));

// ---------- entry ops ----------
function entryPlacement(state, op, base, ignoreEntryId) {
  const r = checkPlacement(state, { ...base, ignoreEntryId });
  // move/update ไม่เปลี่ยนจำนวนคาบ จึงไม่ต้องตรวจ hours ซ้ำ (กันเคส legacy ที่เกินอยู่เดิม ย้ายไม่ได้)
  const conflicts = ignoreEntryId ? r.conflicts.filter((c) => c.type !== 'hours') : r.conflicts;
  return { conflicts, warnings: r.warnings };
}

// สร้าง entry จากรายการลงคาบเดียว (ใช้ร่วม entry.place และ entry.placeMany) → { entry, warnings } | { errors:[...] }
function buildEntry(state, item) {
  // day/period ปล่อยให้ checkPlacement ตัดสิน (รวมพักเที่ยง 'lunch' → type 'lunch', ค่าแปลก → 'invalid')
  if (!isObj(item) || !isValidId(item.groupId) || item.day === undefined || item.period === undefined || !isValidId(item.subjectId)) {
    return { errors: [err('invalid', 'ต้องระบุ groupId, day, period, subjectId ให้ถูกต้อง')] };
  }
  if (item.id !== undefined) {
    const idCheck = validateId(item.id);
    if (!idCheck.ok) return { errors: [err('invalid_id', idCheck.message, { field: 'id' })] };
  }
  const roomId = item.roomId ?? null;
  const teacherId = item.teacherId ?? null;
  const r = entryPlacement(state, item, { groupId: item.groupId, day: item.day, period: item.period, subjectId: item.subjectId, roomId, teacherId }, null);
  if (r.conflicts.length) return { errors: r.conflicts.map(conflictError) };
  const entry = { id: item.id ?? uid('e'), groupId: item.groupId, day: item.day, period: item.period, subjectId: item.subjectId, roomId, teacherId };
  if (state.entries.some((e) => e.id === entry.id)) return { errors: [err('duplicate', `id "${entry.id}" ซ้ำ`, { field: 'id' })] };
  return { entry, warnings: r.warnings };
}

function entryPlace(state, op) {
  const b = buildEntry(state, op);
  if (b.errors) return fail(...b.errors);
  return finish(state, { ...state, entries: [...state.entries, b.entry] }, op, { warnings: b.warnings });
}

// ---------- ลงหลายช่อง / ลบหลายช่อง (SPEC v5 §15.2) ----------
export const MAX_BATCH = 200;
const BATCH_POLICIES = ['all', 'valid'];
const sortKey = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.POSITIVE_INFINITY);

// entry.placeMany { items:[{groupId,day,period,subjectId,roomId?,teacherId?,id?}...≤200], policy:'all'|'valid', dryRun? }
// ประมวลผลตามลำดับ (day, period) จากน้อยไปมาก (เสมอกัน = ตามลำดับในชุด) แต่ละรายการตรวจกับ state + รายการก่อนหน้าที่ผ่านในชุด
// ผล: items:[{index,day,period,ok,id?,errors?}] (เรียงตาม index เดิม), placed:[{index,day,period,id}], rejected:[{index,day,period,errors}]
//  policy 'all' มีรายการไม่ผ่าน → ok:false ไม่เปลี่ยนอะไร (errors แบนมี index/day/period) · policy 'valid' ไม่มีรายการผ่านเลย → ok:false
//  dryRun:true → ไม่เปลี่ยน state: ok:true พร้อมรายงานรายช่อง + wouldSucceed (ตามความหมายของ policy) เว้นแต่โครงคำขอผิด
function placeMany(state, op) {
  if (!Array.isArray(op.items) || op.items.length === 0) return fail(err('invalid', 'entry.placeMany ต้องมี items อย่างน้อย 1 รายการ', { field: 'items' }));
  if (op.items.length > MAX_BATCH) return fail(err('invalid', `ลงได้ไม่เกิน ${MAX_BATCH} ช่องต่อครั้ง (ส่งมา ${op.items.length})`, { field: 'items' }));
  const policy = op.policy ?? 'all';
  if (!BATCH_POLICIES.includes(policy)) return fail(err('invalid', "policy ต้องเป็น 'all' หรือ 'valid'", { field: 'policy' }));
  if (op.dryRun !== undefined && typeof op.dryRun !== 'boolean') return fail(err('invalid', 'dryRun ต้องเป็น true/false', { field: 'dryRun' }));

  const order = op.items.map((it, index) => ({ it, index }))
    .sort((a, b) => sortKey(a.it?.day) - sortKey(b.it?.day) || sortKey(a.it?.period) - sortKey(b.it?.period) || a.index - b.index);

  let cur = state;
  const seen = new Set();
  const usedIds = new Set(state.entries.map((e) => e.id));
  const items = new Array(op.items.length);
  const placed = [];
  const rejected = [];
  const warnings = [];
  for (const { it, index } of order) {
    const day = isObj(it) ? it.day : undefined;
    const period = isObj(it) ? it.period : undefined;
    const reject = (errors) => {
      items[index] = { index, day, period, ok: false, errors };
      rejected.push({ index, day, period, errors });
    };
    const slot = isObj(it) ? `${it.groupId}\u0000${day}\u0000${period}` : null;
    if (slot !== null && seen.has(slot)) {
      reject([err('duplicate_slot', 'ช่องซ้ำในชุด (กลุ่มเรียน วัน คาบ เดียวกับรายการก่อนหน้า)')]);
      continue;
    }
    if (slot !== null) seen.add(slot);
    if (isObj(it) && it.id !== undefined && usedIds.has(it.id)) {
      reject([err('duplicate', `id "${it.id}" ซ้ำ`, { field: 'id' })]);
      continue;
    }
    const b = buildEntry(cur, it);
    if (b.errors) {
      reject(b.errors);
      continue;
    }
    cur = { ...cur, entries: [...cur.entries, b.entry] };
    usedIds.add(b.entry.id);
    items[index] = { index, day, period, ok: true, id: b.entry.id };
    placed.push({ index, day, period, id: b.entry.id });
    for (const w of b.warnings) if (!warnings.includes(w)) warnings.push(w);
  }
  placed.sort((a, b) => a.index - b.index);
  rejected.sort((a, b) => a.index - b.index);
  const flat = rejected.flatMap((r) => r.errors.map((e) => ({ ...e, index: r.index, day: r.day, period: r.period })));
  const wouldSucceed = policy === 'all' ? rejected.length === 0 : placed.length > 0;
  // สรุปสำเร็จรูปให้ UI (ปุ่ม "ลงเฉพาะช่องที่ลงได้ (K จาก N)" / ข้อความ) — placeable นับตามการจำลอง แม้ policy 'all' ล้ม
  const summary = { placeable: placed.length, total: op.items.length, rejected: rejected.length };

  if (op.dryRun === true) {
    // ตรวจโครงสร้างของผลรวมด้วย (ถ้าผ่านทุกช่องแต่ผลรวมผิดกฎ/ข้อมูลเดิมผิดกฎ จะรายงานใน errors ด้วย) แต่ไม่คืน state ใหม่
    let combined = wouldSucceed ? finish(state, cur, op, { warnings }) : null;
    const ok = wouldSucceed && combined.ok;
    return {
      ok: true,
      dryRun: true,
      wouldSucceed: ok,
      summary,
      state,
      changes: diffState(state, state),
      affected: ok ? combined.affected : summarizeChanges(state, state),
      warnings,
      remaining: ok ? combined.remaining : [],
      items,
      placed,
      rejected,
      ...(wouldSucceed && !combined.ok ? { errors: combined.errors } : {}),
    };
  }
  if (!wouldSucceed) return { ok: false, errors: flat.length ? flat : [err('invalid', 'ไม่มีรายการใดลงได้')], items, placed: [], rejected, summary };
  const done = finish(state, cur, op, { warnings, extra: { items, placed, rejected, summary } });
  return done.ok ? done : { ...done, items, summary };
}

// entry.removeMany { entryIds:[...≤200], dryRun? } — atomic: id ไม่พบ = ล้มทั้งชุด (errors มี index/id); id ซ้ำในชุดนับเป็นรายการเดียว
function removeMany(state, op) {
  if (!Array.isArray(op.entryIds) || op.entryIds.length === 0) return fail(err('invalid', 'entry.removeMany ต้องมี entryIds อย่างน้อย 1 รายการ', { field: 'entryIds' }));
  if (op.entryIds.length > MAX_BATCH) return fail(err('invalid', `ลบได้ไม่เกิน ${MAX_BATCH} ช่องต่อครั้ง (ส่งมา ${op.entryIds.length})`, { field: 'entryIds' }));
  if (op.dryRun !== undefined && typeof op.dryRun !== 'boolean') return fail(err('invalid', 'dryRun ต้องเป็น true/false', { field: 'dryRun' }));
  const known = new Set(state.entries.map((e) => e.id));
  const errors = [];
  op.entryIds.forEach((id, index) => {
    if (!isValidId(id)) errors.push(err('invalid', 'entryId ไม่ถูกต้อง', { index, field: 'entryIds' }));
    else if (!known.has(id)) errors.push(err('notfound', 'ไม่พบคาบที่เลือก', { index, id }));
  });
  if (errors.length) return fail(...errors);
  const drop = new Set(op.entryIds);
  const next = { ...state, entries: state.entries.filter((e) => !drop.has(e.id)) };
  const r = finish(state, next, op, { extra: { removed: drop.size } });
  if (op.dryRun === true) {
    return r.ok
      ? { ...r, dryRun: true, wouldSucceed: true, state, changes: diffState(state, state) }
      : { ok: true, dryRun: true, wouldSucceed: false, state, errors: r.errors, removed: drop.size, affected: summarizeChanges(state, state) };
  }
  return r;
}

function entryChange(state, op, move) {
  if (!isObj(op) || !isValidId(op.entryId)) return fail(err('invalid', 'ต้องระบุ entryId ให้ถูกต้อง', { field: 'entryId' }));
  const entry = state.entries.find((e) => e.id === op.entryId);
  if (!entry) return fail(err('notfound', 'ไม่พบคาบที่เลือก', { id: op.entryId }));
  if (move && (op.day === undefined || op.period === undefined)) return fail(err('invalid', 'entry.move ต้องระบุ day และ period'));
  const patch = {
    day: move ? op.day : entry.day,
    period: move ? op.period : entry.period,
    roomId: has(op, 'roomId') ? op.roomId ?? null : entry.roomId ?? null,
    teacherId: has(op, 'teacherId') ? op.teacherId ?? null : entry.teacherId ?? null,
  };
  const r = entryPlacement(state, op, { groupId: entry.groupId, subjectId: entry.subjectId, ...patch }, entry.id);
  if (r.conflicts.length) return fail(...r.conflicts.map(conflictError));
  const updated = { ...entry, ...patch };
  return finish(state, { ...state, entries: state.entries.map((e) => (e.id === entry.id ? updated : e)) }, op, { warnings: r.warnings });
}

// ---------- state.import ----------
function importOp(state, op) {
  const trim = op.trimOverHours === true;
  if (isObj(op.rows) || (op.rows && typeof op.rows === 'object')) {
    const rep = importWorkbook(state, op.rows, { trimOverHours: trim });
    if (!rep.ok) {
      return fail(...rep.report.rows.filter((r) => r.level === 'error').map((r) =>
        err('import', r.message, { sheet: r.sheet, row: r.row, ...(r.column ? { column: r.column } : {}) })));
    }
    const parsed = parseState(rep.state);
    if (!parsed.ok) return fail(...parsed.errors.map((m) => err('invalid', m)));
    return finish(state, parsed.state, op, { strict: true, extra: { report: rep.report } });
  }
  let next;
  const patchNotes = [];
  if (op.state !== undefined) {
    const parsed = parseState(op.state);
    if (!parsed.ok) return fail(...parsed.errors.map((m) => err('invalid', m)));
    next = parsed.state;
    if (op.mode !== undefined && op.mode !== 'replace') return fail(err('invalid', 'state.import ที่ส่ง state ต้องใช้ mode replace'));
  } else if (isObj(op.patch)) {
    if (op.mode !== undefined && op.mode !== 'merge') return fail(err('invalid', 'state.import ที่ส่ง patch ต้องใช้ mode merge'));
    next = { ...state };
    for (const k of COLLECTIONS) {
      if (op.patch[k] === undefined) continue;
      if (!Array.isArray(op.patch[k])) return fail(err('invalid', `patch.${k} ต้องเป็นรายการ`));
      let list = next[k];
      for (const row of op.patch[k]) {
        if (!isObj(row) || !isValidId(row.id)) return fail(err('invalid', `patch.${k}: มีรายการที่ id ไม่ถูกต้อง`));
        const picked = pickRow(k, row, patchNotes); // เฉพาะฟิลด์ที่รู้จัก (ตัดคีย์แปลก เช่น __proto__) + ทำความสะอาดข้อความ
        const exists = list.some((r) => r.id === row.id);
        list = exists
          ? list.map((r) => (r.id === row.id ? { ...r, ...picked } : r))
          : [...list, { ...(DEFAULTS[k] ? DEFAULTS[k]() : {}), ...picked }];
      }
      next[k] = list;
    }
  } else {
    return fail(err('invalid', 'state.import ต้องระบุ state, patch หรือ rows อย่างใดอย่างหนึ่ง'));
  }
  for (const k of COLLECTIONS) {
    const bad = next[k].find((r) => !isValidId(r.id));
    if (bad) return fail(err('invalid', `${k}: id "${bad.id}" ไม่อยู่ในรูปแบบที่อนุญาต (A-Z a-z 0-9 _ - ยาว 1-64)`));
  }
  return finish(state, next, op, { strict: true, trim, warnings: patchNotes });
}

// ---------- applyOp ----------
export function applyOp(state, op) {
  if (!isObj(op) || typeof op.type !== 'string') return fail(err('unknown_op', 'op ไม่ถูกต้อง (ต้องมี type)'));
  if (!isObj(state) || state.version === undefined) return fail(err('invalid', 'state ไม่ถูกต้อง'));
  let bad;
  switch (op.type) {
    case 'subject.upsert': return upsert(state, 'subjects', op.subject, op);
    case 'teacher.upsert': return upsert(state, 'teachers', op.teacher, op);
    case 'group.upsert': return upsert(state, 'groups', op.group, op);
    case 'room.upsert': return upsert(state, 'rooms', op.room, op);
    case 'plan.upsert': return upsert(state, 'plans', op.plan, op);
    case 'subject.delete': bad = needId(op) || exists(state.subjects, op.id, 'รายวิชา'); return bad || finish(state, removeSubject(state, op.id).state, op);
    case 'teacher.delete': bad = needId(op) || exists(state.teachers, op.id, 'ครู'); return bad || finish(state, removeTeacher(state, op.id).state, op);
    case 'group.delete': bad = needId(op) || exists(state.groups, op.id, 'กลุ่มเรียน'); return bad || finish(state, removeGroup(state, op.id).state, op);
    case 'room.delete': bad = needId(op) || exists(state.rooms, op.id, 'ห้องเรียน'); return bad || finish(state, removeRoom(state, op.id).state, op);
    case 'plan.delete': bad = needId(op) || exists(state.plans, op.id, 'แผนการเรียน'); return bad || finish(state, removePlan(state, op.id).state, op);
    case 'group.applyPlan': {
      bad = needId(op, 'groupId') || needId(op, 'planId');
      if (bad) return bad;
      const r = applyPlan(state, op.groupId, op.planId, { mode: op.mode ?? 'replace' });
      if (!r.ok) return fail(...r.errors.map((m) => err('invalid', m)));
      return finish(state, r.state, op, {
        warnings: r.warnings,
        extra: { plan: { added: r.added, skipped: r.skipped, kept: r.kept } },
      });
    }
    case 'entry.place': return entryPlace(state, op);
    case 'entry.placeMany': return placeMany(state, op);
    case 'entry.removeMany': return removeMany(state, op);
    case 'entry.move': return entryChange(state, op, true);
    case 'entry.update': return entryChange(state, op, false);
    case 'entry.remove': {
      bad = needId(op, 'entryId') || exists(state.entries, op.entryId, 'คาบที่เลือก');
      return bad || finish(state, { ...state, entries: state.entries.filter((e) => e.id !== op.entryId) }, op);
    }
    case 'state.import': return importOp(state, op);
    default: return fail(err('unknown_op', `ไม่รู้จัก op "${op.type}"`));
  }
}
