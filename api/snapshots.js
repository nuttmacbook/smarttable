// สำรองก่อนการทำลายล้าง + audit (แอดมินเท่านั้น, อ่านอย่างเดียว)
//   GET                    → 200 { snapshots:[{ version, createdAt, reason, bytes }], audit:[{ t, u, type, v, ip }] }   snapshot ล่าสุด ≤ 5 ชุด (หมดอายุ 30 วัน) · audit ล่าสุด 50 รายการ (เก็บได้ ≤ 500)
//   GET ?version=<n>       → 200 { version, createdAt, reason, state } ดาวน์โหลด state ณ version นั้น (ใช้ย้อนกลับด้วย POST /api/migrate {state, force:true}) · ไม่มี/หมดอายุ → 404
// snapshot ถูกถ่ายใน CAS เดียวกับ migrate force / import แบบ replace / trimOverHours เสมอ
import { route, HttpError } from '../server/http.js';
import { getRedis } from '../server/redis.js';
import { requireAdmin } from '../server/session.js';
import { listSnapshots, readSnapshot, recentAudit } from '../server/store.js';

export default route('snapshots', {
  GET: async (ctx) => {
    await requireAdmin(ctx);
    const redis = await getRedis();
    if (ctx.query.version !== undefined) {
      const version = Number(ctx.query.version);
      if (!Number.isSafeInteger(version) || version < 1) throw new HttpError(400, 'bad_request', 'version ต้องเป็นจำนวนเต็มตั้งแต่ 1');
      const snap = await readSnapshot(redis, version);
      if (!snap) throw new HttpError(404, 'not_found', 'ไม่พบ snapshot นี้ (อาจหมดอายุแล้ว)');
      return { body: snap };
    }
    return { body: { snapshots: await listSnapshots(redis), audit: await recentAudit(redis, 50) } };
  },
});
