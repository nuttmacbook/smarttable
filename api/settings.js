// GET /api/settings  (แอดมินเท่านั้น) → 200 { settings:{ publicMode:{enabled, hideTeacherNames:null|true|false}, confirmedAt, updatedAt, updatedBy, revision } }
//   ยังไม่เคยบันทึก = ค่าเริ่มต้น { enabled:true, hideTeacherNames:null (ถือเป็นซ่อน), confirmedAt:null, …, revision:0 }
// PUT /api/settings  (แอดมินเท่านั้น; CSRF + JSON เหมือน endpoint เขียนอื่น)
//   body { revision:int, publicMode:{ enabled?:boolean, hideTeacherNames?:boolean } } — ส่งเฉพาะช่องที่จะเปลี่ยน (อย่างน้อย 1) · hideTeacherNames ส่งได้เฉพาะ true/false (ห้าม null)
//   200 { settings } (ค่าใหม่ทั้งก้อน พร้อม revision ใหม่) · 409 { error:'conflict', latestRevision } revision ไม่ตรง (มีคนบันทึกไปก่อน)
//   422 { error:'invalid', errors:[{type,message,field}] } ชนิดผิด/ช่องแปลก/ไม่มี revision · 400 body ไม่ใช่ JSON object · 401 · 403 CSRF
// เก็บที่ tt:settings + ตัวนับ tt:srev (นอก state ตาราง ไม่ขยับ tt:v) · audit 'settings.update' · มีผลทันที
import { route, readJson, MAX_BODY } from '../server/http.js';
import { getRedis } from '../server/redis.js';
import { requireAdmin } from '../server/session.js';
import { getSettings, parseSettingsInput, putSettings } from '../server/settings.js';

export default route('settings', {
  GET: async (ctx) => {
    await requireAdmin(ctx);
    return { body: { settings: await getSettings(await getRedis()) } };
  },
  PUT: async (ctx) => {
    const session = await requireAdmin(ctx);
    const body = await readJson(ctx.req, MAX_BODY);
    const input = parseSettingsInput(body);
    const settings = await putSettings(await getRedis(), { username: session.username, ip: ctx.ip }, input);
    return { body: { settings } };
  },
});
