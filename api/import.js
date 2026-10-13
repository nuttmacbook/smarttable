// POST /api/import  { baseVersion, state | patch | rows, mode?, trimOverHours?, dryRun? }  (แอดมินเท่านั้น, body ≤ 4 MB)
// = op `state.import` (js/ops.js) ที่เซิร์ฟเวอร์ตรวจซ้ำทั้งหมด (โครงสร้าง + validateAll รวม hours) · ไคลเอนต์ parse .xlsx เอง แล้วส่ง rows/ผลของ importer
// เซิร์ฟเวอร์ไม่ parse xlsx · import แบบ replace (state) หรือ trimOverHours ถ่าย snapshot ก่อนเขียน (snapshotVersion ใน response)
//   200 { version, noop, summary, destructive, revokedShares, changes, warnings, remaining, report?, snapshotVersion? } · 409 { latestVersion } · 422 { errors }
import { route, HttpError, readJson, parseBaseVersion, MAX_IMPORT_BODY } from '../server/http.js';
import { getRedis } from '../server/redis.js';
import { requireAdmin } from '../server/session.js';
import { runOp, responseFor } from '../server/store.js';

const IMPORT_FIELDS = ['state', 'patch', 'rows', 'mode', 'trimOverHours'];

export default route('import', {
  POST: async (ctx) => {
    const session = await requireAdmin(ctx);
    const body = await readJson(ctx.req, MAX_IMPORT_BODY);
    const baseVersion = parseBaseVersion(body.baseVersion);
    const op = { type: 'state.import' };
    for (const f of IMPORT_FIELDS) if (Object.hasOwn(body, f)) op[f] = body[f];
    if (op.state === undefined && op.patch === undefined && op.rows === undefined) {
      throw new HttpError(400, 'bad_request', 'ต้องระบุ state, patch หรือ rows อย่างใดอย่างหนึ่ง');
    }
    const done = await runOp(await getRedis(), { username: session.username, ip: ctx.ip }, op, baseVersion, { dryRun: body.dryRun === true });
    return { body: responseFor(done) };
  },
});
