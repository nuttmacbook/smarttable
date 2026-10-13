// โมเดลของแผงรายวิชาข้างตาราง (SPEC v4 ข้อ 9) — pure ไม่แตะ DOM ทดสอบใน node ได้
// แต่ละแถว: ต้องเรียน (hours) / จัดแล้ว / เหลือ / สถานะ ('todo' | 'partial' | 'done' | 'over')
// เรียง: เหลือ > 0 ก่อน (เหลือมาก→น้อย แล้วตามรหัส) · ครบ (done) ต่อท้าย · เกิน (over) อยู่ก่อนวิชาที่ครบ

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
