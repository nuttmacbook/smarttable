// สร้าง js/export/font-metrics.js จาก public/fonts/*.woff (ความกว้าง advance ต่ออักขระ) — ใช้วัดข้อความใน PDF โดยไม่ต้องพึ่งไลบรารีเพิ่ม
// ใช้: node scripts/gen-font-metrics.mjs   (รันซ้ำเมื่อเปลี่ยนไฟล์ฟอนต์เท่านั้น แล้ว commit ผลลัพธ์)
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  latin400: 'sarabun-latin-400-normal.woff',
  latin700: 'sarabun-latin-700-normal.woff',
  thai400: 'sarabun-thai-400-normal.woff',
  thai700: 'sarabun-thai-700-normal.woff',
};

function readTables(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOFF') throw new Error('ไม่ใช่ woff');
  const n = buf.readUInt16BE(12);
  const tables = {};
  for (let i = 0; i < n; i += 1) {
    const o = 44 + i * 20;
    const tag = buf.toString('latin1', o, o + 4);
    const off = buf.readUInt32BE(o + 4);
    const comp = buf.readUInt32BE(o + 8);
    const orig = buf.readUInt32BE(o + 12);
    const raw = buf.subarray(off, off + comp);
    tables[tag] = comp < orig ? inflateSync(raw) : raw;
  }
  return tables;
}

function cmapMap(cmap) {
  const n = cmap.readUInt16BE(2);
  const map = new Map();
  for (let i = 0; i < n; i += 1) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const enc = cmap.readUInt16BE(6 + i * 8);
    const off = cmap.readUInt32BE(8 + i * 8);
    if (!((platform === 3 && (enc === 1 || enc === 10)) || platform === 0)) continue;
    const fmt = cmap.readUInt16BE(off);
    if (fmt === 4) {
      const segX2 = cmap.readUInt16BE(off + 6);
      const endO = off + 14;
      const startO = endO + segX2 + 2;
      const deltaO = startO + segX2;
      const rangeO = deltaO + segX2;
      for (let s = 0; s < segX2 / 2; s += 1) {
        const end = cmap.readUInt16BE(endO + s * 2);
        const start = cmap.readUInt16BE(startO + s * 2);
        const delta = cmap.readInt16BE(deltaO + s * 2);
        const ro = cmap.readUInt16BE(rangeO + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          let g;
          if (ro === 0) g = (c + delta) & 0xffff;
          else {
            const p = rangeO + s * 2 + ro + (c - start) * 2;
            g = cmap.readUInt16BE(p);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g) map.set(c, g);
        }
      }
    } else if (fmt === 12) {
      const groups = cmap.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g += 1) {
        const o = off + 16 + g * 12;
        const s = cmap.readUInt32BE(o);
        const e = cmap.readUInt32BE(o + 4);
        const gid = cmap.readUInt32BE(o + 8);
        for (let c = s; c <= e; c += 1) map.set(c, gid + (c - s));
      }
    }
  }
  return map;
}

const out = {};
for (const [key, file] of Object.entries(FILES)) {
  const t = readTables(readFileSync(path.join(root, 'public', 'fonts', file)));
  const upm = t.head.readUInt16BE(18);
  const nh = t.hhea.readUInt16BE(34);
  const adv = (gid) => t.hmtx.readUInt16BE(Math.min(gid, nh - 1) * 4);
  const widths = {};
  for (const [cp, gid] of cmapMap(t.cmap)) widths[cp] = adv(gid);
  out[key] = { upm, widths, asc: t.hhea.readInt16BE(4), desc: t.hhea.readInt16BE(6) };
  console.log(key, 'upm', upm, 'glyph chars', Object.keys(widths).length);
}

// เก็บเป็น { upm, w: "cp:adv,cp:adv,..." } ให้ไฟล์เล็ก
const packed = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { upm: v.upm, asc: v.asc, desc: v.desc, w: Object.entries(v.widths).map(([c, a]) => `${Number(c).toString(16)}:${a}`).join(',') }]));
const src = `// สร้างโดย scripts/gen-font-metrics.mjs จาก public/fonts/*.woff (Sarabun, OFL) — ห้ามแก้ด้วยมือ
// รูปแบบ: { upm, w: "codepoint(hex):advance,..." } advance หน่วย 1/upm em
export const FONT_METRICS = ${JSON.stringify(packed)};
`;
writeFileSync(path.join(root, 'js', 'export', 'font-metrics.js'), src);
console.log('เขียน js/export/font-metrics.js', src.length, 'ไบต์');
