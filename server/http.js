// ตัวช่วย HTTP ของ api/** (SPEC v4 ข้อ 7 + ข้อ 14) — ไม่มี dependency, ไม่ log body/คุกกี้/โทเค็น
// อยู่ใน server/ (ไม่ใช่ api/_lib) เพื่อไม่เสี่ยงถูกนับเป็น endpoint (W-15)
// ทุก response: Cache-Control: no-store · ไม่ตั้ง CORS ใด ๆ (เรียกได้เฉพาะ same-origin) · ข้อความ error คงที่ ไม่รั่ว stack
import { Buffer } from 'node:buffer';

export const MAX_BODY = 1024 * 1024; // /api/op และอื่น ๆ ≤ 1 MB
export const MAX_IMPORT_BODY = 4 * 1024 * 1024; // /api/import, /api/migrate ≤ 4 MB (เพดานของ Vercel Function ≈ 4.5 MB)

/** error ที่ตั้งใจตอบกลับผู้ใช้ — status, code (ภาษาอังกฤษคงที่), message (ไทย), extra รวมเข้า body */
export class HttpError extends Error {
  constructor(status, code, message, extra = {}, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

/** ตั้งค่าเซิร์ฟเวอร์ไม่ครบ/ผิด (env) — ตอบ 500 แบบไม่ระบุรายละเอียด และ log ข้อความ (ไม่มี secret ในข้อความ) */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (typeof res.status === 'function') res.status(status);
  else res.statusCode = status;
  if (status === 304) { res.end(); return; } // 304 ห้ามมี body
  res.end(JSON.stringify(body ?? {}));
}

function sendError(res, err, routeName) {
  if (err instanceof HttpError) {
    send(res, err.status, { error: err.code, message: err.message, ...err.extra }, err.headers);
    return;
  }
  // ไม่ log body/header/stack ของคำขอ — ชื่อชนิด error + รหัสพอสำหรับไล่ปัญหา
  if (err instanceof ConfigError) console.error(`[api] ${routeName}: ตั้งค่าไม่ครบ — ${err.message}`);
  else console.error(`[api] ${routeName}: ข้อผิดพลาดที่ไม่คาดคิด (${err?.name ?? 'Error'}${err?.code ? ` ${err.code}` : ''})`);
  send(res, 500, { error: 'server_error', message: 'เซิร์ฟเวอร์ขัดข้อง โปรดลองใหม่ภายหลัง' });
}

/* ---------- คำขอ */
export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (!(name in out)) out[name] = part.slice(i + 1).trim(); // ชื่อซ้ำ: ใช้ตัวแรก
  }
  return out;
}

const firstOf = (value) => (typeof value === 'string' ? value.split(',')[0].trim() : '');

/**
 * IP ผู้เรียก (W-06): ใช้ header ที่ Vercel เขียนทับให้เองก่อน — x-vercel-forwarded-for → x-real-ip → x-forwarded-for (ค่าแรก) → socket
 * (ตามเอกสาร Vercel "Request headers": x-forwarded-for / x-real-ip / x-vercel-forwarded-for ถูกตั้งโดย Vercel ไม่เชื่อค่าที่ไคลเอนต์ส่ง
 *  — ยังไม่ได้ยืนยันบนแพลตฟอร์มจริง; ถ้ารันหลังพร็อกซีอื่นต้องตรวจเรื่อง spoof ก่อน)
 */
export function clientIp(req) {
  const h = req.headers ?? {};
  return firstOf(h['x-vercel-forwarded-for']) || firstOf(h['x-real-ip']) || firstOf(h['x-forwarded-for'])
    || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

export function queryOf(req) {
  const out = Object.create(null);
  try {
    for (const [k, v] of new URL(req.url ?? '/', 'http://local.invalid').searchParams) if (!(k in out)) out[k] = v;
  } catch { /* url เสีย → ไม่มี query */ }
  return out;
}

/* ---------- CSRF (W-08) */
/** origin ที่อนุญาตให้เรียกเขียน: ALLOWED_ORIGINS (คั่น ,) เท่านั้น · ไม่ตั้ง/ว่าง/ไม่มี origin ที่ถูกต้องสักตัว = ConfigError เสมอ (ไม่มีค่า dev/localhost อัตโนมัติ) */
export function allowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  const origins = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((o) => {
    try { return new URL(o).origin; } catch { return null; }
  }).filter(Boolean);
  if (origins.length === 0) throw new ConfigError('ต้องตั้ง ALLOWED_ORIGINS (origin ของเว็บ เช่น https://timetable.example.com)');
  return origins;
}

/**
 * คำขอเขียนทุกตัว (รวม login): ต้องมี X-Requested-With: tt · ต้องมี Origin หรือ Sec-Fetch-Site อย่างน้อยหนึ่ง (ไม่มีทั้งคู่ → 403)
 * Sec-Fetch-Site ที่มาต้องเป็น same-origin · Origin ที่มาต้องอยู่ใน allowlist (ไม่ใช้ Host/x-forwarded-host)
 */
export function checkCsrf(req) {
  const h = req.headers ?? {};
  const deny = () => new HttpError(403, 'forbidden', 'คำขอนี้ไม่ได้รับอนุญาต');
  if (h['x-requested-with'] !== 'tt') throw deny();
  const origin = h.origin;
  const site = h['sec-fetch-site'];
  if (origin === undefined && site === undefined) throw deny();
  if (site !== undefined && site !== 'same-origin') throw deny();
  if (origin !== undefined) {
    let normalized = null;
    try { normalized = new URL(origin).origin; } catch { /* Origin: null ฯลฯ */ }
    if (normalized === null || !allowedOrigins().includes(normalized)) throw deny();
  }
}

export function checkJsonContentType(req) {
  const type = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'ต้องส่งข้อมูลเป็น JSON (Content-Type: application/json)');
}

/** baseVersion ต้องเป็นจำนวนเต็ม ≥ 0 */
export function parseBaseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'bad_request', 'baseVersion ต้องเป็นจำนวนเต็มตั้งแต่ 0');
  return value;
}

const isPlainObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * อ่าน JSON body: รองรับทั้งที่แพลตฟอร์ม parse ให้แล้ว (req.body) และต้องอ่าน stream เอง · เกิน limit → 413 · JSON เสีย/ไม่ใช่ object → 400
 * @param {{optional?: boolean}} [options] optional: ไม่มี body = {}
 */
export async function readJson(req, limit = MAX_BODY, { optional = false } = {}) {
  const tooLarge = () => new HttpError(413, 'payload_too_large', 'ข้อมูลมีขนาดใหญ่เกินกำหนด');
  const bad = () => new HttpError(400, 'bad_request', 'ข้อมูลที่ส่งมาไม่ใช่ JSON ที่ถูกต้อง');
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw tooLarge();

  let data = req.body;
  if (data === undefined || data === null || data === '') {
    if (typeof req[Symbol.asyncIterator] !== 'function') {
      if (optional) return {};
      throw bad();
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw tooLarge();
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.trim() === '') {
      if (optional) return {};
      throw bad();
    }
    try { data = JSON.parse(text); } catch { throw bad(); }
  } else if (Buffer.isBuffer(data) || typeof data === 'string') {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    if (Buffer.byteLength(text, 'utf8') > limit) throw tooLarge();
    try { data = JSON.parse(text); } catch { throw bad(); }
  } else if (Buffer.byteLength(JSON.stringify(data), 'utf8') > limit) {
    throw tooLarge(); // แพลตฟอร์ม parse มาให้แล้ว วัดขนาดจากการ serialize ซ้ำ
  }
  if (!isPlainObject(data)) throw bad();
  return data;
}

/**
 * สร้าง handler ของ Vercel Function จากตาราง method → ฟังก์ชัน
 *   export default route('name', { GET: async (ctx) => ({ status?, body, headers? }), POST: ... })
 * ลำดับตรวจ: method (405) → [ไม่ใช่ GET: CSRF 403 → Content-Type 415] → ฟังก์ชันของ endpoint (auth 401 → อ่าน body → logic)
 * ctx = { req, res, method, ip, query }
 */
export function route(name, methods) {
  return async function handler(req, res) {
    try {
      const method = String(req.method ?? 'GET').toUpperCase();
      const run = Object.hasOwn(methods, method) ? methods[method] : null;
      if (!run) {
        send(res, 405, { error: 'method_not_allowed', message: 'ไม่รองรับ method นี้' }, { Allow: Object.keys(methods).join(', ') });
        return;
      }
      if (method !== 'GET') {
        checkCsrf(req);
        checkJsonContentType(req);
      }
      const out = await run({ req, res, method, ip: clientIp(req), query: queryOf(req) });
      send(res, out?.status ?? 200, out?.body ?? {}, out?.headers);
    } catch (err) {
      sendError(res, err, name);
    }
  };
}
