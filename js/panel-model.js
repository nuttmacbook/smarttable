// โมเดลของแผงรายวิชาข้างตาราง (SPEC v4 ข้อ 9) — pure ไม่แตะ DOM ทดสอบใน node ได้
// แต่ละแถว: ต้องเรียน (hours) / จัดแล้ว / เหลือ / สถานะ ('todo' | 'partial' | 'done' | 'over')
// เรียง: เหลือ > 0 ก่อน (เหลือมาก→น้อย แล้วตามรหัส) · ครบ (done) ต่อท้าย · เกิน (over) อยู่ก่อนวิชาที่ครบ

import { checkPlacement } from './scheduler.js';

const byCode = (a, b) => String(a.subject.code).localeCompare(String(b.subject.code), 'th');

export function subjectProgress(state, group, subject) {
  const need = Number(subject.hours) || 0;
  const used = (state.entries || []).filter((e) => e.groupId === group.id && e.subjectId === subject.id).length;
  const remaining = Math.max(0, need - used);
  const over = Math.max(0, used - need);
  let status = 'todo';
  if (over > 0) status = 'over';
  else if (need > 0 && used >= need) status = 'done';
  else if (used > 0) status = 'partial';
  return { subject, need, used, remaining, over, status, percent: need > 0 ? Math.min(100, Math.round((used / need) * 100)) : 0 };
}

// กลุ่มที่ subjectIds ว่างหรือไม่มี → rows = [] (UI แสดง "ยังไม่ได้ผูกวิชา")
export function groupPanelRows(state, groupId) {
  const group = (state.groups || []).find((g) => g.id === groupId);
  if (!group) return { group: null, rows: [], unbound: true };
  const ids = Array.isArray(group.subjectIds) ? group.subjectIds : [];
  const rows = ids
    .map((id) => (state.subjects || []).find((s) => s.id === id))
    .filter(Boolean)
    .map((s) => subjectProgress(state, group, s));
  const rank = (r) => (r.status === 'over' ? 1 : r.remaining > 0 ? 0 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || b.remaining - a.remaining || byCode(a, b));
  return { group, rows, unbound: ids.length === 0 };
}

// วิชาที่ลงได้อีกไหม (ใช้ซ่อนในตัวเลือกเมื่อชั่วโมงเต็ม): used < hours
export function hoursFull(state, groupId, subjectId) {
  const group = (state.groups || []).find((g) => g.id === groupId);
  const subject = (state.subjects || []).find((s) => s.id === subjectId);
  if (!group || !subject) return false;
  return subjectProgress(state, group, subject).remaining === 0 && Number(subject.hours) > 0;
}

export const STATUS_TEXT = {
  todo: 'ยังไม่จัด',
  partial: 'กำลังจัด',
  done: 'เสร็จ ✓',
  over: 'เกิน',
};

// ---------- ช่องที่ลงวิชาที่เลือกไม่ได้ (ไฮไลต์แดงในหน้าจัดตาราง) ----------
// ใช้ checkPlacement ของ scheduler.js ตัวเดียวกับตอนวางจริง/เซิร์ฟเวอร์ (ไม่เขียนกฎซ้ำ) — pure ไม่แตะ DOM
// คืน Map<'day:period', { types:[ชนิดชน], reason:'ข้อความสั้น' }> เฉพาะช่องว่างของกลุ่มที่ลงไม่ได้ (ช่องที่มีวิชาแล้วไม่นับ)
// reason เป็นข้อความสั้นตายตัว ไม่มีชื่อครู/ห้อง/วิชา (ไม่รั่วข้อมูล)
// วิชาหลายครูและยังไม่เลือกครู: แดงเมื่อ "ครูทุกคน" ชน (ลงได้ถ้ามีครูอย่างน้อย 1 คนว่าง)
const BLOCK_LABEL = { teacher: 'ชนครู', classroom: 'ชนห้อง', hours: 'ชั่วโมงเต็ม', level: 'ระดับไม่ตรง', lunch: 'พักเที่ยง', invalid: 'ลงไม่ได้', group: 'มีวิชาแล้ว' };
export const blockLabel = (type) => BLOCK_LABEL[type] ?? 'ลงไม่ได้';

// โควตาชั่วโมงของ (กลุ่ม+วิชา) ในโหมดเลือกหลายช่อง : ใช้นิยามเดียวกับกฎ hours ของ scheduler (ชั่วโมงต่อสัปดาห์ − คาบที่จัดแล้วของกลุ่มนี้ ; hours ไม่ใช่เลขบวก = ไม่จำกัด)
// available = ที่ยังเลือกเพิ่มในชุดได้ทั้งหมด (ไม่ติดลบ แม้ข้อมูลเดิมเกินอยู่แล้ว) ; remaining = available − จำนวนที่เลือกค้าง
export function remainingQuota(state, { groupId, subjectId, picked = 0 } = {}) {
  const group = (state.groups || []).find((g) => g.id === groupId);
  const subject = (state.subjects || []).find((s) => s.id === subjectId);
  if (!group || !subject) return { unlimited: true, need: 0, used: 0, picked, available: Infinity, remaining: Infinity };
  const p = subjectProgress(state, group, subject);
  const hours = Number(subject.hours);
  if (!Number.isFinite(hours) || hours <= 0) return { unlimited: true, need: 0, used: p.used, picked, available: Infinity, remaining: Infinity };
  const available = Math.max(0, hours - p.used);
  return { unlimited: false, need: hours, used: p.used, picked, available, remaining: Math.max(0, available - picked) };
}

export function blockedCells(state, { groupId, subjectId, teacherId, roomId, picked } = {}) {
  const out = new Map();
  const subject = (state.subjects || []).find((s) => s.id === subjectId);
  const group = (state.groups || []).find((g) => g.id === groupId);
  if (!subject || !group) return out;
  const tids = Array.isArray(subject.teacherIds) ? subject.teacherIds : [];
  const occupied = new Set();
  for (const e of state.entries || []) if (e.groupId === groupId) occupied.add(`${e.day}:${e.period}`);
  // เลือกค้างในชุดจนโควตาเต็ม → ช่องว่างอื่นที่ยังไม่ได้เลือกลงไม่ได้ (ชั่วโมงเต็ม) ทันที
  const q = picked && picked.size ? remainingQuota(state, { groupId, subjectId, picked: picked.size }) : null;
  const exhausted = Boolean(q && !q.unlimited && q.remaining <= 0);
  for (let day = 1; day <= 5; day += 1) {
    for (let period = 1; period <= 11; period += 1) {
      const key = `${day}:${period}`;
      if (occupied.has(key)) continue;
      const base = { groupId, day, period, subjectId, ...(roomId ? { roomId } : {}) };
      const types = checkPlacement(state, { ...base, ...(teacherId ? { teacherId } : {}) }).conflicts.map((c) => c.type);
      if (!teacherId && tids.length >= 2 && !types.includes('teacher')
        && tids.every((tid) => checkPlacement(state, { ...base, teacherId: tid }).conflicts.some((c) => c.type === 'teacher'))) types.push('teacher');
      if (exhausted && !picked.has(key) && !types.includes('hours')) types.push('hours');
      if (!types.length) continue;
      const uniq = [...new Set(types)];
      out.set(key, { types: uniq, reason: uniq.slice(0, 2).map(blockLabel).join(' · ') });
    }
  }
  return out;
}

// คำนวณครั้งเดียวต่อการเปลี่ยนตัวเลือก: จำผลล่าสุดตาม (state เดิม, กลุ่ม, วิชา, ครู, ห้อง) — state ใหม่หลัง op/โหลดใหม่ = คำนวณใหม่
let blockedMemo = null;
export function cachedBlockedCells(state, sel) {
  const k = [sel.groupId, sel.subjectId, sel.teacherId || '', sel.roomId || '', sel.picked && sel.picked.size ? [...sel.picked].sort().join(',') : ''].join('\u0000');
  if (blockedMemo && blockedMemo.state === state && blockedMemo.k === k) return blockedMemo.map;
  const map = blockedCells(state, sel);
  blockedMemo = { state, k, map };
  return map;
}
