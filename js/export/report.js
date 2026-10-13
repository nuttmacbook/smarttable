// รายงานผลนำเข้า (ImportReport) เป็น .xlsx — ข้อความจากข้อมูลผู้ใช้เป็น string ทั้งหมด (W-11)
import { textCell, writeWorkbook } from './xlsx.js';
import { formatFileDate } from './model.js';
import { dayName, periodLabel } from '../constants.js';

const LEVEL_TEXT = { error: 'ผิดพลาด', warning: 'เตือน', info: 'ข้อมูล' };
const LEVEL_COLOR = { error: '#fee2e2', warning: '#fef3c7', info: '#e0f2fe' };
const HEAD = { fontWeight: 'bold', backgroundColor: '#e0e7ff', borderColor: '#9ca3af', borderStyle: 'thin', alignVertical: 'center', wrap: true };
const BODY = { borderColor: '#d1d5db', borderStyle: 'thin', alignVertical: 'top', wrap: true };
const numCell = (n, style = {}) => ({ value: Number.isFinite(Number(n)) ? Number(n) : 0, type: Number, align: 'right', ...BODY, ...style });

export function buildReportSheets(report = {}) {
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const count = (lv) => rows.filter((r) => r.level === lv).length;

  const sum = [
    [textCell('รายงานผลการนำเข้า Excel', { fontWeight: 'bold', fontSize: 14 })],
    [textCell(report.ok ? 'ผลรวม: ผ่าน (นำเข้าได้)' : 'ผลรวม: ไม่ผ่าน (มีข้อผิดพลาด ไม่มีการนำเข้า)', { fontWeight: 'bold', textColor: report.ok ? '#166534' : '#b91c1c' })],
    [textCell(`ผิดพลาด ${count('error')} · เตือน ${count('warning')} · ข้อมูล ${count('info')}`)],
    [],
    ['ชีต', 'เพิ่มใหม่', 'อัปเดต', 'ข้าม'].map((h) => textCell(h, HEAD)),
    ...Object.entries(summary).map(([name, s]) => [textCell(name, BODY), numCell(s?.add), numCell(s?.update), numCell(s?.skip)]),
  ];

  const detail = [
    ['ระดับ', 'ชีต', 'แถว', 'คอลัมน์', 'ข้อความ'].map((h) => textCell(h, HEAD)),
    ...rows.map((r) => [
      textCell(LEVEL_TEXT[r.level] ?? r.level, { ...BODY, backgroundColor: LEVEL_COLOR[r.level] ?? '#ffffff', fontWeight: 'bold' }),
      textCell(r.sheet, BODY),
      // แถว 0 = ภาพรวมทั้งไฟล์ (ไม่ใช่แถวใดแถวหนึ่ง)
      r.row > 0 ? numCell(r.row) : textCell('-', { ...BODY, align: 'center' }),
      textCell(r.column ?? '', BODY),
      textCell(r.message, BODY),
    ]),
  ];
  if (!rows.length) detail.push([textCell('ไม่มีรายการ', BODY)]);

  const sheets = [
    { sheet: 'สรุป', data: sum, columns: [{ width: 30 }, { width: 14 }, { width: 14 }, { width: 14 }] },
    { sheet: 'รายการ', data: detail, columns: [{ width: 12 }, { width: 16 }, { width: 8 }, { width: 22 }, { width: 80 }], stickyRowsCount: 1 },
  ];

  const trimmed = Array.isArray(report.trimmed) ? report.trimmed : [];
  if (trimmed.length) {
    sheets.push({
      sheet: 'คาบที่ถูกตัด',
      data: [
        ['กลุ่มเรียน', 'รหัสวิชา', 'ชื่อวิชา', 'วัน', 'คาบ'].map((h) => textCell(h, HEAD)),
        ...trimmed.map((t) => [
          textCell(t.groupName, BODY), textCell(t.subjectCode, BODY), textCell(t.subjectName, BODY),
          textCell(dayName(t.day), BODY), textCell(periodLabel(t.period), BODY),
        ]),
      ],
      columns: [{ width: 16 }, { width: 14 }, { width: 36 }, { width: 14 }, { width: 24 }],
      stickyRowsCount: 1,
    });
  }
  return sheets;
}

export async function buildImportReportXlsx(report, { date = new Date() } = {}) {
  const blob = await writeWorkbook(buildReportSheets(report));
  return { blob, fileName: `รายงานนำเข้า-${formatFileDate(date)}.xlsx` };
}
