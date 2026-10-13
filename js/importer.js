// นำเข้าจาก Excel (rows ต่อชีต) — pure ไม่อ่านไฟล์ ไม่แตะ DOM (ตัวอ่าน .xlsx เป็นของ UI ส่ง rows เข้ามา)
//   importRows(state, sheets, { trimOverHours?, idGen? }) -> { ok, state|null, report }
//   report = ImportReport { rows:[{sheet,row,column?,level:'error'|'warning'|'info',message}],
//                           summary:{ [ชื่อชีต]: {add,update,skip} }, ok, trimmed:[...] }
// sheets: { 'รายวิชา': rows, ... } หรือ [{ sheet|name, data|rows }] (รูปแบบของ read-excel-file)
//   rows = array ของแถว: แถวแรกคือหัวคอลัมน์ (array ของเซลล์) หรือ array ของ object ที่คีย์คือหัวคอลัมน์
// กฎรวม (merge): จับคู่ด้วยคีย์ ตรง = อัปเดตเฉพาะฟิลด์ที่กรอก (ว่าง = ไม่ทับ) ไม่ตรง = เพิ่มใหม่ ไม่ลบอะไร
// atomic: มี error อย่างน้อย 1 รายการ → ok:false, state:null (ไม่มีอะไรเปลี่ยน)
import { validateAll } from './scheduler.js';
import { parseState, trimOverHours, uid, deriveLevels } from './store.js';
import { sanitizeText, hasUnsafeChars } from './validate.js';

// Map (ไม่ใช้ object ธรรมดา) กันค่าอย่าง __proto__/constructor ในเซลล์ประเภท (W-02)
const TYPE_BY_TEXT = new Map([
  ['สามัญ', 'general'], ['วิชาชีพ', 'vocational'], ['general', 'general'], ['vocational', 'vocational'],
]);

// ตัวเลือกนำเข้า "ตัดคาบส่วนเกิน" ใช้ trimOverHours(state) -> { state, removed } (นิยามใน store.js)
export { trimOverHours };

export const IMPORT_SHEETS = {
  subjects: 'รายวิชา',
  teachers: 'ครูผู้สอน',
  rooms: 'ห้องเรียน',
  groups: 'กลุ่มเรียน',
  plans: 'แผนการเรียน',
};
export const IMPORT_LIMITS = { maxBytes: 5 * 1024 * 1024, maxRows: 5000 };
const OVERALL = 'ภาพรวม';

// คอลัมน์ต่อชีต: ชื่อหัว (ไม่รวม *) และว่าจำเป็นหรือไม่ (จำเป็นสำหรับแถวที่เพิ่มใหม่; ยกเว้นคีย์ที่จำเป็นเสมอ)
export const IMPORT_COLUMNS = {
  'รายวิชา': ['รหัสวิชา', 'ชื่อวิชา', 'ประเภท', 'ท', 'ป', 'ชม./สัปดาห์', 'หน่วยกิต', 'ระดับที่เปิดสอน', 'ครูผู้สอน', 'หมายเหตุ'],
  'ครูผู้สอน': ['ชื่อครู', 'แผนก/สาขา'],
  'ห้องเรียน': ['ชื่อห้องเรียน', 'อาคาร', 'ความจุ', 'หมายเหตุ'],
  'กลุ่มเรียน': ['ชื่อกลุ่มเรียน', 'ระดับ', 'สาขา', 'แผนการเรียน', 'รหัสวิชา'],
  'แผนการเรียน': ['ชื่อแผน', 'ระดับ', 'รหัสวิชา', 'หมายเหตุ'],
};
// คอลัมน์ที่ต้องมีหัวในไฟล์ (คีย์ + ฟิลด์จำเป็นของแถวใหม่)
const REQUIRED_HEADERS = {
  'รายวิชา': ['รหัสวิชา', 'ชื่อวิชา', 'ประเภท', 'ระดับที่เปิดสอน'],
  'ครูผู้สอน': ['ชื่อครู'],
  'ห้องเรียน': ['ชื่อห้องเรียน'],
  'กลุ่มเรียน': ['ชื่อกลุ่มเรียน', 'ระดับ'],
  'แผนการเรียน': ['ชื่อแผน', 'ระดับ', 'รหัสวิชา'],
};

// ตรวจไฟล์ก่อนอ่าน (ขนาด ≤ 5 MB, นามสกุล .xlsx, magic bytes zip 'PK') คืน { ok, message? }
export function checkXlsxFile(file) {
  const { name, size, bytes } = file ?? {};
  if (typeof name !== 'string' || !/\.xlsx$/i.test(name.trim())) {
    return { ok: false, message: 'รองรับเฉพาะไฟล์ .xlsx เท่านั้น' };
  }
  if (!Number.isFinite(size) || size <= 0) return { ok: false, message: 'ไฟล์ว่างหรืออ่านขนาดไม่ได้' };
  if (size > IMPORT_LIMITS.maxBytes) return { ok: false, message: 'ไฟล์ใหญ่เกิน 5 MB' };
  if (bytes && !(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return { ok: false, message: 'ไฟล์ไม่ใช่ Excel (.xlsx) ที่ถูกต้อง' };
  }
  return { ok: true };
}

const norm = (s) => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
// เซลล์ → ข้อความที่ทำความสะอาดแล้ว (ตัดอักขระควบคุม/กำกับทิศทาง/zero-width, NFC, trim) — W-10
const cellStr = (v) => {
  if (v === null || v === undefined || v instanceof Date) return '';
  return sanitizeText(typeof v === 'string' ? v : String(v), { max: Infinity });
};
const CELL_MAX = 500;
const NAME_MAX = 200; // ชื่อ/รหัส (ตรงกับ parseState) — รายงานที่แถวจริง ไม่รอไปเจอที่ภาพรวม
const NAME_COLUMNS = new Set(['รหัสวิชา', 'ชื่อวิชา', 'ชื่อครู', 'ชื่อห้องเรียน', 'ชื่อกลุ่มเรียน', 'ชื่อแผน']);
const splitList = (s) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const uniq = (list) => [...new Set(list)];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');
const clone = (x) => JSON.parse(JSON.stringify(x));

export function importRows(state, sheets, { trimOverHours: trim = false, idGen = uid } = {}) {
  const report = { rows: [], summary: {}, ok: false, trimmed: [] };
  const add = (sheet, row, level, message, column) =>
    report.rows.push({ sheet, row, ...(column ? { column } : {}), level, message });
  const hasError = () => report.rows.some((r) => r.level === 'error');
  const finish = (ok, next) => {
    report.ok = ok && !hasError();
    return { ok: report.ok, state: report.ok ? next : null, report };
  };

  // ---- รวบรวมชีต ----
  const named = new Map();
  if (Array.isArray(sheets)) {
    for (const s of sheets) if (s && typeof s === 'object') named.set(norm(s.sheet ?? s.name), s.data ?? s.rows);
  } else if (sheets && typeof sheets === 'object') {
    for (const [k, v] of Object.entries(sheets)) named.set(norm(k), v);
  } else {
    add(OVERALL, 0, 'error', 'ไม่พบข้อมูลที่จะนำเข้า');
    return finish(false, null);
  }
  const known = Object.values(IMPORT_SHEETS);
  for (const k of named.keys()) if (!known.includes(k)) add(k, 0, 'info', `ข้ามชีต "${k}" (ไม่ใช่ชีตที่ระบบรู้จัก)`);
  if (!known.some((k) => named.has(k))) {
    add(OVERALL, 0, 'error', `ไม่พบชีตที่ระบบรู้จักในไฟล์ (ต้องมีอย่างน้อย 1 ชีตจาก: ${known.join(', ')})`);
    return finish(false, null);
  }

  const work = clone({
    subjects: state.subjects, teachers: state.teachers, groups: state.groups, rooms: state.rooms,
    plans: state.plans || [], entries: state.entries,
  });
  work.version = state.version;
  // ระดับอ่านจาก state.levels เสมอ (แอดมินกำหนด) — นำเข้าไฟล์ที่มีระดับใหม่ = error ชัดเจน ไม่สร้างระดับเงียบ ๆ
  const levelNames = Array.isArray(state.levels) ? state.levels.filter((n) => typeof n === 'string') : deriveLevels(state);
  work.levels = [...levelNames];
  const levelSet = new Set(levelNames);
  const unknownLevelMsg = (l) =>
    `ระดับ "${l}" ไม่มีในรายการระดับของระบบ (ต้องเป็น ${levelNames.join(', ') || '(ยังไม่มีระดับ)'}) — เพิ่มระดับใหม่ที่หน้า "ระดับ" ก่อนแล้วนำเข้าอีกครั้ง`;

  // ---- อ่านชีตเป็นแถวที่มีชื่อคอลัมน์ ----
  function readSheet(name) {
    const raw = named.get(name);
    if (raw === undefined) return null;
    if (!Array.isArray(raw)) {
      add(name, 1, 'error', 'รูปแบบข้อมูลของชีตไม่ถูกต้อง');
      return null;
    }
    const summary = { add: 0, update: 0, skip: 0 };
    report.summary[name] = summary;
    if (raw.length === 0) return { rows: [], summary };
    let header;
    let body;
    if (Array.isArray(raw[0])) {
      header = raw[0].map(norm);
      body = raw.slice(1).map((cells, i) => ({
        rowNo: i + 2,
        raw: (c) => cells[header.indexOf(c)],
        get: (c) => cellStr(cells[header.indexOf(c)]),
      }));
    } else {
      // แถวเป็น object (สัญญา SPEC §14.1): คีย์ = หัวคอลัมน์, __row = เลขแถว Excel (ไม่มี = ลำดับ+2)
      header = uniq(raw.flatMap((o) => Object.keys(o || {}).filter((k) => k !== '__row').map(norm)));
      body = raw.map((o, i) => ({
        rowNo: Number.isInteger(o?.__row) && o.__row > 0 ? o.__row : i + 2,
        raw: (c) => {
          const key = Object.keys(o || {}).find((k) => k !== '__row' && norm(k) === c);
          return key === undefined || !Object.hasOwn(o, key) ? undefined : o[key];
        },
        get: (c) => {
          const key = Object.keys(o || {}).find((k) => k !== '__row' && norm(k) === c);
          return key === undefined ? '' : cellStr(Object.hasOwn(o, key) ? o[key] : undefined);
        },
      }));
    }
    if (body.length > IMPORT_LIMITS.maxRows) {
      add(name, 0, 'error', `ชีต "${name}" มี ${body.length} แถว เกินที่รองรับ ${IMPORT_LIMITS.maxRows} แถว`);
      return null;
    }
    const dup = header.find((h, i) => h && header.indexOf(h) !== i);
    if (dup) add(name, 1, 'error', `หัวคอลัมน์ "${dup}" ซ้ำ`, dup);
    for (const need of REQUIRED_HEADERS[name]) {
      if (!header.includes(need)) add(name, 1, 'error', `ไม่พบคอลัมน์ "${need}" ในชีต "${name}"`, need);
    }
    for (const h of header) {
      if (h && !IMPORT_COLUMNS[name].includes(h)) add(name, 1, 'info', `ข้ามคอลัมน์ "${h}" (ไม่รู้จัก)`, h);
    }
    const rows = body.filter((r) => IMPORT_COLUMNS[name].some((c) => r.get(c) !== ''));
    for (const r of rows) {
      for (const c of IMPORT_COLUMNS[name]) {
        const text = r.get(c);
        if (text.length > CELL_MAX) add(name, r.rowNo, 'error', `"${c}" ยาวเกิน ${CELL_MAX} ตัวอักษร`, c);
        else if (NAME_COLUMNS.has(c) && text.length > NAME_MAX) add(name, r.rowNo, 'error', `"${c}" ยาวเกิน ${NAME_MAX} ตัวอักษร`, c);
        if (hasUnsafeChars(r.raw(c))) add(name, r.rowNo, 'warning', `ตัดอักขระควบคุม/กำกับทิศทาง/zero-width ออกจาก "${c}"`, c);
      }
    }
    return { rows, summary, headerOk: REQUIRED_HEADERS[name].every((h) => header.includes(h)), has: (c) => header.includes(c) };
  }

  const intCell = (sheet, rowNo, column, text, min = 0) => {
    if (text === '') return null;
    if (!/^\d+(\.0+)?$/.test(text)) {
      add(sheet, rowNo, 'error', `"${column}" ต้องเป็นจำนวนเต็ม ${min === 0 ? '≥ 0' : `≥ ${min}`} (พบ "${text}")`, column);
      return undefined;
    }
    const n = Number(text);
    if (n < min) {
      add(sheet, rowNo, 'error', `"${column}" ต้องเป็นจำนวนเต็ม ≥ ${min} (พบ "${text}")`, column);
      return undefined;
    }
    return n;
  };
  // เทียบคีย์ชื่อหลัง NFC/ตัดอักขระควบคุมทั้งสองฝั่ง (W-10)
  const lookup = (list, name) => list.filter((x) => typeof x.name === 'string' && sanitizeText(x.name, { max: Infinity }) === name);

  // ใช้ค่าที่กรอก (ไม่ว่าง) ทับของเดิม แจ้ง warning เมื่อทับค่าที่มีอยู่และต่างกัน
  function merge(sheet, rowNo, existing, changes, labels, show = {}) {
    let changed = false;
    const next = { ...existing };
    for (const [field, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      if (same(existing[field], value)) continue;
      changed = true;
      if (nonEmpty(existing[field])) {
        const f = show[field] || ((v) => (Array.isArray(v) ? v.join(', ') : String(v)));
        add(sheet, rowNo, 'warning', `อัปเดตทับค่าเดิม: ${labels[field]} "${f(existing[field])}" → "${f(value)}"`, labels[field]);
      }
      next[field] = value;
    }
    return { next, changed };
  }
  const commit = (list, existing, next, summary, changed) => {
    if (!changed) { summary.skip += 1; return; }
    list[list.indexOf(existing)] = next;
    summary.update += 1;
  };
  const dupKey = (seen, sheet, rowNo, column, key) => {
    if (seen.has(key)) {
      add(sheet, rowNo, 'error', `${column} "${key}" ซ้ำในไฟล์ (ซ้ำกับแถว ${seen.get(key)})`, column);
      return true;
    }
    seen.set(key, rowNo);
    return false;
  };
  const ambiguous = (sheet, rowNo, column, list, name, what) => {
    if (list.length > 1) add(sheet, rowNo, 'warning', `มี${what}ชื่อ "${name}" ซ้ำ ${list.length} รายการในระบบ ใช้รายการแรก`, column);
  };

  // ---- ครูผู้สอน ----
  {
    const S = IMPORT_SHEETS.teachers;
    const sh = readSheet(S);
    if (sh && sh.headerOk) {
      const seen = new Map();
      for (const r of sh.rows) {
        const name = r.get('ชื่อครู');
        if (!name) { add(S, r.rowNo, 'error', 'ต้องระบุ "ชื่อครู"', 'ชื่อครู'); continue; }
        if (seen.has(name)) {
          add(S, r.rowNo, 'warning', `ชื่อครู "${name}" ซ้ำในไฟล์ (ซ้ำกับแถว ${seen.get(name)}) ข้ามแถวนี้`, 'ชื่อครู');
          sh.summary.skip += 1;
          continue;
        }
        seen.set(name, r.rowNo);
        const found = lookup(work.teachers, name);
        ambiguous(S, r.rowNo, 'ชื่อครู', found, name, 'ครู');
        const dept = r.get('แผนก/สาขา');
        if (found.length) {
          const { next, changed } = merge(S, r.rowNo, found[0], { dept: dept || undefined }, { dept: 'แผนก/สาขา' });
          commit(work.teachers, found[0], next, sh.summary, changed);
        } else {
          work.teachers.push({ id: idGen('t'), name, dept });
          sh.summary.add += 1;
        }
      }
    }
  }

  // ---- ห้องเรียน ----
  {
    const S = IMPORT_SHEETS.rooms;
    const sh = readSheet(S);
    if (sh && sh.headerOk) {
      const seen = new Map();
      for (const r of sh.rows) {
        const name = r.get('ชื่อห้องเรียน');
        if (!name) { add(S, r.rowNo, 'error', 'ต้องระบุ "ชื่อห้องเรียน"', 'ชื่อห้องเรียน'); continue; }
        if (dupKey(seen, S, r.rowNo, 'ชื่อห้องเรียน', name)) continue;
        const capacity = intCell(S, r.rowNo, 'ความจุ', r.get('ความจุ'));
        if (capacity === undefined) continue;
        const found = lookup(work.rooms, name);
        ambiguous(S, r.rowNo, 'ชื่อห้องเรียน', found, name, 'ห้องเรียน');
        const changes = { building: r.get('อาคาร') || undefined, capacity: capacity ?? undefined, note: r.get('หมายเหตุ') || undefined };
        if (found.length) {
          const { next, changed } = merge(S, r.rowNo, found[0], changes, { building: 'อาคาร', capacity: 'ความจุ', note: 'หมายเหตุ' });
          commit(work.rooms, found[0], next, sh.summary, changed);
        } else {
          work.rooms.push({ id: idGen('r'), name, building: changes.building ?? '', capacity: changes.capacity ?? null, note: changes.note ?? '' });
          sh.summary.add += 1;
        }
      }
    }
  }

  const levelsOf = (S, rowNo, column, text) => {
    const out = [];
    let bad = false;
    for (const l of splitList(text)) {
      if (!levelSet.has(l)) {
        add(S, rowNo, 'error', unknownLevelMsg(l), column);
        bad = true;
      } else if (!out.includes(l)) out.push(l);
    }
    return bad ? undefined : out;
  };

  // ---- รายวิชา ----
  {
    const S = IMPORT_SHEETS.subjects;
    const sh = readSheet(S);
    if (sh && sh.headerOk) {
      const seen = new Map();
      const teacherNames = (ids) => ids.map((id) => work.teachers.find((t) => t.id === id)?.name ?? id).join(', ');
      for (const r of sh.rows) {
        const before = report.rows.length;
        const code = r.get('รหัสวิชา');
        if (!code) { add(S, r.rowNo, 'error', 'ต้องระบุ "รหัสวิชา"', 'รหัสวิชา'); continue; }
        if (dupKey(seen, S, r.rowNo, 'รหัสวิชา', code)) continue;
        const ex = work.subjects.find((s) => typeof s.code === 'string' && sanitizeText(s.code, { max: Infinity }) === code);
        const isNew = !ex;

        const name = r.get('ชื่อวิชา');
        if (isNew && !name) add(S, r.rowNo, 'error', 'ต้องระบุ "ชื่อวิชา" สำหรับวิชาใหม่', 'ชื่อวิชา');

        const typeText = r.get('ประเภท');
        let type;
        if (typeText) {
          type = TYPE_BY_TEXT.get(typeText);
          if (!type) add(S, r.rowNo, 'error', `"ประเภท" ต้องเป็น สามัญ หรือ วิชาชีพ (พบ "${typeText}")`, 'ประเภท');
        } else if (isNew) add(S, r.rowNo, 'error', 'ต้องระบุ "ประเภท" (สามัญ/วิชาชีพ) สำหรับวิชาใหม่', 'ประเภท');

        const theory = intCell(S, r.rowNo, 'ท', r.get('ท'));
        const practice = intCell(S, r.rowNo, 'ป', r.get('ป'));
        const hoursCell = intCell(S, r.rowNo, 'ชม./สัปดาห์', r.get('ชม./สัปดาห์'), 1);
        const credits = intCell(S, r.rowNo, 'หน่วยกิต', r.get('หน่วยกิต'));

        let hours;
        let dropTP = false;
        if (hoursCell !== null && hoursCell !== undefined) {
          if (theory != null && practice != null && theory + practice !== hoursCell) {
            add(S, r.rowNo, 'error', `"ชม./สัปดาห์" (${hoursCell}) ไม่เท่ากับ ท+ป (${theory + practice})`, 'ชม./สัปดาห์');
          } else {
            hours = hoursCell;
            dropTP = !isNew && theory == null && practice == null && (ex.theory !== undefined || ex.practice !== undefined);
          }
        } else if (hoursCell === null && (theory != null || practice != null)) {
          const sum = (theory ?? ex?.theory ?? 0) + (practice ?? ex?.practice ?? 0);
          if (sum < 1) add(S, r.rowNo, 'error', 'ท+ป ต้องรวมกันอย่างน้อย 1 ชม./สัปดาห์', 'ชม./สัปดาห์');
          else hours = sum;
        } else if (hoursCell === null && isNew) {
          add(S, r.rowNo, 'error', 'ต้องระบุ "ชม./สัปดาห์" หรือ "ท" และ "ป" สำหรับวิชาใหม่', 'ชม./สัปดาห์');
        }

        const levelText = r.get('ระดับที่เปิดสอน');
        let levels;
        if (levelText) levels = levelsOf(S, r.rowNo, 'ระดับที่เปิดสอน', levelText);
        else if (isNew) add(S, r.rowNo, 'error', 'ต้องระบุ "ระดับที่เปิดสอน" สำหรับวิชาใหม่', 'ระดับที่เปิดสอน');
        if (levels && levels.length === 0) {
          add(S, r.rowNo, 'error', '"ระดับที่เปิดสอน" ต้องมีอย่างน้อย 1 ระดับ', 'ระดับที่เปิดสอน');
          levels = undefined;
        }

        let teacherIds;
        const teacherText = r.get('ครูผู้สอน');
        if (teacherText) {
          teacherIds = [];
          for (const tn of splitList(teacherText)) {
            const found = lookup(work.teachers, tn);
            if (!found.length) add(S, r.rowNo, 'error', `ไม่พบครู "${tn}" (ต้องมีในชีต "ครูผู้สอน" หรือในระบบ)`, 'ครูผู้สอน');
            else {
              ambiguous(S, r.rowNo, 'ครูผู้สอน', found, tn, 'ครู');
              teacherIds.push(found[0].id);
            }
          }
          teacherIds = uniq(teacherIds);
        }

        if (report.rows.slice(before).some((x) => x.level === 'error')) continue;

        const changes = {
          name: name || undefined, type, credits: credits ?? undefined, hours,
          theory: theory ?? undefined, practice: practice ?? undefined,
          levels, teacherIds, note: r.get('หมายเหตุ') || undefined,
        };
        if (isNew) {
          const row = {
            id: idGen('s'), code, name, type, credits: credits ?? 0, hours,
            ...(theory != null ? { theory } : {}), ...(practice != null ? { practice } : {}),
            teacherIds: teacherIds ?? [], levels, note: changes.note ?? '',
          };
          work.subjects.push(row);
          sh.summary.add += 1;
        } else {
          const base = { ...ex };
          if (dropTP) { delete base.theory; delete base.practice; }
          const labels = { name: 'ชื่อวิชา', type: 'ประเภท', credits: 'หน่วยกิต', hours: 'ชม./สัปดาห์', theory: 'ท', practice: 'ป', levels: 'ระดับที่เปิดสอน', teacherIds: 'ครูผู้สอน', note: 'หมายเหตุ' };
          const { next, changed } = merge(S, r.rowNo, base, changes, labels, { teacherIds: teacherNames });
          commit(work.subjects, ex, next, sh.summary, changed || dropTP);
        }
      }
    }
  }

  const subjectsByCodes = (S, rowNo, column, text) => {
    const out = [];
    for (const c of uniq(splitList(text))) {
      const s = work.subjects.find((x) => typeof x.code === 'string' && sanitizeText(x.code, { max: Infinity }) === c);
      if (!s) add(S, rowNo, 'error', `ไม่พบรหัสวิชา "${c}" (ต้องมีในชีต "รายวิชา" หรือในระบบ)`, column);
      else out.push(s);
    }
    return out;
  };

  // ---- แผนการเรียน ----
  {
    const S = IMPORT_SHEETS.plans;
    const sh = readSheet(S);
    if (sh && sh.headerOk) {
      const seen = new Map();
      const codeNames = (ids) => ids.map((id) => work.subjects.find((x) => x.id === id)?.code ?? id).join(', ');
      for (const r of sh.rows) {
        const before = report.rows.length;
        const name = r.get('ชื่อแผน');
        if (!name) { add(S, r.rowNo, 'error', 'ต้องระบุ "ชื่อแผน"', 'ชื่อแผน'); continue; }
        if (dupKey(seen, S, r.rowNo, 'ชื่อแผน', name)) continue;
        const found = lookup(work.plans, name);
        ambiguous(S, r.rowNo, 'ชื่อแผน', found, name, 'แผนการเรียน');
        const ex = found[0];

        const levelText = r.get('ระดับ');
        let level;
        if (levelText) {
          if (!levelSet.has(levelText)) add(S, r.rowNo, 'error', unknownLevelMsg(levelText), 'ระดับ');
          else level = levelText;
        } else if (!ex) add(S, r.rowNo, 'error', 'ต้องระบุ "ระดับ" สำหรับแผนใหม่', 'ระดับ');

        const codeText = r.get('รหัสวิชา');
        let subjectIds;
        if (codeText) {
          const subs = subjectsByCodes(S, r.rowNo, 'รหัสวิชา', codeText);
          subjectIds = subs.map((s) => s.id);
          const lv = level ?? ex?.level;
          for (const s of subs) {
            if (lv && !s.levels.includes(lv)) add(S, r.rowNo, 'warning', `วิชา ${s.code} ไม่เปิดสอนระดับ ${lv} ของแผน`, 'รหัสวิชา');
          }
        } else if (!ex) add(S, r.rowNo, 'error', 'ต้องระบุ "รหัสวิชา" สำหรับแผนใหม่', 'รหัสวิชา');

        if (report.rows.slice(before).some((x) => x.level === 'error')) continue;
        const note = r.get('หมายเหตุ') || undefined;
        if (ex) {
          const { next, changed } = merge(S, r.rowNo, ex, { level, subjectIds, note },
            { level: 'ระดับ', subjectIds: 'รหัสวิชา', note: 'หมายเหตุ' }, { subjectIds: codeNames });
          commit(work.plans, ex, next, sh.summary, changed);
        } else {
          work.plans.push({ id: idGen('p'), name, level, subjectIds, note: note ?? '' });
          sh.summary.add += 1;
        }
      }
    }
  }

  // ---- กลุ่มเรียน ----
  {
    const S = IMPORT_SHEETS.groups;
    const sh = readSheet(S);
    if (sh && sh.headerOk) {
      const seen = new Map();
      for (const r of sh.rows) {
        const before = report.rows.length;
        const name = r.get('ชื่อกลุ่มเรียน');
        if (!name) { add(S, r.rowNo, 'error', 'ต้องระบุ "ชื่อกลุ่มเรียน"', 'ชื่อกลุ่มเรียน'); continue; }
        if (dupKey(seen, S, r.rowNo, 'ชื่อกลุ่มเรียน', name)) continue;
        const found = lookup(work.groups, name);
        ambiguous(S, r.rowNo, 'ชื่อกลุ่มเรียน', found, name, 'กลุ่มเรียน');
        const ex = found[0];

        const levelText = r.get('ระดับ');
        let level;
        if (levelText) {
          if (!levelSet.has(levelText)) add(S, r.rowNo, 'error', unknownLevelMsg(levelText), 'ระดับ');
          else level = levelText;
        } else if (!ex) add(S, r.rowNo, 'error', 'ต้องระบุ "ระดับ" สำหรับกลุ่มเรียนใหม่', 'ระดับ');

        const effLevel = level ?? ex?.level;
        let planId;
        const planName = r.get('แผนการเรียน');
        let planSubjects = [];
        if (planName) {
          const ps = lookup(work.plans, planName);
          if (!ps.length) add(S, r.rowNo, 'error', `ไม่พบแผนการเรียน "${planName}" (ต้องมีในชีต "แผนการเรียน" หรือในระบบ)`, 'แผนการเรียน');
          else {
            ambiguous(S, r.rowNo, 'แผนการเรียน', ps, planName, 'แผนการเรียน');
            planId = ps[0].id;
            planSubjects = ps[0].subjectIds.map((id) => work.subjects.find((s) => s.id === id)).filter(Boolean);
            if (effLevel && ps[0].level !== effLevel) {
              add(S, r.rowNo, 'warning', `แผน "${planName}" เป็นระดับ ${ps[0].level} แต่กลุ่มเรียนเป็นระดับ ${effLevel}`, 'แผนการเรียน');
            }
          }
        }
        const extra = r.get('รหัสวิชา') ? subjectsByCodes(S, r.rowNo, 'รหัสวิชา', r.get('รหัสวิชา')) : [];

        if (report.rows.slice(before).some((x) => x.level === 'error')) continue;

        const bound = [...(ex?.subjectIds ?? [])];
        for (const s of [...planSubjects, ...extra]) {
          if (effLevel && !s.levels.includes(effLevel)) {
            add(S, r.rowNo, 'warning', `ข้ามวิชา ${s.code} ${s.name}: เปิดสอนระดับ ${s.levels.join(', ')} ไม่รวมระดับ ${effLevel}`, 'รหัสวิชา');
          } else if (!bound.includes(s.id)) bound.push(s.id);
        }
        const major = r.get('สาขา') || undefined;
        if (ex) {
          const { next, changed } = merge(S, r.rowNo, ex,
            { level, major, planId, subjectIds: same(bound, ex.subjectIds) ? undefined : bound },
            { level: 'ระดับ', major: 'สาขา', planId: 'แผนการเรียน', subjectIds: 'รหัสวิชา' },
            { subjectIds: (ids) => ids.map((id) => work.subjects.find((x) => x.id === id)?.code ?? id).join(', '), planId: (id) => work.plans.find((p) => p.id === id)?.name ?? id });
          commit(work.groups, ex, next, sh.summary, changed);
        } else {
          work.groups.push({ id: idGen('g'), name, level, major: major ?? '', subjectIds: bound, planId: planId ?? null });
          sh.summary.add += 1;
        }
      }
    }
  }

  if (hasError()) return finish(false, null);

  // ---- ตรวจรวม (atomic) ----
  const parsed = parseState(work);
  if (!parsed.ok) {
    for (const m of parsed.errors) add(OVERALL, 0, 'error', m);
    return finish(false, null);
  }
  let next = parsed.state;
  if (trim) {
    const t = trimOverHours(next);
    next = t.state;
    report.trimmed = t.removed;
    for (const x of t.removed) {
      add(OVERALL, 0, 'warning', `ตัดคาบส่วนเกิน: ${x.subjectCode} ${x.subjectName} กลุ่มเรียน ${x.groupName} (วัน ${x.day} คาบ ${x.period})`);
    }
  }
  for (const c of validateAll(next)) add(OVERALL, 0, 'error', c.message);
  return finish(true, next);
}

// สัญญา SPEC §14.1: importWorkbook(state, sheets, { trimOverHours }) -> { ok, report, state? (เฉพาะ ok) }
// sheets = { 'รายวิชา': [ { __row: 2, 'รหัสวิชา*': '...', ... } ], ... } (หรือ array ของ array ที่แถวแรกเป็นหัว)
export function importWorkbook(state, sheets, options = {}) {
  const r = importRows(state, sheets, options);
  return r.ok ? { ok: true, report: r.report, state: r.state } : { ok: false, report: r.report };
}
