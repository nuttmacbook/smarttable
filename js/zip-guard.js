// ตรวจไฟล์ .xlsx (ซึ่งเป็น zip) ก่อนส่งให้ read-excel-file — SPEC v4 ข้อ 14 W-10 (กัน zip bomb / ไฟล์ที่มีมาโคร-ลิงก์ภายนอก)
// อ่านเฉพาะ central directory (ไม่คลายไฟล์ทั้งหมด) แล้วคลายแค่ [Content_Types].xml และส่วนหัวของชีตเพื่อดู <dimension>
// pure + ไม่แตะ DOM ใช้ใน node ได้ (ตัวคลายใช้ DecompressionStream ที่มีทั้งในเบราว์เซอร์และ node ≥ 18)
// ตรวจจากโครงสร้างไฟล์เท่านั้น ไม่ใช่การสแกนไวรัส/มัลแวร์
export const ZIP_LIMITS = {
  maxFiles: 100,
  maxTotalUncompressed: 50 * 1024 * 1024,
  maxEntryUncompressed: 30 * 1024 * 1024,
  maxRatio: 100, // อัตราบีบอัด (ขนาดหลังคลาย / ขนาดบีบอัด) ต่อไฟล์ย่อย
  maxRows: 5000, // ไม่รวมแถวหัว
  maxColumns: 100,
  maxCellLength: 500,
};

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const decoder = new TextDecoder('utf-8', { fatal: false });

const colToNumber = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

// อ่าน central directory → { ok, problems:[string], entries:[{name,method,compSize,size,offset,flags}] }
export function inspectZip(bytes, limits = ZIP_LIMITS) {
  const problems = [];
  const fail = (msg) => ({ ok: false, problems: [msg, ...problems], entries: [] });
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) return fail('ไฟล์ไม่ใช่ Excel (.xlsx) ที่ถูกต้อง');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return fail('ไฟล์ไม่ใช่ Excel (.xlsx) ที่ถูกต้อง');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (dv.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return fail('ไฟล์ Excel เสียหายหรืออ่านโครงสร้างไม่ได้');
  const total = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return fail('ไฟล์ Excel ขนาดใหญ่ผิดปกติ (zip64) ไม่รองรับ');
  if (total > limits.maxFiles) return fail(`ไฟล์ Excel มีไฟล์ย่อยมากผิดปกติ (${total} ไฟล์ เกิน ${limits.maxFiles})`);
  if (cdOffset + cdSize > bytes.length) return fail('ไฟล์ Excel เสียหายหรืออ่านโครงสร้างไม่ได้');

  const entries = [];
  let p = cdOffset;
  let sum = 0;
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CD_SIG) return fail('ไฟล์ Excel เสียหายหรืออ่านโครงสร้างไม่ได้');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    if (p + 46 + nameLen > bytes.length) return fail('ไฟล์ Excel เสียหายหรืออ่านโครงสร้างไม่ได้');
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, size, offset, flags });
    sum += size;
    p += 46 + nameLen + extraLen + commentLen;
  }

  // central directory ต้องถูกอ่านครบพอดี (กันซ่อนรายการท้าย CD ที่ EOCD นับไม่ถึง)
  if (p !== cdOffset + cdSize) return fail('ไฟล์ Excel เสียหายหรืออ่านโครงสร้างไม่ได้');
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.name)) problems.push(`ไฟล์ Excel มีชื่อไฟล์ย่อยซ้ำ: ${e.name.slice(0, 60)}`);
    seen.add(e.name);
  }
  for (const e of entries) {
    // เทียบกับ local header: ชื่อและขนาดต้องตรงกับ central directory (ถ้าไม่มี data descriptor)
    if (e.offset + 30 > bytes.length || dv.getUint32(e.offset, true) !== LOCAL_SIG) {
      problems.push(`ไฟล์ย่อย ${e.name.slice(0, 40)} มี local header เสีย`);
      continue;
    }
    const lnLen = dv.getUint16(e.offset + 26, true);
    const lname = decoder.decode(bytes.subarray(e.offset + 30, e.offset + 30 + lnLen));
    if (lname !== e.name) problems.push(`ไฟล์ย่อย ${e.name.slice(0, 40)} ชื่อใน local header ไม่ตรง`);
    if (!(dv.getUint16(e.offset + 6, true) & 8)) {
      if (dv.getUint32(e.offset + 18, true) !== e.compSize || dv.getUint32(e.offset + 22, true) !== e.size) {
        problems.push(`ไฟล์ย่อย ${e.name.slice(0, 40)} ขนาดใน local header ไม่ตรงกับที่ประกาศ`);
      }
    }
  }
  for (const e of entries) {
    if (e.flags & 1) problems.push('ไฟล์ Excel ถูกเข้ารหัส/ใส่รหัสผ่าน ไม่รองรับ');
    if (/(^|[\\/])\.\.([\\/]|$)/.test(e.name) || /^[\\/]/.test(e.name) || /^[A-Za-z]:/.test(e.name) || e.name.includes('\0')) {
      problems.push(`ไฟล์ Excel มีชื่อไฟล์ย่อยที่ไม่ปลอดภัย: ${e.name.slice(0, 60)}`);
    }
    if (/vbaProject\.bin$/i.test(e.name) || /\.xlsm$/i.test(e.name)) problems.push('ไฟล์ Excel มีมาโคร (VBA) ไม่รองรับ');
    if (/(^|\/)externalLinks\//i.test(e.name)) problems.push('ไฟล์ Excel มีลิงก์ไปไฟล์ภายนอก ไม่รองรับ');
    if (e.size > limits.maxEntryUncompressed) problems.push(`ไฟล์ย่อย ${e.name.slice(0, 40)} ใหญ่ผิดปกติหลังคลาย`);
    if (e.method !== 0 && e.method !== 8) problems.push(`ไฟล์ย่อย ${e.name.slice(0, 40)} ใช้วิธีบีบอัดที่ไม่รองรับ`);
    if (e.method === 8 && e.compSize > 0 && e.size / e.compSize > limits.maxRatio && e.size > 1024 * 1024) {
      problems.push(`ไฟล์ย่อย ${e.name.slice(0, 40)} อัตราบีบอัดสูงผิดปกติ (เสี่ยง zip bomb)`);
    }
  }
  if (sum > limits.maxTotalUncompressed) problems.push('ขนาดไฟล์ Excel หลังคลายใหญ่เกินกำหนด (50 MB)');
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) problems.push('ไฟล์นี้ไม่ใช่สมุดงาน Excel (.xlsx) ที่ถูกต้อง');
  return { ok: problems.length === 0, problems: [...new Set(problems)], entries };
}

// คลายไฟล์ย่อยหนึ่งไฟล์ (จำกัดจำนวนไบต์ที่อ่าน) → Uint8Array
export async function readEntry(bytes, entry, maxBytes = 1024 * 1024) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || dv.getUint32(entry.offset, true) !== LOCAL_SIG) throw new Error('local header เสีย');
  const start = entry.offset + 30 + dv.getUint16(entry.offset + 26, true) + dv.getUint16(entry.offset + 28, true);
  const raw = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw.subarray(0, maxBytes);
  if (typeof DecompressionStream === 'undefined') throw new Error('เบราว์เซอร์นี้ไม่รองรับการคลายไฟล์');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let got = 0;
  while (got < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  await reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(got, maxBytes));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - o);
    out.set(c.subarray(0, take), o);
    o += take;
    if (o >= out.length) break;
  }
  return out;
}

// นับไบต์ที่คลายได้จริงของไฟล์ย่อย (ไม่เก็บเนื้อหา) หยุดเมื่อเกิน cap — จับ "ประกาศขนาดเล็กแต่คลายแล้วใหญ่"
export async function countInflated(bytes, entry, cap) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = entry.offset + 30 + dv.getUint16(entry.offset + 26, true) + dv.getUint16(entry.offset + 28, true);
  const raw = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw.length;
  if (typeof DecompressionStream === 'undefined') throw new Error('เบราว์เซอร์นี้ไม่รองรับการคลายไฟล์');
  const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > cap) { await reader.cancel().catch(() => {}); break; }
  }
  return n;
}

// อ่าน <dimension ref="A1:E10"/> จากส่วนต้นของชีต → { rows, columns } หรือ null ถ้าไม่พบ
export function parseDimension(xmlHead) {
  const m = /<dimension\s+ref="([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?"/.exec(xmlHead);
  if (!m) return null;
  const c1 = colToNumber(m[1].toUpperCase());
  const r1 = Number(m[2]);
  const c2 = m[3] ? colToNumber(m[3].toUpperCase()) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  return { rows: Math.max(0, r2 - r1 + 1), columns: Math.max(0, c2 - c1 + 1) };
}

// ตรวจเต็มรูปแบบ: โครงสร้าง zip + Content_Types (ไม่มีมาโคร) + <dimension> ของทุกชีต
// คืน { ok, problems:[string] } — ผ่านแล้วจึงส่งไฟล์ให้ read-excel-file ได้
export async function guardXlsx(bytes, limits = ZIP_LIMITS) {
  const z = inspectZip(bytes, limits);
  if (!z.ok) return { ok: false, problems: z.problems };
  const problems = [];
  try {
    // ขนาดจริงหลังคลายต้องตรงกับที่ประกาศ และผลรวมจริงไม่เกินกำหนด (กันประกาศขนาดโกหก)
    let budget = limits.maxTotalUncompressed;
    for (const e of z.entries) {
      const actual = await countInflated(bytes, e, Math.min(e.size + 1, budget + 1));
      if (actual !== e.size) {
        return { ok: false, problems: [`ไฟล์ย่อย ${e.name.slice(0, 40)} ขนาดหลังคลายไม่ตรงกับที่ประกาศ (ไฟล์ผิดปกติ)`] };
      }
      budget -= actual;
      if (budget < 0) return { ok: false, problems: ['ขนาดไฟล์ Excel หลังคลายใหญ่เกินกำหนด (50 MB)'] };
    }
    const ct = z.entries.find((e) => e.name === '[Content_Types].xml');
    const text = decoder.decode(await readEntry(bytes, ct, 512 * 1024));
    if (/macroEnabled|vbaProject/i.test(text)) problems.push('ไฟล์ Excel มีมาโคร (VBA) ไม่รองรับ');
    for (const e of z.entries.filter((x) => /^xl\/worksheets\/[^/]+\.xml$/i.test(x.name))) {
      const head = decoder.decode(await readEntry(bytes, e, 16 * 1024));
      const dim = parseDimension(head);
      if (!dim) continue; // ไม่มี dimension: ตรวจจำนวนแถวหลังอ่านอีกชั้น (excel-reader)
      if (dim.rows - 1 > limits.maxRows) problems.push(`ชีต ${e.name.replace('xl/worksheets/', '')} มี ${dim.rows - 1} แถว เกินกำหนด ${limits.maxRows} แถว`);
      if (dim.columns > limits.maxColumns) problems.push(`ชีต ${e.name.replace('xl/worksheets/', '')} มี ${dim.columns} คอลัมน์ เกินกำหนด ${limits.maxColumns}`);
    }
  } catch {
    problems.push('ไฟล์ Excel เสียหายหรืออ่านเนื้อหาไม่ได้');
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
