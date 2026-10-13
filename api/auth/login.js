// POST /api/auth/login  { username, password } → 200 { admin:true, username } + Set-Cookie __Host-tt_session
// ข้อความผิดพลาดคงที่ (ไม่บอกว่า username ถูกหรือไม่) · นับความพยายามก่อนตรวจรหัส (429 + Retry-After เมื่อเกินเกณฑ์ ก่อนเรียก scrypt)
import { route, HttpError, ConfigError, readJson } from '../../server/http.js';
import { getRedis } from '../../server/redis.js';
import { authenticate, checkLoginRate, clearLoginRate, getAccounts, normalizeUsername, warmDummyHash } from '../../server/auth.js';
import { createSession, destroySession, cookieHeader } from '../../server/session.js';

const MAX_LOGIN_BODY = 16 * 1024;

warmDummyHash(); // คำนวณ hash หลอกล่วงหน้า (cold start) เพื่อให้เวลาตอบกรณีไม่มี username ใกล้เคียงของจริง

export default route('auth/login', {
  POST: async ({ req, ip }) => {
    const body = await readJson(req, MAX_LOGIN_BODY);
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string' || username === '' || password === '' || username.length > 64) {
      throw new HttpError(400, 'bad_request', 'ต้องระบุชื่อผู้ใช้และรหัสผ่าน');
    }
    if (getAccounts().size === 0) throw new ConfigError('ADMIN_ACCOUNTS ว่างหรือรูปแบบไม่ถูกต้อง (username:scryptHash คั่นด้วย ;)');

    const redis = await getRedis();
    await checkLoginRate(redis, ip, username);
    if (!(await authenticate(username, password))) {
      throw new HttpError(401, 'invalid_credentials', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    await clearLoginRate(redis, ip, username);
    await destroySession(req); // เปลี่ยน token ทุกครั้งที่ login: เซสชันเดิมของคำขอนี้ (ถ้ามี) ถูกลบ
    const canonical = normalizeUsername(username); // username ไม่แยกตัวพิมพ์: เก็บในเซสชัน/ตอบกลับเป็นตัวพิมพ์เล็ก
    const token = await createSession(canonical);
    return { body: { admin: true, username: canonical }, headers: { 'Set-Cookie': cookieHeader(token) } };
  },
});
