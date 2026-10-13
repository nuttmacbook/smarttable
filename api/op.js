// POST /api/op  { op, baseVersion[, returnState][, dryRun] }  (แอดมินเท่านั้น)
//   200 { version, noop, summary, destructive, revokedShares, changes, warnings, remaining, ...ผลเสริมของ op (plan/trimmed/report) [, state] [, snapshotVersion] }
//   409 { error:'conflict', latestVersion } · 422 { error:'invalid', errors:[{type,message,...}] } · 400 โครงคำขอ/op ไม่รู้จัก
// เซิร์ฟเวอร์ตรวจซ้ำทุก op ด้วย applyOp ตัวเดียวกับไคลเอนต์ (js/ops.js) แล้วเขียนแบบ CAS บน tt:v พร้อม audit
// entry.placeMany / entry.removeMany: op เดียว = CAS เดียว = version +1 · audit 1 รายการ (placed/rejected/removed เป็นตัวเลข) · เพดาน 200 ต่อ op (applyOp)
//   policy:'all' มีช่องไม่ผ่าน → 422 { error:'invalid', errors:[…], items:[{index,day,period,ok,errors?}], rejected:[…] }
//   dryRun (op.dryRun หรือ body.dryRun) → 200 { dryRun:true, wouldSucceed, items, placed, rejected, affected, warnings, errors? } ไม่เขียน/ไม่เพิ่ม version/ไม่เขียน audit
// dryRun:true → ตรวจ + สรุปจำนวนที่จะเปลี่ยน/ลบ (summary) โดยไม่เขียนอะไร (ให้ UI ใช้บอกจำนวนก่อนยืนยัน)
import { route, HttpError, readJson, parseBaseVersion, MAX_BODY } from '../server/http.js';
import { getRedis } from '../server/redis.js';
import { requireAdmin } from '../server/session.js';
import { runOp, responseFor } from '../server/store.js';
import { OP_TYPES } from '../js/ops.js';

const BATCH_OPS = new Set(['entry.placeMany', 'entry.removeMany']);
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

export default route('op', {
  POST: async (ctx) => {
    const session = await requireAdmin(ctx);
    const body = await readJson(ctx.req, MAX_BODY);
    const baseVersion = parseBaseVersion(body.baseVersion);
    const { op } = body;
    if (!isObject(op) || typeof op.type !== 'string') throw new HttpError(400, 'bad_request', 'op ต้องเป็น object ที่มี type');
    if (!OP_TYPES.includes(op.type)) throw new HttpError(400, 'unknown_op', 'ไม่รู้จัก op นี้', { errors: [{ type: 'unknown_op', message: 'ไม่รู้จัก op นี้' }] });

    if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') throw new HttpError(400, 'bad_request', 'dryRun ต้องเป็น true/false');
    // op หลายช่อง: ทางหลักของ dry run คือ op.dryRun (ใน op) — dryRun ระดับคำขอถูกแปลงเป็น op.dryRun ให้ได้รายงานรายช่องเหมือนกันทั้งสองทาง
    const send = BATCH_OPS.has(op.type) && body.dryRun === true ? { ...op, dryRun: true } : op;
    const done = await runOp(await getRedis(), { username: session.username, ip: ctx.ip }, send, baseVersion, { dryRun: body.dryRun === true });
    return { body: responseFor(done, { returnState: body.returnState === true }) };
  },
});
