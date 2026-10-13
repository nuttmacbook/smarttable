// ลิงก์แชร์ดูอย่างเดียว (SPEC v4 ข้อ 6–7, ข้อ 14 W-04/W-05/W-18)
//  - token สุ่ม 32 ไบต์ (256 บิต) base64url · เก็บฝั่งเซิร์ฟเวอร์เป็น SHA-256 hex เท่านั้น (ไม่มี plaintext ใน Redis/log/list)
//  - shareId สุ่ม 12 ตัวอักษร (ไม่ลับ ไม่เกี่ยวกับ token) ใช้ list/revoke/regenerate
//  - share:<sha256(token)> = ทางเข้าของผู้ดู · tt:shares (HASH) shareId → ดัชนี
//  - ทุกการสร้าง/เพิกถอน/สร้างใหม่เขียนใน EVAL เดียว (อะตอมมิก) พร้อม audit และ "ตรวจ version" ว่าไม่มี op ลบเอนทิตีแทรก
//    (กันลิงก์ที่ชี้เอนทิตีที่เพิ่งถูกลบ) โดยไม่ขยับ tt:v จึงไม่ทำให้ client ของแอดมินติด 409
import crypto from 'node:crypto';
import { HttpError } from './http.js';
import {
  loadAll, getVersion, commit, scopeTargetExists, auditWrite, bumpShareGen, SHARES_INDEX, shareKey,
} from './store.js';
import { isValidId, sanitizeText, textIssues } from '../js/validate.js';

export const MAX_SHARES = 100;
export const MAX_LABEL_LENGTH = 80;
export const ALL_DEFAULT_DAYS = 90; // ลิงก์ scope all หมดอายุ 90 วันโดยค่าเริ่มต้น (W-18/19)
export const ALL_MAX_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXPIRY_MS = 10 * 365 * DAY_MS;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const TRIES = 4;

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const invalidLink = () => new HttpError(404, 'not_found', 'ลิงก์นี้ใช้ไม่ได้'); // ข้อความเดียวกันทุกกรณี (ผิด/เพิกถอน/หมดอายุ)
const busy = () => new HttpError(503, 'busy', 'ระบบไม่ว่างชั่วคราว โปรดลองใหม่อีกครั้ง', {}, { 'Retry-After': '1' });
const invalid = (type, message) => new HttpError(422, 'invalid', message, { errors: [{ type, message }] });

/** โทเค็นรูปแบบถูกต้องไหม (ตรวจก่อนแตะ Redis — W-09) */
export const isTokenFormat = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** แยก scope: 'all' | 'group:<id>' | 'teacher:<id>' | 'room:<id>' → null ถ้ารูปแบบผิดหรือ id เป็นชื่อสงวน */
export function parseScope(scope) {
  if (scope === 'all') return { kind: 'all' };
  if (typeof scope !== 'string') return null;
  const m = /^(group|teacher|room):(.+)$/.exec(scope);
  return m && isValidId(m[2]) ? { kind: m[1], id: m[2] } : null;
}

export function parseLabel(label) {
  if (label === undefined || label === null) return '';
  const issue = textIssues(label, { max: MAX_LABEL_LENGTH });
  if (issue) throw invalid('label', `ชื่อลิงก์: ${issue}`);
  return sanitizeText(label, { max: MAX_LABEL_LENGTH });
}

/**
 * วันหมดอายุ (ISO string หรือ ms) → ISO string · undefined = ไม่ระบุ · null/'' = ไม่หมดอายุ (scope all ไม่อนุญาต)
 * อดีต/ผิดรูปแบบ/เกิน 10 ปี (หรือเกิน 365 วันสำหรับ all) → 422 (ไม่ throw RangeError)
 */
export function parseExpiresAt(value, { scope, now = Date.now() } = {}) {
  const isAll = scope === 'all';
  if (value === undefined) return isAll ? new Date(now + ALL_DEFAULT_DAYS * DAY_MS).toISOString() : null;
  if (value === null || value === '') {
    if (isAll) throw invalid('expiresAt', `ลิงก์ทั้งหมด (all) ต้องมีวันหมดอายุ (ค่าเริ่มต้น ${ALL_DEFAULT_DAYS} วัน)`);
    return null;
  }
  const t = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) throw invalid('expiresAt', 'วันหมดอายุไม่ถูกต้อง');
  if (t <= now) throw invalid('expiresAt', 'วันหมดอายุต้องเป็นเวลาในอนาคต');
  const limit = isAll ? ALL_MAX_DAYS * DAY_MS : MAX_EXPIRY_MS;
  if (t - now > limit) throw invalid('expiresAt', isAll ? `ลิงก์ทั้งหมด (all) ตั้งวันหมดอายุได้ไม่เกิน ${ALL_MAX_DAYS} วัน` : 'วันหมดอายุไกลเกินไป (ไม่เกิน 10 ปี)');
  return new Date(t).toISOString();
}

export function parseShareId(value) {
  if (typeof value !== 'string' || !SHARE_ID_RE.test(value)) throw new HttpError(400, 'bad_request', 'ต้องระบุ id ของลิงก์ให้ถูกต้อง');
  return value;
}

const publicView = (id, rec, now = Date.now()) => ({
  id,
  label: rec.label,
  scope: rec.scope,
  createdAt: rec.createdAt,
  expiresAt: rec.expiresAt ?? null,
  expired: Boolean(rec.expiresAt) && Date.parse(rec.expiresAt) <= now,
});

const parseRecord = (text) => {
  try {
    const r = JSON.parse(text);
    return r && typeof r === 'object' ? r : null;
  } catch { return null; }
};

const indexWrite = (id, rec) => ({ key: SHARES_INDEX, mode: 'F', value: `${id}\n${JSON.stringify(rec)}` });

/** สร้างลิงก์ใหม่ — คืน { token (เต็ม ครั้งเดียว), share } · ctx = { username, ip } */
export async function createShare(redis, ctx, { scope, label, expiresAt }) {
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    // scope ที่ชี้เอนทิตี: ต้องมีอยู่จริง ณ version ที่จะใช้ตรวจตอนเขียน (op ลบเอนทิตีที่แทรกมาจะทำให้ commit ล้ม แล้ววนตรวจใหม่)
    let version;
    if (scope === 'all') version = await getVersion(redis);
    else {
      const cur = await loadAll(redis);
      if (!scopeTargetExists(cur.state, scope)) throw new HttpError(404, 'not_found', 'ไม่พบกลุ่มเรียน/ครู/ห้องเรียนที่ระบุ');
      version = cur.version;
    }
    if ((await redis.hlen(SHARES_INDEX)) >= MAX_SHARES) throw invalid('limit', `สร้างลิงก์ได้ไม่เกิน ${MAX_SHARES} ลิงก์ โปรดเพิกถอนลิงก์ที่ไม่ใช้ก่อน`);

    const id = crypto.randomBytes(9).toString('base64url');
    const token = newToken();
    const hash = hashToken(token);
    const createdAt = new Date().toISOString();
    const rec = { scope, label, createdAt, expiresAt: expiresAt ?? null };
    const out = await commit(redis, version, [
      { key: shareKey(hash), value: JSON.stringify({ id, ...rec }) },
      indexWrite(id, { hash, ...rec }),
      auditWrite(ctx, 'share.create', version),
      bumpShareGen(), // ให้ op ลบเอนทิตีที่กำลังอ่านดัชนีอยู่เห็นว่าดัชนีเปลี่ยน แล้วอ่านใหม่ (WB-01)
    ], { bump: false });
    if (out.ok) return { token, share: publicView(id, rec) };
  }
  throw busy();
}

export async function listShares(redis) {
  const all = (await redis.hgetall(SHARES_INDEX)) ?? {};
  const now = Date.now();
  return Object.entries(all)
    .map(([id, text]) => [id, parseRecord(text)])
    .filter(([, rec]) => rec)
    .map(([id, rec]) => publicView(id, rec, now))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** เพิกถอนด้วย id · ไม่พบ → 404 · ใช้ไม่ได้ทันที (ลบทางเข้า + ดัชนีในคำสั่งเดียว) */
export async function revokeShare(redis, ctx, id) {
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const version = await getVersion(redis);
    const rec = parseRecord(await redis.hget(SHARES_INDEX, id));
    if (!rec) throw new HttpError(404, 'not_found', 'ไม่พบลิงก์ที่ระบุ');
    const out = await commit(redis, version, [
      { key: shareKey(rec.hash), value: null },
      { key: SHARES_INDEX, mode: 'H', value: id },
      auditWrite(ctx, 'share.revoke', version),
      bumpShareGen(),
    ], { bump: false });
    if (out.ok) return;
  }
  throw busy();
}

/**
 * สร้างใหม่: เพิกถอนโทเค็นเดิม + ออกโทเค็นใหม่ id/scope/label เดิม ในคำสั่งเดียว
 * expiresAt: undefined = ต่ออายุตามค่าเริ่มต้นของ scope (all = +90 วัน; อื่น ๆ คงเดิม) · ค่าอื่นตามที่ parseExpiresAt ตรวจแล้ว
 */
export async function regenerateShare(redis, ctx, id, { expiresAt } = {}) {
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    const cur = await loadAll(redis);
    const rec = parseRecord(await redis.hget(SHARES_INDEX, id));
    if (!rec) throw new HttpError(404, 'not_found', 'ไม่พบลิงก์ที่ระบุ');
    if (rec.scope !== 'all' && !scopeTargetExists(cur.state, rec.scope)) throw new HttpError(404, 'not_found', 'เป้าหมายของลิงก์นี้ถูกลบไปแล้ว');
    const token = newToken();
    const next = {
      scope: rec.scope,
      label: rec.label,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt === undefined ? (rec.scope === 'all' ? parseExpiresAt(undefined, { scope: 'all' }) : rec.expiresAt ?? null) : expiresAt,
    };
    const out = await commit(redis, cur.version, [
      { key: shareKey(rec.hash), value: null },
      { key: shareKey(hashToken(token)), value: JSON.stringify({ id, ...next }) },
      indexWrite(id, { hash: hashToken(token), ...next }),
      auditWrite(ctx, 'share.regenerate', cur.version),
      bumpShareGen(),
    ], { bump: false });
    if (out.ok) return { token, share: publicView(id, next) };
  }
  throw busy();
}

/**
 * หาลิงก์จากโทเค็นของผู้ดู · รูปแบบผิด/ไม่พบ/เพิกถอน/หมดอายุ → 404 ข้อความเดียวกัน (ไม่บอกรายละเอียด)
 * @returns {{id:string, scope:string, label:string}}
 */
export async function lookupShare(redis, token) {
  if (!isTokenFormat(token)) throw invalidLink();
  const rec = parseRecord(await redis.get(shareKey(hashToken(token))));
  if (!rec || typeof rec.scope !== 'string' || !parseScope(rec.scope)) throw invalidLink();
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) throw invalidLink();
  return { id: rec.id, scope: rec.scope, label: rec.label ?? '' };
}
