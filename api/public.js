// GET /api/public  (ไม่ต้องล็อกอิน — ไม่รับ/ไม่สนใจ cookie, header โทเค็น และ query ในการให้สิทธิ์หรือเลือกข้อมูล)
//   200 { version, settings:{ publicMode:{ enabled:true, hideTeacherNames: null|true|false } }, state }   state = ตารางทั้งสถานศึกษาที่กรองแล้ว (server/settings.js publicStateFor)
//       ฐานว่าง: { version:0, settings, state:null }
//   304 เมื่อ If-None-Match ตรงกับ ETag ปัจจุบัน (ไม่มี body) · ETag ผูกกับ tt:v + ค่า hideTeacherNames — สลับค่า/แก้ตารางแล้วเปลี่ยนทันที
//   403 { error:'public-disabled' } — แอดมินปิดโหมดสาธารณะ (ตรวจ settings ทุกคำขอก่อนใช้ ETag จึงไม่มี 304 ข้ามการปิด)
//   429 + Retry-After — เกิน 300 ครั้ง/นาที/IP (ตัวนับแยกจากผู้ดูลิงก์; ปรับด้วย PUBLIC_RATE_LIMIT) · นับก่อนแตะข้อมูล
//   503 — อ่าน settings หรือ state จาก Redis ไม่ได้ (fail-closed: ไม่คืนข้อมูลบางส่วน และไม่ตกไปเป็น "แสดงชื่อครู")
// ซ่อนชื่อครู (effectiveHide = hideTeacherNames !== false; ค่าเริ่มต้น null = ซ่อน): ตัด teachers, teacherIds, teacherId, note, plans · ดู server/settings.js
// ไม่ส่ง: plans, บัญชีแอดมิน, ลิงก์แชร์, audit, snapshot, confirmedAt/updatedAt/updatedBy/revision · ปลายทางนี้อ่านอย่างเดียว (POST/PUT/DELETE → 405)
import { route, HttpError } from '../server/http.js';
import { getRedis } from '../server/redis.js';
import { checkPublicRate } from '../server/auth.js';
import { getSettings, effectiveHide, publicStateFor, publicEtag } from '../server/settings.js';
import { loadAll, getVersion } from '../server/store.js';

const unavailable = () => new HttpError(503, 'unavailable', 'ระบบขัดข้องชั่วคราว โปรดลองใหม่ภายหลัง', {}, { 'Retry-After': '5' });
const guarded = async (fn) => {
  try { return await fn(); } catch (err) {
    if (err instanceof HttpError) throw err;
    console.error(`[api] public: อ่านข้อมูลไม่ได้ (${err?.name ?? 'Error'})`); // ไม่ log ข้อความ/ข้อมูล
    throw unavailable();
  }
};

export default route('public', {
  GET: async (ctx) => {
    const redis = await getRedis();
    await checkPublicRate(redis, ctx.ip);
    const reader = await getRedis({ readOnly: true });
    const settings = await guarded(() => getSettings(reader));
    if (!settings.publicMode.enabled) throw new HttpError(403, 'public-disabled', 'ผู้ดูแลปิดการเข้าชมสาธารณะ');
    const hide = effectiveHide(settings);
    const shown = { publicMode: { enabled: true, hideTeacherNames: settings.publicMode.hideTeacherNames } };

    const version = await guarded(() => getVersion(reader));
    const etag = publicEtag(version, settings.publicMode.hideTeacherNames);
    const headers = { ETag: etag, 'Cache-Control': 'no-cache' }; // ห้าม public/s-maxage — ผู้ชมต้องตรวจกับเซิร์ฟเวอร์ทุกครั้ง (ซึ่งตรวจ settings ก่อน)
    if (ctx.req.headers?.['if-none-match'] === etag) return { status: 304, body: {}, headers };

    const { version: loaded, state } = await guarded(() => loadAll(reader));
    // ถ้าตารางเปลี่ยนระหว่างอ่าน version กับ loadAll ให้ ETag ตามที่โหลดจริง (กันคู่ ETag/ข้อมูลไม่ตรงกัน)
    if (loaded !== version) headers.ETag = publicEtag(loaded, settings.publicMode.hideTeacherNames);
    return { body: { version: loaded, settings: shown, state: state === null ? null : publicStateFor(state, { hide }) }, headers };
  },
});
