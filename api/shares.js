// ลิงก์แชร์ดูอย่างเดียว (แอดมินเท่านั้น ทุก method)
//   GET                       → 200 { shares:[{ id, label, scope, createdAt, expiresAt|null, expired }] }   ไม่มี token/hash
//   POST { scope, label?, expiresAt? }   → 200 { id, token, share }   token เต็มแสดงครั้งเดียว (ไม่เก็บ plaintext)
//        scope 'all' ไม่ส่ง expiresAt = หมดอายุ +90 วัน (ห้าม null, ไม่เกิน 365 วัน) · scope อื่นไม่ส่ง = ไม่หมดอายุ
//   DELETE { id }  (หรือ ?id=)           → 200 { ok:true, id }          เพิกถอน ใช้ไม่ได้ทันที
//   PUT { id, expiresAt? }               → 200 { id, token, share }     สร้างใหม่ (ต่ออายุ): โทเค็นเก่าใช้ไม่ได้ + ออกโทเค็นใหม่ id/scope/label เดิม
// scope: 'all' | 'group:<id>' | 'teacher:<id>' | 'room:<id>' · ผิดรูปแบบ 422 · เป้าหมายไม่มีอยู่จริง 404
// ลบกลุ่ม/ครู/ห้อง (หรือ import replace) = เพิกถอนลิงก์ที่ชี้ id นั้นอัตโนมัติ (ใน CAS เดียวกับ op นั้น)
import { route, HttpError, readJson } from '../server/http.js';
import { getRedis } from '../server/redis.js';
import { requireAdmin } from '../server/session.js';
import { createShare, listShares, revokeShare, regenerateShare, parseScope, parseLabel, parseExpiresAt, parseShareId } from '../server/shares.js';

const MAX_SHARE_BODY = 16 * 1024;

async function idFrom(ctx) {
  const body = await readJson(ctx.req, MAX_SHARE_BODY, { optional: true });
  return { body, id: parseShareId(body.id ?? ctx.query.id) };
}

export default route('shares', {
  GET: async (ctx) => {
    await requireAdmin(ctx);
    return { body: { shares: await listShares(await getRedis()) } };
  },

  POST: async (ctx) => {
    const session = await requireAdmin(ctx);
    const body = await readJson(ctx.req, MAX_SHARE_BODY);
    if (!parseScope(body.scope)) {
      throw new HttpError(422, 'invalid', 'ขอบเขตลิงก์ไม่ถูกต้อง', { errors: [{ type: 'scope', message: "scope ต้องเป็น 'all' หรือ 'group:<id>' / 'teacher:<id>' / 'room:<id>'" }] });
    }
    const label = parseLabel(body.label);
    const expiresAt = parseExpiresAt(body.expiresAt, { scope: body.scope });
    const { token, share } = await createShare(await getRedis(), { username: session.username, ip: ctx.ip }, { scope: body.scope, label, expiresAt });
    return { body: { id: share.id, token, share } };
  },

  DELETE: async (ctx) => {
    const session = await requireAdmin(ctx);
    const { id } = await idFrom(ctx);
    await revokeShare(await getRedis(), { username: session.username, ip: ctx.ip }, id);
    return { body: { ok: true, id } };
  },

  PUT: async (ctx) => {
    const session = await requireAdmin(ctx);
    const { body, id } = await idFrom(ctx);
    const redis = await getRedis();
    // ตรวจ expiresAt กับ scope ของลิงก์เดิม: all ห้าม null/เกิน 365 วัน
    const known = (await listShares(redis)).find((s) => s.id === id);
    if (!known) throw new HttpError(404, 'not_found', 'ไม่พบลิงก์ที่ระบุ');
    const expiresAt = Object.hasOwn(body, 'expiresAt') ? parseExpiresAt(body.expiresAt, { scope: known.scope }) : undefined;
    const { token, share } = await regenerateShare(redis, { username: session.username, ip: ctx.ip }, id, { expiresAt });
    return { body: { id, token, share } };
  },
});
