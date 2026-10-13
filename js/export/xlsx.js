// ส่งออก .xlsx (write-excel-file) — ตารางเรียน/สอน 1 ชีตต่อ 1 รายการ
// W-11: ทุกเซลล์ที่มาจากข้อมูลเป็น { type: String, format: '@' } เสมอ จึงไม่มี <f> (สูตร) แม้ขึ้นต้นด้วย = + - @
// ห้ามใช้ type 'Formula' ที่ไหนในโมดูลนี้
import { buildTimetables, sheetNamesFor, exportFileName, cellText, cleanText } from './model.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const BORDER = { borderColor: '#9ca3af', borderStyle: 'thin' };
const HEAD_BG = '#e0e7ff';

// เซลล์ข้อความ: บังคับเป็น string + format Text (@) + ตัดอักขระอันตราย (แต่คง \n ไว้ที่ช่องหลายบรรทัด)
export function textCell(value, style = {}) {
  const v = String(value ?? '')
    .split('\n')
    .map((line) => cleanText(line))
    .join('\n');
  return { value: v, type: String, format: '@', ...style };
}

function sheetFromTable(table) {
  const cols = table.columns;
  const width = cols.length + 1; // คอลัมน์แรก = วัน
  const filler = (n) => Array.from({ length: n }, () => null);
  const wide = (value, style) => [textCell(value, { columnSpan: width, ...style }), ...filler(width - 1)];

  const data = [];
  data.push(wide(table.title, { fontWeight: 'bold', fontSize: 16, align: 'center' }));
  if (table.subtitle) data.push(wide(table.subtitle, { align: 'center' }));
  for (const line of table.metaLines) data.push(wide(line, { align: 'center', textColor: '#4b5563' }));
  if (table.empty) data.push(wide(table.emptyText, { align: 'center', fontWeight: 'bold', textColor: '#b91c1c' }));
  data.push(filler(width));
  const headerRowIndex = data.length;

  const headStyle = { fontWeight: 'bold', align: 'center', alignVertical: 'center', wrap: true, backgroundColor: HEAD_BG, ...BORDER };
  data.push([
    textCell('วัน / คาบ', headStyle),
    ...cols.map((c) => (c.type === 'lunch'
      ? textCell(c.label, headStyle)
      : textCell(`${c.label}\n${c.time}`, headStyle))),
  ]);
  table.rows.forEach((row, ri) => {
    data.push([
      textCell(row.dayName, { fontWeight: 'bold', align: 'center', alignVertical: 'center', backgroundColor: HEAD_BG, ...BORDER, height: 62 }),
      ...row.cells.map((cell, ci) => {
        if (cell.lunch) {
          // พักเที่ยง: ผสานแนวตั้งทั้ง 5 วัน ข้อความอยู่แถวแรก
          if (ri === 0) return textCell('พักเที่ยง', { rowSpan: table.rows.length, align: 'center', alignVertical: 'center', backgroundColor: '#f3f4f6', textColor: '#6b7280', ...BORDER });
          return null;
        }
        const filled = cell.items.length > 0;
        return textCell(cellText(cell), { wrap: true, align: 'left', alignVertical: 'top', fontSize: 9, ...(filled ? { backgroundColor: '#f0fdf4' } : {}), ...BORDER });
      }),
    ]);
  });

  const columns = [{ width: 12 }, ...cols.map((c) => ({ width: c.type === 'lunch' ? 9 : 19 }))];
  return { data, columns, orientation: 'landscape', stickyRowsCount: headerRowIndex + 1, stickyColumnsCount: 1, showGridLines: false };
}

// โครงสร้างชีต (pure ไม่แตะไลบรารี) — ใช้ทดสอบได้
export function buildXlsxSheets(tables, { withKindPrefix = false } = {}) {
  const names = sheetNamesFor(tables, { withKindPrefix });
  return tables.map((t, i) => ({ sheet: names[i], ...sheetFromTable(t) }));
}

// เขียนสมุดงาน (หลายชีต) เป็น Blob — โหลดไลบรารีตอนเรียกจริงเท่านั้น
export async function writeWorkbook(sheets) {
  const { default: writeExcelFile } = await import('write-excel-file/universal');
  return writeExcelFile(sheets, { fontFamily: 'Tahoma', fontSize: 11 }).toBlob();
}

// state ที่ได้รับ = ข้อมูลที่ผู้เรียกมีสิทธิ์เห็นเท่านั้น (ผู้ดูอย่างเดียวได้ state ที่กรอง scope แล้ว)
export async function exportXlsx(state, scope, options = {}) {
  const tables = buildTimetables(state, scope, options);
  if (!tables.length) throw new Error('ไม่มีรายการให้ส่งออก');
  const sheets = buildXlsxSheets(tables, { withKindPrefix: scope.mode === 'everything' });
  const blob = await writeWorkbook(sheets);
  const fileName = exportFileName({ scope, ext: 'xlsx', date: options.printedAt ?? new Date() });
  return { blob, fileName, count: tables.length };
}
