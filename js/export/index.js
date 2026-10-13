// จุดเข้าเดียวของโมดูลส่งออก — UI เรียก const ex = await import('./export/index.js')
// xlsx / pdf / template / report โหลดเมื่อเรียกใช้จริง (pdfmake และ write-excel-file ไม่เข้า bundle หลัก)
export { KINDS, listItems, resolveScope, buildTimetable, buildTimetables, kindName, EMPTY_TEXT } from './model.js';

// คืน { blob, fileName, count }
export async function exportXlsx(state, scope, options) {
  return (await import('./xlsx.js')).exportXlsx(state, scope, options);
}
// deps = { engine?, fontBase? } (ใช้ในเทสต์/node; เบราว์เซอร์ไม่ต้องส่ง)
export async function exportPdf(state, scope, options, deps) {
  return (await import('./pdf.js')).exportPdf(state, scope, options, deps);
}
// คืน { blob, fileName }
export async function downloadTemplate(options) {
  return (await import('./template.js')).downloadTemplate(options);
}
export async function buildImportReportXlsx(report, options) {
  return (await import('./report.js')).buildImportReportXlsx(report, options);
}
