// ค่าคงที่ของระบบตารางเรียนตารางสอน (ศธ.02 / สอศ.)

export const STATE_VERSION = 5;

export const DAYS = [
  { id: 1, name: 'จันทร์', short: 'จ' },
  { id: 2, name: 'อังคาร', short: 'อ' },
  { id: 3, name: 'พุธ', short: 'พ' },
  { id: 4, name: 'พฤหัสบดี', short: 'พฤ' },
  { id: 5, name: 'ศุกร์', short: 'ศ' },
];

export const PERIODS = [
  { id: 1, start: '08:00', end: '09:00' },
  { id: 2, start: '09:00', end: '10:00' },
  { id: 3, start: '10:00', end: '11:00' },
  { id: 4, start: '11:00', end: '12:00' },
  { id: 5, start: '13:00', end: '14:00' },
  { id: 6, start: '14:00', end: '15:00' },
  { id: 7, start: '15:00', end: '16:00' },
  { id: 8, start: '16:00', end: '17:00' },
  { id: 9, start: '17:00', end: '18:00' },
  { id: 10, start: '18:00', end: '19:00' },
  { id: 11, start: '19:00', end: '20:00' },
];

// พักเที่ยง: ไม่ใช่คาบ แสดงเป็นแถวคั่นต่อจากคาบ afterPeriod ลงวิชาไม่ได้
export const LUNCH = { id: 'lunch', start: '12:00', end: '13:00', afterPeriod: 4 };

export const SUBJECT_TYPES = [
  { id: 'general', name: 'วิชาสามัญ' },
  { id: 'vocational', name: 'วิชาชีพ' },
];

// ระดับ: แอดมินกำหนดเองได้ (state.levels, v5) — นี่คือค่าเริ่มต้นของระบบใหม่/ข้อมูลเก่าที่ migrate มาเท่านั้น
// ห้ามใช้เป็นรายการตรวจสอบ/ตัวเลือกใน UI (ใช้ state.levels) · ข้อจำกัดชื่อระดับดู isValidLevelName ใน store.js
export const DEFAULT_LEVELS = Object.freeze(['ปวช.1', 'ปวช.2', 'ปวช.3', 'ปวส.1', 'ปวส.2']);
export const MAX_LEVELS = 30;
export const LEVEL_NAME_MAX = 20;

export const dayName = (id) => DAYS.find((d) => d.id === id)?.name ?? String(id);
export const periodById = (id) => PERIODS.find((p) => p.id === id);
export const periodLabel = (id) => {
  const p = periodById(id);
  return p ? `คาบ ${p.id} (${p.start}-${p.end})` : `คาบ ${id}`;
};
export const subjectTypeName = (id) => SUBJECT_TYPES.find((t) => t.id === id)?.name ?? id;
