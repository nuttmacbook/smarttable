// GET /api/state
//   แอดมิน (cookie)                 → 200 { role:'admin', version, state, empty }   (ฐานว่าง: version 0, state null, empty true)
//   ผู้ดู (header X-Share-Token เท่านั้น — ยกเลิก ?share= ตาม W-04) → 200 { role:'viewer', version, scope, label, state }   state มีเฉพาะข้อมูลใน scope
//   ไม่มีทั้งคู่ → 401 · โทเค็นผิดรูปแบบ/ผิด/เพิกถอน/หมดอายุ/ฐานว่าง → 404 { error:'not_found', message:'ลิงก์นี้ใช้ไม่ได้' } ข้อความเดียวกันทุกกรณี
//   เกินเกณฑ์ ต่อ IP ต่อนาที → 429 + Retry-After (นับก่อนแตะข้อมูล)
// ถ้ามีโทเค็นมา จะเป็นเส้นทางผู้ดูเสมอ (ไม่สนคุกกี้) — โทเค็นให้สิทธิ์อ่านใน scope เท่านั้น ไม่มีทางเขียน · header นี้ไม่ถูก log
import { route, HttpError } from '../server/http.js';
import { getRedis } from '../server/redis.js';
import { requireAdmin } from '../server/session.js';
import { checkViewerRate } from '../server/auth.js';
import { isTokenFormat, lookupShare } from '../server/shares.js';
import { loadAll, viewFor, scopeTargetExists } from '../server/store.js';

const notFound = () => new HttpError(404, 'not_found', 'ลิงก์นี้ใช้ไม่ได้');

export default route('state', {
  GET: async (ctx) => {
    const header = ctx.req.headers?.['x-share-token'];
    if (header !== undefined) {
      // 1) รูปแบบ token (ไม่แตะ Redis) → 2) rate limit ต่อ IP → 3) ค้นลิงก์/อ่านข้อมูลด้วย token แบบอ่านอย่างเดียว (ถ้าตั้งไว้)
      if (!isTokenFormat(header)) throw notFound();
      await checkViewerRate(await getRedis(), ctx.ip);
      const reader = await getRedis({ readOnly: true });
      const share = await lookupShare(reader, header);
      const { version, state } = await loadAll(reader);
      // กันไว้อีกชั้น (WB-01): เป้าหมายของลิงก์ต้องยังมีอยู่ใน state ที่โหลดมา ไม่งั้นถือว่าลิงก์ใช้ไม่ได้
      if (!state || !scopeTargetExists(state, share.scope)) throw notFound();
      return { body: { role: 'viewer', version, scope: share.scope, label: share.label, state: viewFor(state, share.scope) } };
    }
    await requireAdmin(ctx);
    const { version, state } = await loadAll(await getRedis());
    return { body: { role: 'admin', version, state, empty: state === null } };
  },
});
