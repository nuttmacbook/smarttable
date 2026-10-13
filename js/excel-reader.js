// อ่านไฟล์ .xlsx → rows ต่อชีต ส่งให้ importRows/importWorkbook (js/importer.js) — ห่อ read-excel-file ไว้ที่เดียว
// ลำดับป้องกัน (W-10): checkXlsxFile (นามสกุล/ขนาด/PK) → guardXlsx (zip-guard: โครงสร้าง/มาโคร/zip bomb/dimension)
//                      → read-excel-file (dynamic import) → จำกัดแถว/ความยาวเซลล์ → importer
// read-excel-file รุ่น 9.x: ไม่มี export ราก ใช้ 'read-excel-file/browser' (ในเบราว์เซอร์) / '/node' (ทดสอบ)
//   ฟังก์ชัน default อ่านทุกชีต → [{ sheet, data:[[cell,…],…] }] (cell = string|number|boolean|Date)
// เปิดแอปแบบ static ไม่ผ่าน Vite จะ import ชื่อ package ไม่ได้ → แจ้งข้อความชัดเจน (ต้องใช้ผ่าน Vite)
import { IMPORT_SHEETS, IMPORT_LIMITS, checkXlsxFile } from './importer.js';
import { guardXlsx, ZIP_LIMITS } from './zip-guard.js';

const KNOWN = new Set(Object.values(IMPORT_SHEETS));
const problem = (message, extra = {}) => ({ level: 'error', message, ...extra });

// ค่าในเซลล์ → string|number|null (วันที่/ออบเจ็กต์ไม่รับ; ข้อความที่ขึ้นต้น = + - @ เก็บเป็นข้อความดิบ ไม่ใช่สูตร)
function normCell(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return null;
  return String(v).normalize('NFC');
}

async function loadLib() {
  try {
    return await import('read-excel-file/browser');
  } catch {
    return null;
  }
}

// file: File|Blob  คืน { ok, sheets:[{sheet,data}], problems:[{sheet?,row?,column?,level,message}], ignored:[ชื่อชีต] }
export async function readWorkbook(file, { lib } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pre = checkXlsxFile({ name: file.name, size: file.size, bytes });
  if (!pre.ok) return { ok: false, sheets: [], problems: [problem(pre.message)], ignored: [] };
  const guard = await guardXlsx(bytes, ZIP_LIMITS);
  if (!guard.ok) return { ok: false, sheets: [], problems: guard.problems.map((m) => problem(m)), ignored: [] };

  const mod = lib ?? (await loadLib());
  const readAll = mod?.default;
  if (typeof readAll !== 'function') {
    return { ok: false, sheets: [], problems: [problem('อ่านไฟล์ Excel ไม่ได้ในโหมดนี้ (ตัวอ่าน read-excel-file ใช้ได้เฉพาะเมื่อเปิดแอปผ่าน Vite) — แจ้งผู้ดูแลระบบ')], ignored: [] };
  }
  const problems = [];
  const sheets = [];
  const ignored = [];
  let all;
  try {
    all = await readAll(file);
  } catch {
    return { ok: false, sheets: [], problems: [problem('อ่านไฟล์ Excel ไม่ได้ (ไฟล์เสียหายหรือรูปแบบไม่รองรับ)')], ignored };
  }
  for (const { sheet: name, data: rows } of Array.isArray(all) ? all : []) {
    if (!KNOWN.has(name)) { ignored.push(name); continue; }
    if (!Array.isArray(rows)) { problems.push(problem('อ่านชีตนี้ไม่ได้', { sheet: name })); continue; }
    if (rows.length - 1 > IMPORT_LIMITS.maxRows) {
      problems.push(problem(`มี ${rows.length - 1} แถว เกินกำหนด ${IMPORT_LIMITS.maxRows} แถวต่อชีต`, { sheet: name }));
      continue;
    }
    const data = rows.map((row, ri) => (Array.isArray(row) ? row : []).map((cell, ci) => {
      const v = normCell(cell);
      if (typeof v === 'string' && v.length > ZIP_LIMITS.maxCellLength) {
        problems.push(problem(`ข้อความในเซลล์ยาวเกิน ${ZIP_LIMITS.maxCellLength} ตัวอักษร`, { sheet: name, row: ri + 1, column: String(ci + 1) }));
        return null;
      }
      return v;
    }));
    sheets.push({ sheet: name, data });
  }
  if (!sheets.length && !problems.length) {
    problems.push(problem(`ไม่พบชีตที่นำเข้าได้ ต้องมีอย่างน้อยหนึ่งชีตชื่อ: ${[...KNOWN].join(', ')}`));
  }
  return { ok: !problems.some((p) => p.level === 'error'), sheets, problems, ignored };
}
