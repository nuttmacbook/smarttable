// โมเดลการเลือกหลายช่องในตารางคาบ (SPEC v5 ข้อ 15.1) — pure ไม่แตะ DOM ทดสอบใน node ได้
// ช่อง = (day 1–5, period 1–11) คีย์ 'day:period' · ใช้ Set/Map เท่านั้น (ไม่ใช้ object เป็นดัชนี — W-02)
// การลาก/Shift+คลิก/ปุ่มสลับบนทัช ต่างก็เรียกฟังก์ชันชุดเดียวกัน (ผล = สี่เหลี่ยมผืนผ้าระหว่างสองช่อง)
import { DAYS, PERIODS } from './constants.js';

export const MAX_SELECTION = 200; // เพดานต่อชุดตาม op entry.placeMany / removeMany

export const cellKey = (day, period) => `${day}:${period}`;
export function parseKey(key) {
  const m = /^(\d+):(\d+)$/.exec(String(key));
  return m ? { day: Number(m[1]), period: Number(m[2]) } : null;
}
const validDay = (d) => DAYS.some((x) => x.id === d);
const validPeriod = (p) => PERIODS.some((x) => x.id === p);
export const isGridCell = (day, period) => validDay(day) && validPeriod(period);

const dayIndex = (d) => DAYS.findIndex((x) => x.id === d);
const periodIndex = (p) => PERIODS.findIndex((x) => x.id === p);

// สี่เหลี่ยมผืนผ้าระหว่างช่อง a กับ b (รวมปลายทั้งสอง) · แถวเดียวกัน = ช่วงคาบ · ช่องพักเที่ยงไม่ใช่คาบจึงไม่ถูกรวมโดยธรรมชาติ
export function rectKeys(a, b) {
  const A = typeof a === 'string' ? parseKey(a) : a;
  const B = typeof b === 'string' ? parseKey(b) : b;
  if (!A || !B || !isGridCell(A.day, A.period) || !isGridCell(B.day, B.period)) return [];
  const d1 = Math.min(dayIndex(A.day), dayIndex(B.day));
  const d2 = Math.max(dayIndex(A.day), dayIndex(B.day));
  const p1 = Math.min(periodIndex(A.period), periodIndex(B.period));
  const p2 = Math.max(periodIndex(A.period), periodIndex(B.period));
  const out = [];
  for (let d = d1; d <= d2; d += 1) for (let p = p1; p <= p2; p += 1) out.push(cellKey(DAYS[d].id, PERIODS[p].id));
  return out;
}

// เรียงลำดับ (day, period) จากน้อยไปมาก — ตรงกับลำดับประมวลผลของ op หลายช่อง
export function sortedKeys(keys) {
  return [...keys]
    .map((k) => ({ k, ...parseKey(k) }))
    .filter((x) => x.day !== undefined)
    .sort((x, y) => x.day - y.day || x.period - y.period)
    .map((x) => x.k);
}

// ----- สถานะการเลือก (ไม่เปลี่ยนค่าเดิม: ทุกฟังก์ชันคืนสถานะใหม่) -----
export const createSelection = () => ({ keys: new Set(), anchor: null });

export function toggleCell(sel, key) {
  if (!parseKey(key)) return sel;
  const keys = new Set(sel.keys);
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return { keys, anchor: key };
}

// Shift+คลิก (หรือปุ่ม "เพิ่ม/ลบ ช่วงเลือก" บนทัช): เลือก/ยกเลิกช่วงจาก anchor ถึงช่องที่คลิก
export function applyRange(sel, key, mode = 'add') {
  if (!parseKey(key)) return sel;
  const from = sel.anchor ?? key;
  const keys = new Set(sel.keys);
  for (const k of rectKeys(from, key)) {
    if (mode === 'remove') keys.delete(k);
    else keys.add(k);
  }
  return { keys, anchor: key };
}

export const clearSelection = () => createSelection();

// ----- ลากเลือก: เริ่มที่ช่องใดช่องหนึ่ง โหมดตามสถานะช่องเริ่ม (เลือกอยู่แล้ว = ลาก "ยกเลิก") -----
export function beginDrag(sel, key) {
  if (!parseKey(key)) return null;
  return { base: new Set(sel.keys), start: key, mode: sel.keys.has(key) ? 'remove' : 'add' };
}
// ผลระหว่างลาก = base ∪ rect (หรือ base − rect) — ลากกลับแล้วผลย้อนกลับตามได้
export function dragTo(drag, key) {
  if (!drag || !parseKey(key)) return null;
  const keys = new Set(drag.base);
  for (const k of rectKeys(drag.start, key)) {
    if (drag.mode === 'remove') keys.delete(k);
    else keys.add(k);
  }
  return { keys, anchor: key };
}

// แยกช่องที่เลือกเป็น "ใช้ได้" กับ "ข้าม" (พักเที่ยง/ไม่ใช่ช่องตาราง/ไม่ผ่านเงื่อนไขของโหมด) — ข้ามเงียบ แต่นับในรายงาน
// canUse(day, period) -> boolean
export function partitionSelection(keys, canUse) {
  const usable = [];
  const skipped = [];
  for (const k of sortedKeys(keys)) {
    const c = parseKey(k);
    (c && isGridCell(c.day, c.period) && canUse(c.day, c.period) ? usable : skipped).push(k);
  }
  return { usable, skipped };
}

export const overLimit = (count) => count > MAX_SELECTION;
