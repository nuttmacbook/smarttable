// ตัวตรวจ/ทำความสะอาดข้อมูลร่วม (pure ไม่มี dependency ใช้ร่วมกับ api/ ได้) — W-02, W-03, W-10
//   validateId(id)   -> { ok, message? }   regex + ชื่อสงวนของ Object.prototype
//   isValidId(id)    -> boolean
//   sanitizeText(v, { max?, multiline? }) -> string   ตัดอักขระควบคุม/กำกับทิศทาง/zero-width, NFC, trim, ตัดความยาว
//   hasUnsafeChars(v) -> boolean   มีอักขระควบคุม/กำกับทิศทาง/zero-width หรือไม่ (ใช้ตรวจแทนการแก้เงียบ ๆ)
//   textIssues(v, { max, required }) -> string | null   ข้อความอธิบายปัญหา (ไทย) หรือ null ถ้าผ่าน

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ชื่อสงวนทั้งหมดของ Object.prototype (__proto__, constructor, toString, valueOf, hasOwnProperty, ... ที่มี)
export const RESERVED_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

export function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { ok: false, message: 'id ต้องเป็น A-Z a-z 0-9 _ - ยาว 1-64 ตัวอักษร' };
  }
  if (RESERVED_IDS.has(id)) return { ok: false, message: `id "${id}" เป็นชื่อสงวน ใช้ไม่ได้` };
  return { ok: true };
}
export const isValidId = (id) => validateId(id).ok;

// อักขระที่ไม่อนุญาต: C0/C1 control (ไม่รวม tab/LF/CR ที่จัดการแยก), zero-width + กำกับทิศทาง (200B-200F, 202A-202E, 2060-2069),
// line/paragraph separator (2028-2029), BOM (FEFF) — สร้างจากช่วงรหัสเพื่อไม่ต้องเขียนอักขระพิเศษตรง ๆ ในซอร์ส
const UNSAFE_RANGES = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff],
];
const hex = (n) => `\\u${n.toString(16).padStart(4, '0')}`;
const CLASS = UNSAFE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('');
const UNSAFE = new RegExp(`[${CLASS}]`, 'g');
const UNSAFE_TEST = new RegExp(`[${CLASS}]`);

export const hasUnsafeChars = (v) => typeof v === 'string' && UNSAFE_TEST.test(v);

export function sanitizeText(value, { max = 500, multiline = false } = {}) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  s = s.normalize('NFC').replace(UNSAFE, '');
  s = multiline ? s.replace(/\r\n?/g, '\n').replace(/\t/g, ' ') : s.replace(/[\t\r\n]+/g, ' ');
  s = s.trim();
  // ตัดตาม code point (ไม่ตัดกลางคู่ surrogate ของอีโมจิ/อักขระนอก BMP)
  if (s.length <= max) return s;
  const cps = Array.from(s);
  return cps.length <= max ? s : cps.slice(0, max).join('');
}

export function textIssues(value, { max = 500, required = false } = {}) {
  if (value === undefined || value === null || value === '') return required ? 'ต้องระบุข้อความ' : null;
  if (typeof value !== 'string') return 'ต้องเป็นข้อความ';
  if (value.trim() === '') return required ? 'ต้องระบุข้อความ' : null;
  if (hasUnsafeChars(value)) return 'มีอักขระควบคุมหรืออักขระกำกับทิศทางที่ไม่อนุญาต';
  if (value.length > max) return `ยาวเกิน ${max} ตัวอักษร`;
  return null;
}
