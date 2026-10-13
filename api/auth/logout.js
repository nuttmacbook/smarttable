// POST /api/auth/logout → 200 { ok:true } · ลบเซสชันฝั่งเซิร์ฟเวอร์ทันที + ล้างคุกกี้ (ไม่มีเซสชันก็ตอบ 200 เหมือนกัน)
import { route } from '../../server/http.js';
import { destroySession, clearCookieHeader } from '../../server/session.js';

export default route('auth/logout', {
  POST: async ({ req }) => {
    await destroySession(req);
    return { body: { ok: true }, headers: { 'Set-Cookie': clearCookieHeader() } };
  },
});
