// ส่งออก .pdf (pdfmake) — 1 หน้า A4 แนวนอนต่อ 1 รายการ ฝังฟอนต์ Sarabun (OFL)
// การจัดหน้าทั้งหมดคำนวณใน pdf-layout.js (เมตริกฟอนต์จริง, ลดขนาดตัวอักษร ≥ 6pt, ตัด …, legend ชื่อเต็ม, ลายขาวดำ)
// ที่นี่แปลง scene เป็น docDefinition แบบพิกัดสัมบูรณ์ (canvas + ข้อความทีละบรรทัด) แล้วเรนเดอร์
// ฟอนต์จาก @fontsource/sarabun เป็น woff แยกชุดย่อย thai / latin จึงแบ่งข้อความเป็นช่วงตามสคริปต์
// (U+0E00–0E7F = thai, อื่น ๆ = latin) แล้วกำหนด font ต่อช่วง; สระ/วรรณยุกต์ติดกับพยัญชนะอยู่ในช่วง thai เดียวกันเสมอ
// pdfmake โหลดแบบ dynamic import เฉพาะตอนส่งออก
import { buildTimetables, exportFileName, cleanText } from './model.js';
import { layoutTablePage, layoutLegendContinuation, PAGE } from './pdf-layout.js';

export const PDF_MIME = 'application/pdf';
export const FONT_FILES = {
  SarabunLatin: { normal: 'sarabun-latin-400-normal.woff', bold: 'sarabun-latin-700-normal.woff' },
  SarabunThai: { normal: 'sarabun-thai-400-normal.woff', bold: 'sarabun-thai-700-normal.woff' },
};

const THAI = /[฀-๿]/;

// แบ่งข้อความเป็นช่วงตามชุดฟอนต์ → [{ text, font }]
export function splitScripts(text) {
  const out = [];
  for (const ch of String(text ?? '')) {
    const font = THAI.test(ch) ? 'SarabunThai' : 'SarabunLatin';
    const last = out[out.length - 1];
    if (last && last.font === font) last.text += ch;
    else out.push({ text: ch, font });
  }
  return out;
}

// scene ทุกหน้าของชุดตาราง (รวมหน้าต่อของ legend ถ้ารายการที่ถูกตัดมากเกิน) — pure ใช้วัด/ทดสอบได้
export function buildPdfScenes(tables) {
  const scenes = [];
  for (const table of tables) {
    const page = layoutTablePage(table);
    scenes.push({ ...page, table });
    let rest = page.overflowLegend;
    let n = page.truncated.length - rest.length;
    let guard = 20;
    while (rest.length && guard-- > 0) {
      const cont = layoutLegendContinuation(table.title, rest, n + 1);
      scenes.push({ ...cont, table, continuation: true });
      n += rest.length - cont.overflowLegend.length;
      rest = cont.overflowLegend;
    }
  }
  return scenes;
}

const textNode = (tx) => ({
  text: splitScripts(cleanText(tx.text)).map((r) => ({ text: r.text, font: r.font })),
  absolutePosition: { x: Math.round(tx.x * 100) / 100, y: Math.round(tx.y * 100) / 100 },
  fontSize: tx.size,
  bold: tx.bold,
  color: tx.color,
  noWrap: true,
  lineHeight: 1,
});

function canvasOf(scene) {
  const items = [];
  for (const r of scene.rects) {
    items.push({
      type: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, lineWidth: r.lw,
      ...(r.fill ? { color: r.fill } : {}), ...(r.stroke ? { lineColor: r.stroke } : {}),
    });
  }
  for (const l of scene.lines) items.push({ type: 'line', x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, lineWidth: l.lw, lineColor: l.color });
  for (const e of scene.ellipses) {
    items.push({ type: 'ellipse', x: e.cx, y: e.cy, r1: e.r, r2: e.r, lineWidth: e.lw, ...(e.fill ? { color: e.fill } : {}), ...(e.stroke ? { lineColor: e.stroke } : {}) });
  }
  return items;
}

// docDefinition ของ pdfmake (pure — ไม่โหลดไลบรารี ใช้ทดสอบโครงสร้างได้)
export function buildPdfDocDefinition(tables, scenes = buildPdfScenes(tables)) {
  const content = [];
  scenes.forEach((scene, i) => {
    if (i > 0) content.push({ text: ' ', fontSize: 1, lineHeight: 0.1, pageBreak: 'before' });
    content.push({ canvas: canvasOf(scene), absolutePosition: { x: 0, y: 0 } });
    scene.texts.forEach((tx) => content.push(textNode(tx)));
  });
  const m = PAGE.margin;
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [m, m, m, m],
    info: { title: tables.length === 1 ? tables[0].title : 'ตารางเรียนตารางสอน', creator: 'ระบบจัดตารางเรียนตารางสอน' },
    defaultStyle: { font: 'SarabunLatin', fontSize: 8 },
    content,
  };
}

export const fontDescriptors = (base) => Object.fromEntries(
  Object.entries(FONT_FILES).map(([family, f]) => [family, { normal: `${base}${f.normal}`, bold: `${base}${f.bold}`, italics: `${base}${f.normal}`, bolditalics: `${base}${f.bold}` }]),
);

const defaultFontBase = () => {
  const b = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) || '/';
  return `${b.endsWith('/') ? b : `${b}/`}fonts/`;
};

// แปลงเอกสารเป็น Blob (เบราว์เซอร์: getBlob; node: getBuffer)
export async function renderPdf(docDefinition, { engine, fontBase } = {}) {
  const pdfMake = engine ?? (await import('pdfmake/build/pdfmake.js')).default;
  pdfMake.setFonts(fontDescriptors(fontBase ?? defaultFontBase()));
  const doc = pdfMake.createPdf(docDefinition);
  if (typeof doc.getBlob === 'function') return doc.getBlob();
  const buf = await doc.getBuffer();
  return new Blob([buf], { type: PDF_MIME });
}

// state ที่ได้รับ = ข้อมูลที่ผู้เรียกมีสิทธิ์เห็นเท่านั้น
export async function exportPdf(state, scope, options = {}, deps = {}) {
  const tables = buildTimetables(state, scope, options);
  if (!tables.length) throw new Error('ไม่มีรายการให้ส่งออก');
  const blob = await renderPdf(buildPdfDocDefinition(tables), deps);
  const fileName = exportFileName({ scope, ext: 'pdf', date: options.printedAt ?? new Date() });
  return { blob, fileName, count: tables.length };
}
