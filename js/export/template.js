// เทมเพลตนำเข้า Excel (SPEC v4 ข้อ 5.2) — ชีตและหัวคอลัมน์ตรงกับ IMPORT_SHEETS / IMPORT_COLUMNS ของ importer
// ชีตข้อมูลมีเฉพาะแถวหัว (ไม่ใส่แถวตัวอย่าง กันถูกนำเข้าเป็นข้อมูลจริงโดยไม่ตั้งใจ)
// ตัวอย่างและหมายเหตุอยู่ที่ชีต "วิธีใช้" (importer ข้ามชีตนี้ และรายงานเป็น info)
import { IMPORT_COLUMNS, IMPORT_SHEETS } from '../importer.js';
import { textCell, writeWorkbook } from './xlsx.js';
import { formatFileDate } from './model.js';

export const HELP_SHEET = 'วิธีใช้';

// ช่องที่จำเป็น (*) ตาม SPEC ข้อ 5.2
const REQUIRED = {
  'รายวิชา': ['รหัสวิชา', 'ชื่อวิชา', 'ประเภท', 'ระดับที่เปิดสอน'],
  'ครูผู้สอน': ['ชื่อครู'],
  'ห้องเรียน': ['ชื่อห้องเรียน'],
  'กลุ่มเรียน': ['ชื่อกลุ่มเรียน', 'ระดับ'],
  'แผนการเรียน': ['ชื่อแผน', 'ระดับ', 'รหัสวิชา'],
};

// ตัวอย่างแถว (แสดงในชีต "วิธีใช้" เท่านั้น)
const EXAMPLES = {
  'รายวิชา': ['20901-2001', 'คอมพิวเตอร์และสารสนเทศเบื้องต้น', 'วิชาชีพ', '1', '2', '', '2', 'ปวช.1,ปวช.2', 'สมชาย ใจดี,สมหญิง รักเรียน', ''],
  'ครูผู้สอน': ['สมชาย ใจดี', 'เทคโนโลยีสารสนเทศ'],
  'ห้องเรียน': ['ห้องปฏิบัติการคอมพิวเตอร์ 1', 'อาคาร 5', '30', ''],
  'กลุ่มเรียน': ['ปวช.1/1', 'ปวช.1', 'เทคโนโลยีสารสนเทศ', 'แผนปวช.1 เทคโนโลยีสารสนเทศ', '20000-1101'],
  'แผนการเรียน': ['แผนปวช.1 เทคโนโลยีสารสนเทศ', 'ปวช.1', '20901-2001,20000-1101', ''],
};

const NOTES = [
  'ชีตที่ไม่ต้องการนำเข้า ลบหรือปล่อยว่างได้ (ชีตที่ไม่มีจะถูกข้าม) · แถวแรกของแต่ละชีตคือหัวคอลัมน์ อย่าแก้ชื่อชีตหรือหัวคอลัมน์',
  'หัวคอลัมน์ที่มี * คือช่องที่จำเป็น · แถวว่างทั้งแถวจะถูกข้าม · ช่องว่างหัวท้ายถูกตัดอัตโนมัติ',
  'ตัวเลขต้องเป็นจำนวนเต็ม ≥ 0 (ชม./สัปดาห์ ≥ 1) · ชม./สัปดาห์ ถ้าว่าง = ท + ป',
  'ประเภทวิชา: สามัญ หรือ วิชาชีพ · ระดับ: ปวช.1 ปวช.2 ปวช.3 ปวส.1 ปวส.2 · หลายค่าคั่นด้วย , เช่น ปวช.1,ปวช.2',
  'การรวมข้อมูล: จับคู่ด้วยคีย์ (รหัสวิชา / ชื่อครู / ชื่อห้องเรียน / ชื่อกลุ่มเรียน / ชื่อแผน) ตรง = อัปเดตฟิลด์ที่กรอก (ว่าง = ไม่ทับ) ไม่ตรง = เพิ่มใหม่ · ไม่มีการลบข้อมูล',
  'ไฟล์ต้องเป็น .xlsx ขนาดไม่เกิน 5 MB และไม่เกิน 5,000 แถวต่อชีต · ระบบจะแสดงรายงานก่อนยืนยันการนำเข้า',
];

export function buildTemplateSheets() {
  const sheets = [];
  const headStyle = { fontWeight: 'bold', backgroundColor: '#e0e7ff', borderColor: '#9ca3af', borderStyle: 'thin', alignVertical: 'center' };
  const headers = (name) => IMPORT_COLUMNS[name].map((c) => textCell(REQUIRED[name]?.includes(c) ? `${c}*` : c, headStyle));
  for (const name of Object.values(IMPORT_SHEETS)) {
    sheets.push({
      sheet: name,
      data: [headers(name)],
      columns: IMPORT_COLUMNS[name].map((c) => ({ width: Math.max(14, Math.min(34, c.length * 2 + 8)) })),
      stickyRowsCount: 1,
    });
  }

  const help = [[textCell('วิธีใช้เทมเพลตนำเข้า', { fontWeight: 'bold', fontSize: 14 })], []];
  NOTES.forEach((n, i) => help.push([textCell(`${i + 1}. ${n}`)]));
  help.push([]);
  help.push([textCell('ตัวอย่างข้อมูลแต่ละชีต (เฉพาะดูประกอบ ไม่ถูกนำเข้า)', { fontWeight: 'bold', fontSize: 12 })]);
  for (const name of Object.values(IMPORT_SHEETS)) {
    help.push([]);
    help.push([textCell(`ชีต "${name}"`, { fontWeight: 'bold' })]);
    help.push(headers(name));
    help.push(EXAMPLES[name].map((v) => textCell(v)));
  }
  sheets.push({ sheet: HELP_SHEET, data: help, columns: Array.from({ length: 10 }, () => ({ width: 24 })) });
  return sheets;
}

export async function downloadTemplate({ date = new Date() } = {}) {
  const blob = await writeWorkbook(buildTemplateSheets());
  return { blob, fileName: `เทมเพลตนำเข้า-ตารางเรียนตารางสอน-${formatFileDate(date)}.xlsx` };
}
