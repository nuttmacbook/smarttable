// บัญชีแอดมิน + รหัสผ่าน (scrypt ของ node:crypto) + rate limit การ login/การดู (SPEC v4 ข้อ 7 + ข้อ 14 W-01, W-06, W-09)
// รูปแบบ hash: scrypt$N$r$p$saltB64$hashB64 (N=2^15, r=8, p=1, salt 16 ไบต์, key 64 ไบต์ — base64 มาตรฐาน)
// ADMIN_ACCOUNTS = "username:scryptHash;username2:scryptHash2" (สร้างด้วย npm run hash-password)
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Buffer } from 'node:buffer';
import { HttpError, ConfigError } from './http.js';
import { RATE_LUA } from './redis.js';

const scrypt = promisify(crypto.scrypt);

export const SCRYPT = { N: 2 ** 15, r: 8, p: 1, saltBytes: 16, keyBytes: 64 };
export const SCRYPT_LIMITS = { Nmin: 2 ** 12, Nmax: 2 ** 17, rMax: 16, pMax: 4 }; // ค่าสูงสุดที่ยอมรับจากสตริง hash (W-01)
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256; // กัน DoS จากรหัสผ่านยาวมาก
const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Node ปฏิเสธ scrypt ที่หน่วยความจำเกิน maxmem (ค่าเริ่มต้น 32 MiB = N=2^15,r=8 พอดีขอบ → ERR_CRYPTO_INVALID_SCRYPT_PARAMS)
// ต้องตั้ง maxmem ≥ 128·N·r·2 ทั้งตอน hash และ verify (W-01)
const maxmemFor = (N, r, p) => 128 * N * r * 2 * p;

/** สร้าง hash ใหม่ (ใช้ใน scripts/hash-password.mjs) */
export async function hashPassword(password) {
  const { N, r, p, saltBytes, keyBytes } = SCRYPT;
  const salt = crypto.randomBytes(saltBytes);
  const key = await scrypt(password, salt, keyBytes, { N, r, p, maxmem: maxmemFor(N, r, p) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${Buffer.from(key).toString('base64')}`;
}

/** แยก hash — null ถ้ารูปแบบ/พารามิเตอร์ไม่ปลอดภัยหรือผิด (N ต้องเป็นกำลัง 2) */
function parseHash(stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const okParams = Number.isInteger(N) && N >= SCRYPT_LIMITS.Nmin && N <= SCRYPT_LIMITS.Nmax && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= SCRYPT_LIMITS.rMax && Number.isInteger(p) && p >= 1 && p <= SCRYPT_LIMITS.pMax;
  if (!okParams) return null;
  const salt = Buffer.from(parts[4], 'base64');
  const hash = Buffer.from(parts[5], 'base64');
  if (salt.length < 8 || hash.length < 16 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

/** เทียบรหัสผ่านกับ hash ด้วย timingSafeEqual (ตรวจความยาวก่อน) — รูปแบบ hash ผิด/รหัสผ่านผิดชนิด = false ไม่ throw */
export async function verifyPassword(password, stored) {
  const h = parseHash(stored);
  if (!h || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const key = Buffer.from(await scrypt(password, h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmemFor(h.N, h.r, h.p) }));
  return key.length === h.hash.length && crypto.timingSafeEqual(key, h.hash);
}

/* ---------- บัญชี */
let cachedRaw = null;
let cachedAccounts = new Map();

/** อ่าน ADMIN_ACCOUNTS (cache ตามค่า env) คืน Map<username, hash> · รายการที่รูปแบบผิดถูกข้าม (ไม่ log เนื้อหา) */
export function getAccounts() {
  const raw = process.env.ADMIN_ACCOUNTS ?? '';
  if (raw === cachedRaw) return cachedAccounts;
  const accounts = new Map();
  // ผู้ใช้มักวางทั้งบรรทัดที่สคริปต์พิมพ์ ("ADMIN_ACCOUNTS=user:hash") หรือใส่เครื่องหมายคำพูดครอบ ลงในช่องค่าของ Vercel — ยอมรับสองแบบนี้ (ไม่กระทบความปลอดภัย: hash ยังต้องผ่าน parseHash)
  // `\$` → `$`: ไฟล์ .env ที่ Vite อ่าน (dotenv-expand) ขยาย $… เป็นตัวแปร ต้องเขียนแฮชเป็น \$ (scripts/hash-password.mjs พิมพ์รูปนี้ให้) — ตัวอ่านที่ไม่ขยายจะเหลือ \ ไว้ จึงตัดให้ที่นี่ (แฮชจริงไม่มี \)
  const cleaned = raw.trim().replace(/^ADMIN_ACCOUNTS\s*=\s*/, '').replace(/^(["'])([\s\S]*)\1$/, '$2').replaceAll('\\$', '$');
  const skipped = [];
  cleaned.split(';').forEach((item, index) => {
    const text = item.trim();
    if (text === '') return; // ; ท้ายค่า/ซ้อนกัน ไม่ใช่รายการเสีย
    const i = text.indexOf(':');
    const username = i < 1 ? '' : text.slice(0, i).trim();
    const hash = i < 1 ? '' : text.slice(i + 1).trim();
    if (!USERNAME_RE.test(username) || !parseHash(hash)) {
      skipped.push(`#${index + 1}${USERNAME_RE.test(username) ? ` (${username})` : ''}`);
      return;
    }
    const key = normalizeUsername(username); // username ไม่แยกตัวพิมพ์เล็ก/ใหญ่
    if (accounts.has(key)) throw new ConfigError(`ADMIN_ACCOUNTS มี username ซ้ำเมื่อไม่แยกตัวพิมพ์: ${key}`);
    accounts.set(key, hash);
  });
  // เตือนครั้งเดียวต่อค่า env (ไม่ log แฮช/รหัสผ่าน — เฉพาะลำดับและชื่อบัญชีที่ผ่านรูปแบบ) เพื่อให้ผู้ดูแลเห็นใน Vercel Logs ว่ารายการไหนถูกข้าม
  if (skipped.length) console.warn(`[auth] ADMIN_ACCOUNTS: ข้ามรายการที่รูปแบบผิด ${skipped.join(', ')} (ต้องเป็น username:scrypt$N$r$p$salt$hash)`);
  cachedRaw = raw;
  cachedAccounts = accounts;
  return accounts;
}

/** username ที่ใช้เทียบ/เก็บในเซสชัน: ตัวพิมพ์เล็กทั้งหมด */
export const normalizeUsername = (username) => String(username).toLowerCase();

const sha256hex = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** เวอร์ชันรหัสผ่านของบัญชี = sha256 ย่อของ hash ใน env — เปลี่ยนรหัสผ่าน/ลบบัญชี = เซสชันเดิมใช้ไม่ได้ (W-07) · ไม่มีบัญชี → null */
export function pwdVersionOf(username) {
  const hash = typeof username === 'string' ? getAccounts().get(normalizeUsername(username)) : undefined;
  return hash ? sha256hex(hash).slice(0, 16) : null;
}

// hash หลอกต้นทุนเท่าของจริง — ใช้เทียบเมื่อไม่มี username · คำนวณล่วงหน้าได้ด้วย warmDummyHash() (login.js เรียกตอนโหลดโมดูล)
// ไม่คำนวณตั้งแต่ import auth.js เพราะ session.js (ทุก endpoint แอดมิน) import ไฟล์นี้ด้วย ไม่ควรเสีย scrypt ทุก cold start
let dummyHashPromise = null;
export function warmDummyHash() {
  dummyHashPromise ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  dummyHashPromise.catch(() => {}); // ไม่ให้เป็น unhandled rejection ถ้าล้ม (จะ throw อีกครั้งเมื่อใช้จริงใน authenticate)
  return dummyHashPromise;
}

/** ตรวจ username+password · ใช้เวลาใกล้เคียงกันทั้งกรณี username ไม่มี/รหัสผิด */
export async function authenticate(username, password) {
  const stored = typeof username === 'string' ? (getAccounts().get(normalizeUsername(username)) ?? null) : null; // Map: ชื่ออย่าง constructor ไม่ชน prototype
  const ok = await verifyPassword(password, stored ?? await warmDummyHash());
  return stored !== null && ok;
}

/* ---------- rate limit (Lua อะตอมมิก INCR+EXPIRE) */
export const LOGIN_LIMITS = {
  userIp: { attempts: 5, windowSeconds: 15 * 60 }, // ต่อ IP+username
  user: { attempts: 20, windowSeconds: 15 * 60 }, // ต่อ username รวมทุก IP (สูงกว่า) — แลกกับการที่ผู้โจมตีกระจาย IP ทำให้แอดมินถูกล็อกชั่วคราวได้
  ip: { attempts: 30, windowSeconds: 15 * 60 }, // ต่อ IP (กันไล่เดาหลาย username)
  global: { attempts: 300, windowSeconds: 15 * 60 }, // ทั้งระบบ
};
export const VIEW_LIMIT = { attempts: 120, windowSeconds: 60 }; // ผู้ดู ต่อ IP ต่อนาที (W-09)

const ipKey = (ip) => sha256hex(String(ip));

/** นับหนึ่งครั้ง คืนวินาทีที่ต้องรอ (0 = ผ่าน) */
async function consume(redis, key, { attempts, windowSeconds }) {
  const res = await redis.eval(RATE_LUA, [key], [String(windowSeconds)]);
  const count = Number(res[0]);
  const ttl = Math.max(1, Number(res[1]));
  return count > attempts ? ttl : 0;
}

const tooMany = (wait) => new HttpError(
  429, 'rate_limited', 'ลองบ่อยเกินไป โปรดรอสักครู่แล้วลองใหม่',
  {}, { 'Retry-After': String(wait) }, // เวลารอไปกับ header เท่านั้น — body คงที่ (ขนาดเท่ากันทุกกรณี)
);

/**
 * ตรวจ rate limit ของ login **ก่อนเรียก scrypt** (W-06): นับทุกความพยายาม (กัน brute force แบบขนาน) เกินเกณฑ์ข้อใดข้อหนึ่ง → 429 + Retry-After
 * key เก็บเป็น SHA-256 (ไม่มี IP/ชื่อดิบ)
 */
export async function checkLoginRate(redis, ip, username) {
  const name = String(username).toLowerCase();
  const waits = [
    await consume(redis, `rl:login:ui:${sha256hex(`${ip}|${name}`)}`, LOGIN_LIMITS.userIp),
    await consume(redis, `rl:login:u:${sha256hex(name)}`, LOGIN_LIMITS.user),
    await consume(redis, `rl:login:ip:${ipKey(ip)}`, LOGIN_LIMITS.ip),
    await consume(redis, 'rl:login:all', LOGIN_LIMITS.global),
  ];
  const wait = Math.max(...waits);
  if (wait > 0) throw tooMany(wait);
}

/** login สำเร็จ → ล้างตัวนับของ IP+username นั้น (ตัวนับอื่นปล่อยให้หมดอายุเอง) */
export async function clearLoginRate(redis, ip, username) {
  await redis.del(`rl:login:ui:${sha256hex(`${ip}|${String(username).toLowerCase()}`)}`);
}

/** ผู้ดู (โทเค็นแชร์): จำกัดต่อ IP ก่อนแตะข้อมูล (W-09) */
export async function checkViewerRate(redis, ip) {
  const wait = await consume(redis, `rl:view:ip:${ipKey(ip)}`, VIEW_LIMIT);
  if (wait > 0) throw tooMany(wait);
}

/**
 * โหมดสาธารณะ (GET /api/public): ตัวนับ "แยก" จากผู้ดูลิงก์ และสูงกว่า — โรงเรียนทั้งแห่งอยู่หลัง NAT เดียว (V5-03)
 * ค่าเริ่มต้น 300 ครั้ง/นาที/IP · ปรับด้วย env PUBLIC_RATE_LIMIT (จำนวนเต็ม 10–100000; ค่าอื่นใช้ค่าเริ่มต้น)
 */
export function publicRateLimit() {
  const n = Number(process.env.PUBLIC_RATE_LIMIT);
  return { attempts: Number.isInteger(n) && n >= 10 && n <= 100000 ? n : 300, windowSeconds: 60 };
}

export async function checkPublicRate(redis, ip) {
  const wait = await consume(redis, `rl:pub:ip:${ipKey(ip)}`, publicRateLimit());
  if (wait > 0) throw tooMany(wait);
}

/** hash ของ IP สำหรับ audit log (ย่อ 16 ตัว, ผูกกับ token ของฐานข้อมูล เพื่อไม่ให้ brute force ย้อนกลับจากพื้นที่ IPv4 ได้ง่าย) */
export const ipFingerprint = (ip) => sha256hex(`${ip}|${process.env.UPSTASH_REDIS_REST_TOKEN ?? 'tt'}`).slice(0, 16);
