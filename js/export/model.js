// โมเดลตารางสำหรับส่งออก (pure) — สร้างโครงตารางจาก state + scope ไม่แตะ DOM / ไลบรารี xlsx / pdf
// หน้าตาราง: คอลัมน์ = คาบ 1–11 (แทรกคอลัมน์พักเที่ยงต่อจากคาบ LUNCH.afterPeriod) แถว = จันทร์–ศุกร์
// ใช้ได้ทั้ง state v3 และ v4 (อ่านเฉพาะ subjects/teachers/groups/rooms/entries)
import * as C from '../constants.js';

const { DAYS, PERIODS, LUNCH } = C;
// ลำดับระดับ: อ่านจาก state.levels (v5) ถ้าไม่มี (state เก่า) ใช้ DEFAULT_LEVELS · ระดับที่ไม่อยู่ในรายการ → ท้ายสุด (rank = ความยาวรายการ)
const levelOrder = (state) => (Array.isArray(state.levels) ? state.levels : C.DEFAULT_LEVELS);
import { effectiveTeacherId } from '../scheduler.js';

export const KINDS = [
  { id: 'teacher', name: 'รายครู' },
  { id: 'classroom', name: 'รายห้องเรียน' },
  { id: 'group', name: 'รายกลุ่มเรียน' },
];
export const MODES = ['one', 'many', 'all', 'everything'];
export const EMPTY_TEXT = 'ยังไม่มีคาบ';

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
];

const byId = (list, id) => (list || []).find((x) => x.id === id);
// ตัดอักขระควบคุม (C0/C1 รวม tab CR LF), อักขระกำกับทิศทาง (U+200E/F, U+202A–202E, U+2066–2069, U+061C),
// zero-width/BOM ที่ใช้หลอกตา แล้ว NFC — ใช้กับทุกข้อความที่ออกไปใน xlsx/pdf (W-11)
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁦-⁩﻿]/g;
export function cleanText(v) {
  if (v === undefined || v === null) return '';
  return String(v).normalize('NFC').replace(UNSAFE_CHARS, ' ').replace(/ {2,}/g, ' ').trim();
}
const str = cleanText;
const thaiCompare = (a, b) => String(a).localeCompare(String(b), 'th', { numeric: true });

export const kindName = (kind) => KINDS.find((k) => k.id === kind)?.name ?? kind;

// วันที่แบบไทย พ.ศ. เช่น "11 ตุลาคม 2569" (ใช้ปฏิทินในเครื่อง ไม่ใช้ Intl เพื่อให้ผลเท่ากันทุกเครื่อง)
export function formatThaiDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

// วันที่สำหรับชื่อไฟล์: YYYY-MM-DD (ค.ศ.)
export function formatFileDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- รายการที่เลือกส่งออกได้ ----------
export function listItems(state, kind) {
  if (kind === 'teacher') {
    return [...(state.teachers || [])]
      .sort((a, b) => thaiCompare(a.name, b.name))
      .map((t) => ({ kind, id: t.id, name: t.name, detail: str(t.dept) }));
  }
  if (kind === 'classroom') {
    return [...(state.rooms || [])]
      .sort((a, b) => thaiCompare(a.name, b.name))
      .map((r) => ({ kind, id: r.id, name: r.name, detail: str(r.building) }));
  }
  if (kind === 'group') {
    const order = levelOrder(state);
    const rank = (g) => {
      const i = order.indexOf(g.level);
      return i < 0 ? order.length : i;
    };
    return [...(state.groups || [])]
      .sort((a, b) => rank(a) - rank(b) || thaiCompare(a.name, b.name))
      .map((g) => ({ kind, id: g.id, name: g.name, detail: [g.level, g.major].map(str).filter(Boolean).join(' ') }));
  }
  return [];
}

// scope = { kind, mode: 'one'|'many'|'all'|'everything', ids?: [id] }
// คืน [{kind,id,name,detail}] ตามลำดับที่จะออกไฟล์; id ที่ไม่มีอยู่จริงข้าม (ไม่ throw)
// ผู้ดูอย่างเดียว: state ที่ได้มาถูกกรอง scope แล้ว จึงไม่มีทางเลือกเกินสิทธิ์
// hideTeacherNames (ชั้นป้องกันซ้ำ): ซ่อนรายชื่อครู = ไม่ออกตารางรายครู และไม่ใส่ชื่อครูในช่อง
// (ปกติ state ของผู้ชมที่ซ่อนชื่อครูไม่มีครูอยู่แล้ว ตัวเลือกนี้กันกรณีส่ง state เต็มเข้ามาโดยพลาด)
export function resolveScope(state, scope = {}, { hideTeacherNames = false } = {}) {
  const { kind, mode = 'all' } = scope;
  if (!MODES.includes(mode)) throw new Error(`โหมดส่งออกไม่ถูกต้อง: ${mode}`);
  const kinds = hideTeacherNames ? KINDS.filter((k) => k.id !== 'teacher') : KINDS;
  if (mode === 'everything') return kinds.flatMap((k) => listItems(state, k.id));
  if (!KINDS.some((k) => k.id === kind)) throw new Error(`ประเภทส่งออกไม่ถูกต้อง: ${kind}`);
  if (hideTeacherNames && kind === 'teacher') return [];
  const all = listItems(state, kind);
  if (mode === 'all') return all;
  const wanted = new Set(Array.isArray(scope.ids) ? scope.ids : []);
  const picked = all.filter((it) => wanted.has(it.id));
  return mode === 'one' ? picked.slice(0, 1) : picked;
}

// ---------- ตารางหนึ่งรายการ ----------
// คอลัมน์: [{type:'period',id,label:'1',time:'08:00-09:00'}, ..., {type:'lunch',label:'พักเที่ยง',time}]
export function buildColumns() {
  const cols = [];
  for (const p of PERIODS) {
    cols.push({ type: 'period', id: p.id, label: String(p.id), time: `${p.start}-${p.end}` });
    if (p.id === LUNCH.afterPeriod) cols.push({ type: 'lunch', id: 'lunch', label: 'พักเที่ยง', time: `${LUNCH.start}-${LUNCH.end}` });
  }
  return cols;
}

// ข้อความหัวช่อง (รหัส + ชื่อ + ผู้เกี่ยวข้อง) ตามมุมมอง
function describeEntry(state, kind, entry, mergedWith, hideTeacherNames = false) {
  const subject = byId(state.subjects, entry.subjectId);
  const group = byId(state.groups, entry.groupId);
  const room = entry.roomId ? byId(state.rooms, entry.roomId) : null;
  const teacher = hideTeacherNames ? null : byId(state.teachers, effectiveTeacherId(state, entry));
  const head = subject ? [str(subject.code), str(subject.name)].filter(Boolean).join(' ') : '(ไม่พบรายวิชา)';
  const lines = [head];
  const groupName = group ? str(group.name) : '';
  // วิชามีหลายครูแต่คาบนี้ยังไม่ระบุครู → แสดงรายชื่อครูของวิชา (ข้อมูลเดิมจากรูปแบบ v3)
  const poolNames = !hideTeacherNames && !teacher && subject && Array.isArray(subject.teacherIds)
    ? subject.teacherIds.map((tid) => str(byId(state.teachers, tid)?.name)).filter(Boolean)
    : [];
  const teacherName = teacher ? str(teacher.name) : poolNames.join(', ');
  const roomText = room ? `ห้อง ${str(room.name)}` : '';
  if (kind === 'teacher') lines.push(groupName, roomText);
  else if (kind === 'classroom') lines.push(groupName, teacherName);
  else lines.push(teacherName, roomText);
  return {
    entryId: entry.id,
    subjectId: entry.subjectId,
    // type = 'general' | 'vocational' | '' (ไม่พบวิชา); code/name/info ใช้จัดหน้า PDF (head = code + name, info = บรรทัดที่เหลือ)
    type: subject && (subject.type === 'general' || subject.type === 'vocational') ? subject.type : '',
    code: subject ? str(subject.code) : '',
    name: subject ? str(subject.name) : head,
    info: lines.slice(1).filter(Boolean),
    lines: lines.filter(Boolean),
    merged: mergedWith.length > 0,
    mergedGroups: mergedWith,
  };
}

function selectEntries(state, kind, id) {
  const entries = state.entries || [];
  if (kind === 'group') return entries.filter((e) => e.groupId === id);
  if (kind === 'classroom') return entries.filter((e) => e.roomId === id);
  return entries.filter((e) => effectiveTeacherId(state, e) === id);
}

// เรียนรวม = วิชาสามัญเดียวกัน วัน+คาบเดียวกัน มีหลายกลุ่มเรียน (ตามกฎ canMerge)
function mergedGroupNames(state, entry) {
  const subject = byId(state.subjects, entry.subjectId);
  if (!subject || subject.type !== 'general') return [];
  return (state.entries || [])
    .filter((o) => o.id !== entry.id && o.subjectId === entry.subjectId && o.day === entry.day && o.period === entry.period)
    .map((o) => str(byId(state.groups, o.groupId)?.name))
    .filter(Boolean);
}

export function buildTimetable(state, { kind, id }, { semester = '', year = '', printedAt = new Date(), hideTeacherNames = false } = {}) {
  const columns = buildColumns();
  let title;
  let name;
  let subtitle = '';
  if (kind === 'teacher' && hideTeacherNames) throw new Error('ซ่อนรายชื่อครู: ส่งออกตารางรายครูไม่ได้');
  if (kind === 'teacher') {
    const t = byId(state.teachers, id);
    if (!t) throw new Error(`ไม่พบครู: ${id}`);
    name = str(t.name);
    title = `ตารางสอนครู ${name}`;
    subtitle = str(t.dept);
  } else if (kind === 'classroom') {
    const r = byId(state.rooms, id);
    if (!r) throw new Error(`ไม่พบห้องเรียน: ${id}`);
    name = str(r.name);
    title = `ตารางการใช้ห้องเรียน ${name}`;
    subtitle = str(r.building);
  } else if (kind === 'group') {
    const g = byId(state.groups, id);
    if (!g) throw new Error(`ไม่พบกลุ่มเรียน: ${id}`);
    name = str(g.name);
    title = `ตารางเรียนกลุ่มเรียน ${name}`;
    subtitle = [g.level, g.major].map(str).filter(Boolean).join(' ');
  } else {
    throw new Error(`ประเภทส่งออกไม่ถูกต้อง: ${kind}`);
  }

  const entries = selectEntries(state, kind, id).filter(
    (e) => DAYS.some((d) => d.id === e.day) && PERIODS.some((p) => p.id === e.period),
  );
  const rows = DAYS.map((day) => ({
    day: day.id,
    dayName: day.name,
    cells: columns.map((col) => {
      if (col.type === 'lunch') return { lunch: true, items: [] };
      const items = entries
        .filter((e) => e.day === day.id && e.period === col.id)
        .map((e) => describeEntry(state, kind, e, mergedGroupNames(state, e), hideTeacherNames));
      return { lunch: false, items };
    }),
  }));

  const meta = [];
  const term = [str(semester) && `ภาคเรียนที่ ${str(semester)}`, str(year) && `ปีการศึกษา ${str(year)}`].filter(Boolean).join(' ');
  if (term) meta.push(term);
  if (hideTeacherNames) meta.push('ซ่อนรายชื่อครู');
  meta.push(`พิมพ์เมื่อ ${formatThaiDate(printedAt)}`);

  return {
    kind,
    id,
    name,
    title,
    subtitle,
    term,
    printedText: `พิมพ์เมื่อ ${formatThaiDate(printedAt)}`,
    metaLines: meta,
    columns,
    rows,
    empty: entries.length === 0,
    emptyText: EMPTY_TEXT,
    entryCount: entries.length,
  };
}

export function buildTimetables(state, scope, options = {}) {
  return resolveScope(state, scope, options).map((it) => buildTimetable(state, it, options));
}

// ข้อความหนึ่งช่องสำหรับ xlsx (ขึ้นบรรทัดใหม่ด้วย \n; เรียนรวมมีป้ายกำกับ)
export function cellText(cell) {
  if (!cell || cell.lunch || !cell.items.length) return '';
  return cell.items
    .map((it) => {
      const lines = [...it.lines];
      if (it.merged) lines.push(it.mergedGroups.length ? `[เรียนรวม: ${it.mergedGroups.join(', ')}]` : '[เรียนรวม]');
      return lines.join('\n');
    })
    .join('\n— — —\n');
}

// ---------- ชื่อชีต Excel ----------
const SHEET_FORBIDDEN = /[\\/?*[\]:]/g;
const SHEET_MAX = 31;

// ชื่อชีตต้อง: ≤31 ตัวอักษร, ไม่ซ้ำ (ไม่แยกตัวพิมพ์เล็กใหญ่), ไม่มี \ / ? * [ ] :, ไม่ว่าง,
// ไม่ขึ้น/ลงท้ายด้วย ' และไม่ใช่ "History" (ชื่อสงวน)
export function sanitizeSheetName(name) {
  let s = str(name).replace(SHEET_FORBIDDEN, ' ').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').trim();
  s = s.replace(/^'+|'+$/g, '').trim();
  if (!s || s.toLowerCase() === 'history') s = `ชีต ${s}`.trim();
  return s.slice(0, SHEET_MAX).replace(/^'+|'+$/g, '').trim() || 'ชีต';
}

export function uniqueSheetNames(names) {
  const used = new Set();
  return names.map((raw) => {
    const base = sanitizeSheetName(raw);
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      candidate = base.slice(0, SHEET_MAX - suffix.length).trimEnd() + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

// ชื่อชีตของแต่ละตาราง: ใส่คำนำหน้าประเภทเมื่อส่งออก "ทุกประเภท" เพื่อไม่ให้ชื่อซ้ำกันข้ามประเภท
export function sheetNamesFor(tables, { withKindPrefix = false } = {}) {
  const prefix = { teacher: 'ครู', classroom: 'ห้อง', group: 'กลุ่ม' };
  return uniqueSheetNames(
    tables.map((t) => (withKindPrefix ? `${prefix[t.kind]} ${t.name}` : t.name)),
  );
}

// ---------- ชื่อไฟล์ ----------
export function exportFileName({ scope, ext, date = new Date(), label = '' }) {
  const part = scope.mode === 'everything' ? 'ทุกประเภท' : kindName(scope.kind).replace(/^ราย/, '');
  const extra = str(label).replace(/[\\/:*?"<>|]/g, '').replace(/\.{2,}/g, '.').replace(/\s+/g, '-').replace(/^\.+|\.+$/g, '').slice(0, 40);
  return ['ตารางเรียนตารางสอน', part, extra, formatFileDate(date)].filter(Boolean).join('-') + `.${ext}`;
}
