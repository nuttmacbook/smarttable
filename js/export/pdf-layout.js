// จัดหน้า PDF แบบคำนวณเอง (pure ไม่ใช้ pdfmake/DOM) — SPEC v5 ข้อ 18
// ทุกรายการ = 1 หน้า A4 แนวนอน margin ≤ 8 mm; ขนาดฟอนต์ต่อช่องคำนวณจากเมตริกจริงของ Sarabun
// (js/export/font-metrics.js สร้างจากไฟล์ฟอนต์ที่ฝัง) ลดได้ถึง MIN_FONT แล้วตัดบรรทัด + "…" และใส่ "ชื่อเต็ม" ใน legend
// ผลลัพธ์ = scene { width, height, rects, lines, ellipses, texts } พิกัดหน่วย pt จากมุมซ้ายบนของหน้า
import { FONT_METRICS } from './font-metrics.js';

export const PAGE = { width: 841.89, height: 595.28, margin: 22 }; // 22pt ≈ 7.8 mm
export const MIN_FONT = 6;
export const FONT_STEPS = [8.5, 8, 7.5, 7, 6.5, 6];
export const LINE_FACTOR = 1.22;
const ASC = 1.068; // ascender ของ Sarabun (หน่วย em) ใช้หาตำแหน่ง baseline
const SAFETY = 1.015; // เผื่อความคลาดเคลื่อนของการวัดกับการเรนเดอร์จริง

// สไตล์ของแต่ละชนิดช่อง (ตรงกับ docs/design.md ข้อ 10.1 ของมิ้นท์: ความต่างความสว่าง + ลาย + ตัวหนา + สัญลักษณ์ ส/ช/ร)
export const STYLE = {
  ink: '#000000',
  grid: '#333333',
  head: '#e3e6ec',
  day: '#eef0f4',
  empty: '#ffffff',
  general: { fill: '#e6edf7', mark: 'ส' },
  vocational: { fill: '#b9c3d6', hatch: { angle: 135, gap: 4.6, color: '#566176', width: 0.3 }, mark: 'ช', bold: true },
  merged: { mark: 'ร' },
  lunch: { fill: '#d2d5db', hatch: { angle: 45, gap: 2.4, color: '#566176', width: 0.3 } },
};

// ---------- เมตริกข้อความ ----------
const MAPS = {};
function metric(key) {
  if (!MAPS[key]) {
    const { upm, w } = FONT_METRICS[key];
    MAPS[key] = { upm, adv: new Map(w.split(',').map((p) => { const [c, a] = p.split(':'); return [parseInt(c, 16), Number(a)]; })) };
  }
  return MAPS[key];
}
const THAI = /[฀-๿]/;
const MARK = /[ัิ-ฺ็-๎]/;
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;

export function textWidth(text, size, bold = false) {
  const w = bold ? 700 : 400;
  let units = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const primary = metric(`${cp >= 0xe00 && cp <= 0xe7f ? 'thai' : 'latin'}${w}`);
    let a = primary.adv.get(cp);
    if (a === undefined) a = metric(`${cp >= 0xe00 && cp <= 0xe7f ? 'latin' : 'thai'}${w}`).adv.get(cp);
    units += (a === undefined ? 550 : a) / primary.upm;
  }
  return units * size * SAFETY;
}

// พยัญชนะ + สระ/วรรณยุกต์ที่ติดกัน = 1 กลุ่ม (ห้ามตัดกลาง)
export function clusters(text) {
  const out = [];
  for (const ch of String(text)) {
    if (MARK.test(ch) && out.length) out[out.length - 1] += ch;
    else out.push(ch);
  }
  return out;
}

// จุดที่ตัดบรรทัดได้: ช่องว่าง + ขอบคำไทยตาม Intl.Segmenter (ไม่มี Segmenter → ตัดได้ทุกกลุ่มอักษรไทย)
function tokens(text) {
  const out = [];
  for (const piece of String(text).split(/(\s+)/)) {
    if (!piece) continue;
    if (/^\s+$/.test(piece)) out.push(' ');
    else if (THAI.test(piece)) {
      // ตัดได้เฉพาะระหว่าง "คำไทย" สองคำติดกัน; เลข/เครื่องหมาย (เช่น ปวช.1/2) ติดกับคำก่อนหน้า ไม่ถูกฉีก
      const segs = segmenter ? Array.from(segmenter.segment(piece), (s) => s.segment) : clusters(piece);
      for (const s of segs) {
        if (THAI.test(s) && out.length && THAI.test(out[out.length - 1]) && out[out.length - 1] !== ' ') out.push(s);
        else if (out.length && out[out.length - 1] !== ' ') out[out.length - 1] += s;
        else out.push(s);
      }
    } else out.push(piece);
  }
  return out;
}

// widthFn(i) = ความกว้างบรรทัดที่ i; คืนบรรทัดที่ไม่มีช่องว่างหัวท้าย
export function wrapText(text, size, bold, widthFn) {
  const lines = [];
  let cur = '';
  let space = false;
  const w = () => widthFn(lines.length);
  const flush = () => { lines.push(cur); cur = ''; };
  for (const tok of tokens(text)) {
    if (tok === ' ') { space = cur !== ''; continue; }
    const cand = cur ? (space ? `${cur} ${tok}` : cur + tok) : tok;
    space = false;
    if (textWidth(cand, size, bold) <= w()) { cur = cand; continue; }
    if (cur) flush();
    if (textWidth(tok, size, bold) <= w()) { cur = tok; continue; }
    for (const c of clusters(tok)) { // คำเดียวยาวเกินบรรทัด → ตัดตามกลุ่มอักษร
      if (cur && textWidth(cur + c, size, bold) > w()) flush();
      cur += c;
    }
  }
  if (cur) flush();
  return lines.length ? lines : [''];
}

export function ellipsize(line, size, bold, width) {
  const cs = clusters(line.replace(/\s+$/, ''));
  while (cs.length && textWidth(`${cs.join('')}…`, size, bold) > width) cs.pop();
  return `${cs.join('').replace(/\s+$/, '')}…`;
}

// ตัดเหลือ maxLines บรรทัด (บรรทัดสุดท้ายลงท้าย …)
export function fitLines(text, size, bold, widthFn, maxLines) {
  const lines = wrapText(text, size, bold, widthFn);
  if (lines.length <= maxLines) return { lines, truncated: false };
  if (maxLines <= 0) return { lines: [], truncated: true };
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(kept[maxLines - 1], size, bold, widthFn(maxLines - 1));
  return { lines: kept, truncated: true };
}

// ---------- จัดเนื้อหาในช่องเดียว ----------
function itemParagraphs(item) {
  const head = [item.code, item.name].filter(Boolean).join(' ');
  const paras = [{ text: head, bold: item.type === 'vocational', kind: 'head' }];
  for (const line of item.info) paras.push({ text: line, bold: false, kind: 'info' });
  if (item.merged) paras.push({ text: item.mergedGroups.length ? `เรียนรวม: ${item.mergedGroups.join(', ')}` : 'เรียนรวม', bold: true, kind: 'tag' });
  return paras;
}

// คืน { size, truncated, blocks:[{y(offset), size, bold, text}], fullTexts:[legend] }
export function layoutCellText(items, innerW, innerH, markW) {
  const widthFor = (first) => (i) => (first && i === 0 ? innerW - markW : innerW);
  const blocksFor = (size, budgets) => {
    const out = [];
    let y = 0;
    let truncated = false;
    items.forEach((item, ii) => {
      let paras = itemParagraphs(item);
      const budget = budgets ? budgets[ii] : Infinity;
      let wrapped = paras.map((p, pi) => wrapText(p.text, size, p.bold, widthFor(ii === 0 && pi === 0)));
      if (budgets) {
        // เกินงบบรรทัด: ลดย่อหน้าที่ยาวสุดทีละบรรทัด ถ้าทุกย่อหน้าเหลือ 1 บรรทัดแล้วยังเกิน → ตัดย่อหน้าท้าย (ป้าย/ข้อมูลรอง) ทิ้ง
        const alloc = wrapped.map((w) => w.length);
        let guard = 200;
        while (alloc.reduce((a, b) => a + b, 0) > budget && guard-- > 0) {
          let idx = -1;
          alloc.forEach((n, i) => { if (n > 1 && (idx < 0 || n > alloc[idx])) idx = i; });
          if (idx >= 0) { alloc[idx] -= 1; continue; }
          if (alloc.length > 1) { alloc.pop(); paras = paras.slice(0, alloc.length); wrapped = wrapped.slice(0, alloc.length); truncated = true; } else break;
        }
        wrapped = paras.map((p, pi) => {
          const r = fitLines(p.text, size, p.bold, widthFor(ii === 0 && pi === 0), alloc[pi]);
          if (r.truncated) truncated = true;
          return r.lines;
        });
      }
      paras.forEach((p, pi) => wrapped[pi].forEach((text) => { out.push({ y, size, bold: p.bold, text }); y += size * LINE_FACTOR; }));
      if (ii < items.length - 1) y += size * 0.35;
    });
    return { blocks: out, height: y, truncated };
  };

  for (const size of FONT_STEPS) {
    const r = blocksFor(size, null);
    if (r.height <= innerH + 0.01) return { size, truncated: false, blocks: r.blocks };
  }
  const size = MIN_FONT;
  const lh = size * LINE_FACTOR;
  const total = Math.max(items.length, Math.floor((innerH + 0.01) / lh));
  const per = Math.max(1, Math.floor((total - (items.length - 1) * 0.35 / LINE_FACTOR) / items.length));
  const r = blocksFor(size, items.map(() => per));
  return { size, truncated: true, blocks: r.blocks };
}

// legend ต่อวิชา: รหัส + ชื่อเต็ม + ข้อมูลประกอบ (ครู/ห้อง/กลุ่ม) ที่พบทุกช่องของวิชานั้น ไม่ซ้ำ
export function legendEntriesOf(items) {
  const by = new Map();
  for (const it of items) {
    const key = [it.code, it.name].filter(Boolean).join(' ');
    const e = by.get(key) ?? { key, info: new Set() };
    it.info.forEach((l) => e.info.add(l));
    if (it.merged && it.mergedGroups.length) e.info.add(`เรียนรวม: ${it.mergedGroups.join(', ')}`);
    by.set(key, e);
  }
  return [...by.values()].map((e) => [e.key, ...e.info].join(' · '));
}

// บรรทัดเดียวที่ต้องไม่ล้นความกว้าง (หัวกระดาษ): ลดขนาดลงถึง minSize แล้วตัดด้วย … → { text, size }
export function fitSingleLine(str, size, minSize, bold, maxW) {
  let s = size;
  while (s > minSize && textWidth(str, s, bold) > maxW) s = Math.max(minSize, s - 0.5);
  return { text: textWidth(str, s, bold) > maxW ? ellipsize(str, s, bold, maxW) : str, size: s };
}

// ---------- ลาย ----------
function hatchLines(x, y, w, h, { angle, gap }, push) {
  if (angle === 45) { // "/"  : x + y = c
    for (let c = x + y + gap; c < x + w + y + h; c += gap) {
      const xs = Math.max(x, c - (y + h));
      const xe = Math.min(x + w, c - y);
      if (xs < xe) push(xs, c - xs, xe, c - xe);
    }
  } else { // "\" : x - y = c
    for (let c = x - (y + h) + gap; c < x + w - y; c += gap) {
      const xs = Math.max(x, c + y);
      const xe = Math.min(x + w, c + y + h);
      if (xs < xe) push(xs, xs - c, xe, xe - c);
    }
  }
}

const kindOfCell = (cell) => {
  if (!cell.items.length) return 'empty';
  if (cell.items.some((i) => i.merged)) return 'merged';
  return cell.items.some((i) => i.type === 'vocational') ? 'vocational' : 'general';
};

// ---------- จัดทั้งหน้า ----------
export function layoutTablePage(table, { maxLegendHeight = 112 } = {}) {
  const { width: W, height: H, margin: M } = PAGE;
  const scene = { width: W, height: H, rects: [], lines: [], ellipses: [], texts: [], cells: [], truncated: [], overflowLegend: [] };
  const rect = (x, y, w, h, o = {}) => scene.rects.push({ x, y, w, h, fill: o.fill ?? null, stroke: o.stroke ?? null, lw: o.lw ?? 0.6 });
  const line = (x1, y1, x2, y2, color, lw) => scene.lines.push({ x1, y1, x2, y2, color, lw });
  const text = (str, x, baseline, size, bold, color = STYLE.ink, align = 'left', width = 0) => {
    const tw = textWidth(str, size, bold);
    const px = align === 'center' ? x + (width - tw) / 2 : align === 'right' ? x + width - tw : x;
    scene.texts.push({ text: str, x: px, y: baseline - ASC * size, size, bold, color, width: tw });
  };

  const x0 = M;
  const CW = W - 2 * M;

  // หัวกระดาษ
  // ชื่อรายการ/บรรทัดย่อยที่ยาวมาก: ลดขนาดแล้วตัด … ให้อยู่ในความกว้างหน้าเสมอ
  const ttl = fitSingleLine(table.title, 15, 10, true, CW - 4);
  text(ttl.text, x0, M + 15 * 1.0, ttl.size, true, STYLE.ink, 'center', CW);
  const sub = fitSingleLine([table.subtitle, ...table.metaLines].filter(Boolean).join('   ·   '), 8.5, 6.5, false, CW - 4);
  text(sub.text, x0, M + 15 + 11.5, sub.size, false, '#222222', 'center', CW);
  const gridTop = M + 33;

  // legend ชื่อเต็ม (เฉพาะช่องที่ถูกตัด) — วัดก่อนเพื่อกันที่ให้ตาราง
  const periodCols = table.columns.filter((c) => c.type === 'period').length;
  const dayW = 38;
  const lunchW = 24;
  const colW = (CW - dayW - lunchW) / Math.max(1, periodCols);
  const padX = 2.2;
  const padTop = 2;
  const padBottom = 1.5;
  const headH = 24;
  const symbolH = 13;

  // ผ่านที่ 1: จัดข้อความทุกช่องด้วยความสูงช่องสมมติ (ให้รู้ว่าช่องไหนถูกตัด) — ใช้ความสูงแถวสูงสุดก่อน แล้วค่อยคำนวณจริงอีกรอบ
  const buildCells = (rowH) => {
    const cells = [];
    const truncatedItems = [];
    table.rows.forEach((row, ri) => {
      let cx = x0 + dayW;
      const y = gridTop + headH + ri * rowH;
      row.cells.forEach((cell, ci) => {
        const col = table.columns[ci];
        const w = col.type === 'lunch' ? lunchW : colW;
        if (col.type === 'period') {
          const kind = kindOfCell(cell);
          const markW = kind === 'empty' ? 0 : 11;
          const inset = kind === 'merged' ? 2.4 : 0;
          const lay = kind === 'empty' ? null : layoutCellText(cell.items, w - 2 * padX - 2 * inset, rowH - padTop - padBottom - 2 * inset, markW);
          cells.push({ ri, ci, x: cx, y, w, h: rowH, kind, cell, lay, inset });
          if (lay?.truncated) cell.items.forEach((it) => truncatedItems.push(it));
        }
        cx += w;
      });
    });
    return { cells, truncatedItems };
  };

  const maxRowH = 96;
  const bottomLimit = H - M - symbolH - 3;
  let rowH = Math.min(maxRowH, (bottomLimit - gridTop - headH) / 5);
  let { cells, truncatedItems } = buildCells(rowH);
  let legendEntries = legendEntriesOf(truncatedItems);
  let legendLayout = null;
  const legendSize = 6.5;
  const legendLh = legendSize * LINE_FACTOR;
  const layoutLegend = (avail) => {
    const colWidth = (CW - 10) / 2;
    const rowsPerCol = Math.max(1, Math.floor((avail - 11) / legendLh));
    const cols = [[], []];
    const used = [0, 0];
    const overflow = [];
    legendEntries.forEach((entry, i) => {
      const lines = wrapText(`${i + 1}. ${entry}`, legendSize, false, () => colWidth);
      const c = used[0] + lines.length <= rowsPerCol ? 0 : used[1] + lines.length <= rowsPerCol ? 1 : -1;
      if (c < 0) overflow.push(entry);
      else { cols[c].push({ lines }); used[c] += lines.length; }
    });
    return { cols, colWidth, rows: Math.max(used[0], used[1]), overflow };
  };

  if (legendEntries.length) {
    // กันที่ legend ตามที่ต้องใช้จริง (ไม่เกิน maxLegendHeight) แล้วจัดข้อความช่องใหม่ตามความสูงแถวที่ลดลง
    for (let pass = 0; pass < 3; pass += 1) {
      const need = layoutLegend(maxLegendHeight);
      const legendH = Math.min(maxLegendHeight, 11 + need.rows * legendLh + 3);
      rowH = Math.min(maxRowH, (bottomLimit - legendH - 3 - gridTop - headH) / 5);
      ({ cells, truncatedItems } = buildCells(rowH));
      legendEntries = legendEntriesOf(truncatedItems);
      legendLayout = { ...layoutLegend(legendH), height: legendH };
    }
    scene.overflowLegend = legendLayout.overflow;
  }
  const gridBottom = gridTop + headH + 5 * rowH;

  // พื้นหลังหัวตาราง + คอลัมน์วัน
  rect(x0, gridTop, dayW, headH, { fill: STYLE.head, stroke: STYLE.grid });
  text('วัน / คาบ', x0, gridTop + 15, 7.5, true, STYLE.ink, 'center', dayW);
  let hx = x0 + dayW;
  table.columns.forEach((col) => {
    const w = col.type === 'lunch' ? lunchW : colW;
    rect(hx, gridTop, w, headH, { fill: STYLE.head, stroke: STYLE.grid });
    if (col.type === 'lunch') text('พักเที่ยง', hx, gridTop + 14.5, 5.5, true, STYLE.ink, 'center', w);
    else {
      text(`คาบ ${col.label}`, hx, gridTop + 10.5, 8, true, STYLE.ink, 'center', w);
      text(col.time, hx, gridTop + 19.5, 5.8, false, '#222222', 'center', w);
    }
    hx += w;
  });
  table.rows.forEach((row, ri) => {
    const y = gridTop + headH + ri * rowH;
    rect(x0, y, dayW, rowH, { fill: STYLE.day, stroke: STYLE.grid });
    text(row.dayName, x0, y + rowH / 2 + 3, 8.5, true, STYLE.ink, 'center', dayW);
  });

  // ช่อง
  cells.forEach((c) => {
    const { x, y, w, h, kind, lay } = c;
    const st = STYLE[kind === 'merged' ? 'general' : kind] ?? null;
    rect(x, y, w, h, { fill: kind === 'empty' ? STYLE.empty : st.fill, stroke: STYLE.grid });
    if (kind === 'vocational') hatchLines(x, y, w, h, st.hatch, (a, b, cc, d) => line(a, b, cc, d, st.hatch.color, st.hatch.width));
    if (kind === 'merged') { // ขอบคู่หนา
      rect(x + 0.4, y + 0.4, w - 0.8, h - 0.8, { stroke: STYLE.ink, lw: 1.3 });
      rect(x + 2.6, y + 2.6, w - 5.2, h - 5.2, { stroke: STYLE.ink, lw: 0.5 });
    }
    scene.cells.push({ x, y, w, h, kind, ri: c.ri, ci: c.ci });
    if (!lay) return;
    const tx = x + padX + c.inset;
    const ty = y + padTop + c.inset;
    lay.blocks.forEach((b) => {
      scene.texts.push({
        text: b.text, x: tx, y: ty + b.y + (b.size * LINE_FACTOR - b.size * (ASC + 0.232)) / 2, size: b.size, bold: b.bold, color: STYLE.ink,
        width: textWidth(b.text, b.size, b.bold), box: { x, y, w, h }, // box = ช่องที่ข้อความต้องอยู่ข้างใน (ใช้ตรวจไม่ล้น)
      });
    });
    // เครื่องหมายชนิดที่มุมขวาบน
    const r = 4.2;
    const cx = x + w - padX - c.inset - r - 0.3;
    const cy = y + padTop + c.inset + r + 0.4;
    if (kind === 'merged') {
      rect(cx - r, cy - r, 2 * r, 2 * r, { fill: '#ffffff', stroke: STYLE.ink, lw: 0.9 });
      rect(cx - r + 1.3, cy - r + 1.3, 2 * r - 2.6, 2 * r - 2.6, { stroke: STYLE.ink, lw: 0.45 });
      text(STYLE.merged.mark, cx - r, cy + 2.2, 6.2, true, STYLE.ink, 'center', 2 * r);
    } else if (kind === 'vocational') {
      scene.ellipses.push({ cx, cy, r, fill: STYLE.ink, stroke: STYLE.ink, lw: 0.7 });
      text(STYLE.vocational.mark, cx - r, cy + 2.2, 6.2, true, '#ffffff', 'center', 2 * r);
    } else {
      scene.ellipses.push({ cx, cy, r, fill: '#ffffff', stroke: STYLE.ink, lw: 0.8 });
      text(STYLE.general.mark, cx - r, cy + 2.2, 6.2, true, STYLE.ink, 'center', 2 * r);
    }
  });

  // พักเที่ยง (คอลัมน์เดียวทั้ง 5 วัน)
  const lunchIdx = table.columns.findIndex((c) => c.type === 'lunch');
  if (lunchIdx >= 0) {
    const lx = x0 + dayW + table.columns.slice(0, lunchIdx).reduce((a, c) => a + (c.type === 'lunch' ? lunchW : colW), 0);
    const ly = gridTop + headH;
    rect(lx, ly, lunchW, 5 * rowH, { fill: STYLE.lunch.fill, stroke: STYLE.grid });
    hatchLines(lx, ly, lunchW, 5 * rowH, STYLE.lunch.hatch, (a, b, cc, d) => line(a, b, cc, d, STYLE.lunch.hatch.color, STYLE.lunch.hatch.width));
    scene.cells.push({ x: lx, y: ly, w: lunchW, h: 5 * rowH, kind: 'lunch', ri: -1, ci: lunchIdx });
    // ข้อความสั้น ๆ แนวนอน 2 บรรทัด "พัก" / "เที่ยง" บนแถบพื้นขาว (ไม่แยกสระ/วรรณยุกต์จากพยัญชนะ) ขนาดพอดีความกว้างคอลัมน์
    const parts = ['พัก', 'เที่ยง'];
    const inner = lunchW - 4;
    const size = Math.min(7.5, ...parts.map((p) => (inner / textWidth(p, 1, true))));
    const lineH = size * 1.35;
    const boxH = parts.length * lineH + 5;
    const boxY = ly + (5 * rowH - boxH) / 2;
    rect(lx + 1.5, boxY, lunchW - 3, boxH, { fill: '#ffffff', stroke: STYLE.ink, lw: 0.5 });
    parts.forEach((p, i) => text(p, lx, boxY + 2.5 + i * lineH + lineH / 2 + size * 0.33, size, true, STYLE.ink, 'center', lunchW));
    scene.lunchLabel = { size, parts };
  }

  // ข้อความ "ยังไม่มีคาบ" กลางตาราง
  if (table.empty) {
    const mw = 150;
    const mh = 26;
    const mx = x0 + dayW + (CW - dayW - lunchW) / 2 - mw / 2;
    const my = gridTop + headH + (5 * rowH) / 2 - mh / 2;
    rect(mx, my, mw, mh, { fill: '#ffffff', stroke: STYLE.ink, lw: 1.2 });
    text(table.emptyText, mx, my + 18, 13, true, STYLE.ink, 'center', mw);
  }

  // legend ชื่อเต็ม
  let yLeg = gridBottom + 3;
  if (legendLayout) {
    text('ชื่อเต็มของรายการที่ถูกตัดในตาราง (…)', x0, yLeg + 7.5, 7, true);
    yLeg += 11;
    legendLayout.cols.forEach((col, ci) => {
      let y = yLeg;
      col.forEach((entry) => entry.lines.forEach((ln) => {
        scene.texts.push({ text: ln, x: x0 + ci * (legendLayout.colWidth + 10), y: y + (legendLh - legendSize * (ASC + 0.232)) / 2, size: legendSize, bold: false, color: STYLE.ink, width: 0 });
        y += legendLh;
      }));
    });
    if (legendLayout.overflow.length) text(`(มีอีก ${legendLayout.overflow.length} รายการ ดูหน้าถัดไป)`, x0, H - M - symbolH - 5, 6.5, false, '#222222', 'right', CW);
  }

  // legend สัญลักษณ์ (ล่างสุด)
  const ly = H - M - symbolH + 1;
  let lx = x0;
  const sw = (w) => { lx += w; };
  const swatch = (kind) => {
    const st = STYLE[kind];
    rect(lx, ly, 15, 9, { fill: st.fill, stroke: STYLE.grid, lw: 0.5 });
    if (st.hatch) hatchLines(lx, ly, 15, 9, st.hatch, (a, b, c, d) => line(a, b, c, d, st.hatch.color, st.hatch.width));
    sw(18);
  };
  const markCircle = (kind) => {
    const cy = ly + 4.5;
    scene.ellipses.push({ cx: lx + 4.2, cy, r: 4.2, fill: kind === 'vocational' ? STYLE.ink : '#ffffff', stroke: STYLE.ink, lw: 0.7 });
    text(STYLE[kind].mark, lx, cy + 2.2, 6.2, true, kind === 'vocational' ? '#ffffff' : STYLE.ink, 'center', 8.4);
    sw(11);
  };
  const label = (s, gap = 12) => { text(s, lx, ly + 7.2, 7, false); sw(textWidth(s, 7, false) + gap); };
  swatch('general'); markCircle('general'); label('วิชาสามัญ (พื้นเทาอ่อน)');
  swatch('vocational'); markCircle('vocational'); label('วิชาชีพเฉพาะ (พื้นเข้ม ลายทแยง ตัวหนา)');
  rect(lx, ly, 15, 9, { fill: STYLE.general.fill, stroke: STYLE.ink, lw: 1.2 });
  rect(lx + 2, ly + 2, 11, 5, { stroke: STYLE.ink, lw: 0.4 });
  sw(18);
  rect(lx, ly, 8.4, 8.4, { fill: '#ffffff', stroke: STYLE.ink, lw: 0.8 });
  rect(lx + 1.2, ly + 1.2, 6, 6, { stroke: STYLE.ink, lw: 0.4 });
  text('ร', lx, ly + 6.6, 6.2, true, STYLE.ink, 'center', 8.4);
  sw(11);
  label('เรียนรวม (ขอบคู่)');
  swatch('lunch'); label('พักเที่ยง');
  rect(lx, ly, 15, 9, { fill: '#ffffff', stroke: STYLE.grid, lw: 0.5 }); sw(18); label('ว่าง', 0);

  scene.truncated = legendEntries;
  scene.rowH = rowH;
  return scene;
}

// หน้าต่อของ legend ชื่อเต็ม (เมื่อรายการที่ถูกตัดมากเกินที่หน้าแรกรับได้)
export function layoutLegendContinuation(title, entries, startNumber) {
  const { width: W, height: H, margin: M } = PAGE;
  const scene = { width: W, height: H, rects: [], lines: [], ellipses: [], texts: [], cells: [], truncated: [], overflowLegend: [] };
  const CW = W - 2 * M;
  const size = 8;
  const lh = size * LINE_FACTOR;
  const put = (str, x, y, s, bold) => scene.texts.push({ text: str, x, y: y - ASC * s, size: s, bold, color: STYLE.ink, width: 0 });
  const head = fitSingleLine(`${title} (ต่อ) — ชื่อเต็มของรายการที่ถูกตัด`, 12, 8, true, CW);
  put(head.text, M, M + 14, head.size, true);
  const colWidth = (CW - 14) / 2;
  let col = 0;
  let y = M + 30;
  const rest = [];
  entries.forEach((entry, i) => {
    const lines = wrapText(`${startNumber + i}. ${entry}`, size, false, () => colWidth);
    if (y + lines.length * lh > H - M) {
      if (col === 0) { col = 1; y = M + 30; } else { rest.push(entry); return; }
    }
    lines.forEach((ln) => { put(ln, M + col * (colWidth + 14), y + lh * 0.85, size, false); y += lh; });
    y += 2;
  });
  scene.overflowLegend = rest;
  return scene;
}
