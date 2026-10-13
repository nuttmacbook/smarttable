// POST /api/migrate  { state, force?, dryRun? }  (แอดมินเท่านั้น, body ≤ 4 MB)
// อัปโหลด state เดิม (localStorage / ไฟล์ JSON v1–v4) → migrate → ตรวจโครงสร้าง → เขียนเมื่อ "ฐานข้อมูลยังว่าง" เท่านั้น
// ฐานไม่ว่าง: 409 { error:'not_empty', latestVersion } เว้นแต่ force:true (แอดมินยืนยันเขียนทับ — ถ่าย snapshot ก่อนทับเสมอ)
//   200 { version, noop, migrated, counts, summary, destructive, revokedShares, remaining:[...], remainingCount, snapshotVersion? }
//     remaining = ข้อมูลเดิมที่ผิดกฎอยู่แล้ว (legacy เฉพาะ hours เกิน) — ไม่ทิ้ง แต่ op ที่ไม่ใช่การซ่อมจะถูกบล็อกจนกว่าจะแก้
//   422 { errors } เมื่อ state ผิดโครง/เวอร์ชันไม่รู้จัก หรือมีข้อมูลผิดกฎนอกจาก hours (force ก็ข้ามไม่ได้)
import { route, HttpError, readJson, MAX_IMPORT_BODY } from '../server/http.js';
import { getRedis } from '../server/redis.js';
import { requireAdmin } from '../server/session.js';
import { replaceAll } from '../server/store.js';
import { parseState } from '../js/store.js';
import { validateAll } from '../js/scheduler.js';

const REMAINING_LIMIT = 50;

export default route('migrate', {
  POST: async (ctx) => {
    const session = await requireAdmin(ctx);
    const body = await readJson(ctx.req, MAX_IMPORT_BODY);
    if (!Object.hasOwn(body, 'state')) throw new HttpError(400, 'bad_request', 'ต้องระบุ state');
    if (body.force !== undefined && typeof body.force !== 'boolean') throw new HttpError(400, 'bad_request', 'force ต้องเป็น true/false');

    const parsed = parseState(body.state);
    if (!parsed.ok) {
      throw new HttpError(422, 'invalid', 'ข้อมูลไม่ผ่านการตรวจสอบ', { errors: parsed.errors.map((message) => ({ type: 'invalid', message })) });
    }
    const state = parsed.state;
    // ยอมให้ผ่านเฉพาะ hours เกินที่เป็นข้อมูลเดิม (legacy); ชนครู/ห้อง/กลุ่ม, อ้างอิงขาด ฯลฯ คือข้อมูลเสีย → 422
    const conflicts = validateAll(state).map(({ type, message }) => ({ type, message }));
    const fatal = conflicts.filter((c) => c.type !== 'hours');
    if (fatal.length) {
      throw new HttpError(422, 'invalid', 'ข้อมูลไม่ผ่านการตรวจสอบ', { errors: fatal.slice(0, REMAINING_LIMIT), errorCount: fatal.length });
    }

    const out = await replaceAll(await getRedis(), { username: session.username, ip: ctx.ip }, state, { force: body.force === true, dryRun: body.dryRun === true });
    return {
      body: {
        ...out,
        migrated: Boolean(parsed.migrated),
        counts: Object.fromEntries(['subjects', 'teachers', 'groups', 'rooms', 'plans', 'entries'].map((k) => [k, state[k].length])),
        remaining: conflicts.slice(0, REMAINING_LIMIT),
        remainingCount: conflicts.length,
      },
    };
  },
});
