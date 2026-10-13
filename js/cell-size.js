// คำนวณ "คลาสขนาดตัวอักษรในช่องตาราง" tt-fs-1..4 จากความยาวชื่อวิชา (SPEC v5 ข้อ 18, docs/design.md 10.2) — pure ไม่วัดพิกเซล
// เกณฑ์ (ตัวอักษรที่ "เห็นจริง" ของชื่อวิชา): ≤14 → 1 · ≤28 → 2 · ≤48 → 3 · เกิน → 4
// 1 = ปกติ (.8rem) · 2 = .72rem · 3 = .68rem · 4 = .64rem (ขั้นต่ำบนจอ) + ตัดบรรทัดด้วย CSS (line-clamp …) และ title เต็มบนจอ
export const FS_LIMITS = [14, 28, 48];

// นับความยาวที่เห็นจริง: ไม่นับวรรณยุกต์/สระบน-ล่าง (อักขระผสม) เพราะไม่กินความกว้าง
const COMBINING = /[ัิ-ฺ็-๎]/g;
export const visibleLength = (text) => String(text ?? '').normalize('NFC').replace(COMBINING, '').length;

export function fsLevel(title) {
  const len = visibleLength(title);
  for (let i = 0; i < FS_LIMITS.length; i += 1) if (len <= FS_LIMITS[i]) return i + 1;
  return 4;
}
export const fsClass = (title) => `tt-fs-${fsLevel(title)}`;

// ข้อความล้วนจาก HTML ของช่อง (ที่ผ่าน esc แล้ว): ตัดแท็ก ยุบช่องว่าง
export function plainFromHtml(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
// นับ entity เช่น &amp; เป็น 1 ตัว
export const entityFree = (s) => String(s ?? '').replace(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, '·');

// ชื่อวิชาในช่อง = ข้อความของ .tt-cell-title (ไม่รวมสัญลักษณ์ .tt-mark) ; ไม่มี title → ใช้ข้อความทั้งช่อง
export function titleTextOf(html) {
  const noMarks = String(html ?? '').replace(/<span class="tt-mark[^"]*"[^>]*>[\s\S]*?<\/span>/g, '');
  const m = /<span class="tt-cell-title">([\s\S]*?)<\/span>/.exec(noMarks);
  return entityFree(plainFromHtml(m ? m[1] : noMarks));
}
