// เซสชันแอดมิน (SPEC v4 ข้อ 7 + ข้อ 14 W-07): token สุ่ม 32 ไบต์ → cookie __Host-tt_session (HttpOnly; Secure; SameSite=Lax; Path=/; ไม่มี Domain)
// ฝั่งเซิร์ฟเวอร์เก็บ sess:<SHA-256(token)> ใน Redis ค่า {u: username, p: pwdVersion, c: createdAt, l: lastSeen}
//  - SESSION_SECRET (≥ 32 ไบต์) = กุญแจ HMAC-SHA256: key ใน Redis คือ HMAC(SESSION_SECRET, token) ไม่ใช่ token ดิบ/hash ล้วน
//    → คนที่อ่าน Redis ได้อย่างเดียว (หรือ read-only token) สร้างคุกกี้ที่ใช้ได้เองไม่ได้ · เปลี่ยนค่านี้ = ทุกเซสชันใช้ไม่ได้ทันที (เปาตัดสิน WA-14)
//  - ทุกคำขอตรวจกับ ADMIN_ACCOUNTS: บัญชีถูกลบ/เปลี่ยนรหัสผ่าน (pwdVersion ไม่ตรง) = เซสชันใช้ไม่ได้และถูกลบ
//  - idle 2 ชม. (ต่ออายุเมื่อใช้) · absolute 12 ชม. นับจาก createdAt (ต่ออายุไม่ได้)
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ConfigError, HttpError, parseCookies } from './http.js';
import { getRedis } from './redis.js';
import { pwdVersionOf } from './auth.js';

export const COOKIE_NAME = '__Host-tt_session';
export const IDLE_SECONDS = 2 * 60 * 60;
export const ABSOLUTE_SECONDS = 12 * 60 * 60;
const RENEW_AFTER_MS = 60 * 1000; // ไม่เขียน Redis ซ้ำทุกคำขอ: ต่ออายุเมื่อผ่านไป ≥ 1 นาทีจากครั้งก่อน
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 ไบต์ base64url

// คุกกี้เซสชัน: ชื่อ __Host- + Secure + HttpOnly + SameSite=Lax เสมอ (ต้องใช้ผ่าน https)

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || Buffer.byteLength(s, 'utf8') < 32) throw new ConfigError('SESSION_SECRET ต้องยาวอย่างน้อย 32 ไบต์');
  return s;
}

const keyFor = (token) => `sess:${crypto.createHmac('sha256', secret()).update(token).digest('hex')}`;

export function cookieHeader(token) {
  return `${COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ABSOLUTE_SECONDS}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

const tokenOf = (req) => {
  const raw = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  return typeof raw === 'string' && TOKEN_RE.test(raw) ? raw : null;
};

/** สร้างเซสชันใหม่ (token ใหม่ทุกครั้งที่ login) คืน token · ต้องเป็นบัญชีที่มีใน ADMIN_ACCOUNTS */
export async function createSession(username) {
  const p = pwdVersionOf(username);
  if (p === null) throw new ConfigError('ไม่พบบัญชีใน ADMIN_ACCOUNTS ตอนสร้างเซสชัน');
  const redis = await getRedis();
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await redis.set(keyFor(token), JSON.stringify({ u: username, p, c: now, l: now }), { ex: IDLE_SECONDS });
  return token;
}

/** อ่านเซสชันจากคุกกี้ของคำขอ · คืน { username, token } หรือ null (ไม่มี/ปลอม/หมดอายุ/บัญชีเปลี่ยน) — ต่ออายุ idle ให้ */
export async function getSession(req) {
  const token = tokenOf(req);
  if (!token) return null; // รูปแบบผิด: ไม่ต้องถาม Redis
  const redis = await getRedis();
  const key = keyFor(token);
  const raw = await redis.get(key);
  if (raw === null) return null;
  let s;
  try { s = JSON.parse(raw); } catch { s = null; }
  const now = Date.now();
  const valid = s && typeof s.u === 'string' && typeof s.p === 'string' && Number.isFinite(s.c) && Number.isFinite(s.l)
    && now - s.c < ABSOLUTE_SECONDS * 1000 && now - s.l < IDLE_SECONDS * 1000
    && pwdVersionOf(s.u) === s.p; // บัญชีถูกลบ/เปลี่ยนรหัสผ่านแล้ว = ใช้ไม่ได้
  if (!valid) {
    await redis.del(key);
    return null;
  }
  if (now - s.l >= RENEW_AFTER_MS) {
    const remainingAbsolute = Math.ceil((ABSOLUTE_SECONDS * 1000 - (now - s.c)) / 1000);
    await redis.set(key, JSON.stringify({ ...s, l: now }), { ex: Math.max(1, Math.min(IDLE_SECONDS, remainingAbsolute)) });
  }
  return { username: s.u, token };
}

/** ลบเซสชันของคำขอนี้ (logout / login ซ้ำ) — ไม่มีเซสชัน = ไม่ทำอะไร */
export async function destroySession(req) {
  const token = tokenOf(req);
  if (!token) return;
  const redis = await getRedis();
  await redis.del(keyFor(token));
}

/** ใช้ต้น endpoint ของแอดมิน: ไม่มีเซสชัน → 401 */
export async function requireAdmin(ctx) {
  const session = await getSession(ctx.req);
  if (!session) throw new HttpError(401, 'unauthorized', 'ต้องเข้าสู่ระบบแอดมินก่อน');
  return session;
}
