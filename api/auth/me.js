// GET /api/auth/me → 200 { admin:true, username, settings } เมื่อล็อกอิน (settings = ค่าเดียวกับ GET /api/settings) · 401 { error:'unauthorized' } เมื่อไม่ได้ล็อกอิน
import { route } from '../../server/http.js';
import { getRedis } from '../../server/redis.js';
import { requireAdmin } from '../../server/session.js';
import { getSettings } from '../../server/settings.js';

export default route('auth/me', {
  GET: async (ctx) => {
    const session = await requireAdmin(ctx);
    return { body: { admin: true, username: session.username, settings: await getSettings(await getRedis()) } };
  },
});
