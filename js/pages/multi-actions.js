// ตรรกะของโหมดเลือกหลายช่อง (SPEC v5 ข้อ 15): สร้างรายการ → ตรวจล่วงหน้า (dryRun) → ลง/ลบ ผ่าน op เดียว (atomic)
// แยกจาก schedule.js เพื่อทดสอบใน node ได้ · ทุกการเขียนผ่าน doOp (ใช้กลไก 409/422 เดิม)
import { uid } from '../store.js';
import { dayName, periodLabel } from '../constants.js';
import { parseKey, sortedKeys, MAX_SELECTION } from '../selection-model.js';
import { ctx, doOp } from './util.js';

// ชนิด error ของช่อง → ข้อความสั้น (ข้อความเต็มภาษาไทยมาจาก scheduler อยู่แล้ว ใช้เป็นเหตุผลหลัก)
// ชนิด error → ป้ายสั้นของกล่องผลรายช่อง (class reason-* ของมิ้นท์; group/duplicate/duplicate_slot ใช้ป้ายกลุ่ม 'มีวิชาแล้ว'/'ช่องซ้ำ')
export const REASON_CHIP = {
  teacher: ['reason-teacher', 'ชนครู'], classroom: ['reason-room', 'ชนห้อง'], hours: ['reason-hours', 'ชั่วโมงเต็ม'], level: ['reason-level', 'ระดับไม่ตรง'],
  lunch: ['reason-lunch', 'พักเที่ยง'], group: ['reason-group', 'ชนกลุ่มเรียน'], duplicate: ['reason-dup', 'ช่องซ้ำ'], duplicate_slot: ['reason-dup', 'ช่องซ้ำ'],
  invalid: ['reason-invalid', 'ข้อมูลไม่ถูกต้อง'], invalid_id: ['reason-invalid', 'ข้อมูลไม่ถูกต้อง'],
};
export const reasonChip = (type) => REASON_CHIP[type] ?? ['reason-invalid', 'ลงไม่ได้'];
export const REASON_LABEL = {
  hours: 'ชั่วโมงเกิน', group: 'มีวิชาแล้ว', teacher: 'ชนครู', classroom: 'ชนห้องเรียน', level: 'ระดับไม่ตรง', lunch: 'พักเที่ยง',
  duplicate: 'มีวิชาแล้ว', duplicate_slot: 'ช่องซ้ำในชุด', invalid: 'ข้อมูลไม่ถูกต้อง', invalid_id: 'รหัสไม่ถูกต้อง',
};

// keys = ช่อง 'day:period' ที่ลงได้ (ผ่าน partitionSelection แล้ว) ; cfg = { subjectId, teacherId?, roomId? }
export function placeItems(groupId, keys, cfg) {
  return sortedKeys(keys).map((k) => {
    const { day, period } = parseKey(k);
    const it = { id: uid('e'), groupId, day, period, subjectId: cfg.subjectId };
    if (cfg.roomId) it.roomId = cfg.roomId;
    if (cfg.teacherId) it.teacherId = cfg.teacherId;
    return it;
  });
}

export const tooMany = (n) => n > MAX_SELECTION;

// รายงานรายช่องจากผลของ op (dryRun หรือ policy:'all' ที่ล้ม): [{ index, day, period, ok, reasons:[string] }]
export function rowsFromResult(r, items) {
  const raw = r?.raw ?? r ?? {};
  const list = Array.isArray(raw.items) ? raw.items : [];
  const byIndex = new Map(list.map((x) => [x.index, x]));
  return items.map((it, index) => {
    const x = byIndex.get(index);
    const errs = x && !x.ok ? x.errors ?? [] : [];
    return {
      index,
      day: it.day,
      period: it.period,
      ok: x ? Boolean(x.ok) : false,
      reasons: errs.map((e) => e?.message ?? REASON_LABEL[e?.type] ?? 'ลงไม่ได้'),
      types: errs.map((e) => e?.type).filter(Boolean),
    };
  });
}

export const rowLabel = (row) => `วัน${dayName(row.day)} ${periodLabel(row.period)}`;

// ตรวจล่วงหน้า → { wouldSucceed, rows, okCount, total, error? }
export async function dryRunPlace(items) {
  const r = await doOp({ type: 'entry.placeMany', items, policy: 'all', dryRun: true });
  if (!r.ok && !(r.raw && Array.isArray(r.raw.items))) return { wouldSucceed: false, rows: [], okCount: 0, total: items.length, error: r };
  const rows = rowsFromResult(r, items);
  // K = จำนวนช่องที่ลงได้ — ใช้ summary.placeable ของโดมถ้ามี ไม่งั้นนับจากรายช่อง
  const okCount = Number.isInteger(r.raw?.summary?.placeable) ? r.raw.summary.placeable : rows.filter((x) => x.ok).length;
  return { wouldSucceed: Boolean(r.raw?.wouldSucceed) && okCount === items.length, rows, okCount, total: items.length };
}

// policy 'all' = ลงทั้งชุดหรือไม่ลงเลย · 'valid' = ลงเฉพาะที่ผ่าน (K จาก N) — ทั้งคู่เป็น op เดียว (1 CAS ที่เซิร์ฟเวอร์)
export async function placeMany(items, policy) {
  const before = ctx.state.entries.length;
  const r = await doOp({ type: 'entry.placeMany', items, policy });
  // คำตอบ 200 ของเซิร์ฟเวอร์ไม่มีรายการ placed/rejected (มีเฉพาะ dryRun) → นับจากคาบที่เพิ่มขึ้นจริงใน state ที่เซิร์ฟเวอร์ยืนยัน
  const placedCount = r.ok ? Math.max(0, ctx.state.entries.length - before) : 0;
  return { ...r, placedCount, rejectedCount: r.ok ? items.length - placedCount : 0 };
}

// สรุปคาบที่จะลบ: จำนวน + รายการ "วิชา × จำนวนคาบ" (ไว้ใส่ confirm)
export function removalSummary(state, entryIds) {
  const ids = new Set(entryIds);
  const counts = new Map();
  for (const e of state.entries) {
    if (!ids.has(e.id)) continue;
    const name = state.subjects.find((s) => s.id === e.subjectId)?.name ?? e.subjectId;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([name, n]) => `${name} ${n} คาบ`);
  return { total: ids.size, parts, text: parts.join(', ') };
}

export async function removeMany(entryIds) {
  const r = await doOp({ type: 'entry.removeMany', entryIds });
  return { ...r, removedCount: r.ok ? r.raw?.removed ?? entryIds.length : 0 };
}

// ช่องที่ "ลงแล้ว" ของกลุ่มในช่องที่เลือก → entry id (โหมดลบ)
export function entryIdsAt(state, groupId, keys) {
  const out = [];
  for (const k of sortedKeys(keys)) {
    const c = parseKey(k);
    const e = state.entries.find((x) => x.groupId === groupId && x.day === c.day && x.period === c.period);
    if (e) out.push(e.id);
  }
  return out;
}

export const hasEntryAt = (state, groupId, day, period) => state.entries.some((x) => x.groupId === groupId && x.day === day && x.period === period);
