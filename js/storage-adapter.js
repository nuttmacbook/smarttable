// ตัวเก็บข้อมูลเดียว: remote (api/ ผ่าน api-client ของฟ้า) — production-only (O20) ไม่มีโหมด local/localStorage
// ไม่มี dependency ไม่อ่าน import.meta/env
//
//   const adapter = createStorageAdapter({ apiClient })
//   const { state, version, legacyViolations } = await adapter.load()
//   const r = await adapter.apply({ type: 'entry.place', ... })   // ทุกการแก้ไขผ่าน op
//   adapter.predict(op)                                           // ทำนายผล (applyOp บน state ที่ cache) ไม่แตะ network
//
// สัญญากับ apiClient — ฟ้าเป็นเจ้าของ js/api-client.js:
//   apiClient.getState() -> Promise<{ version:number, state:object }>
//   apiClient.postOp({ op, baseVersion }) -> Promise<{ status:number, body:object }>   (ไม่ throw ตาม HTTP status; throw เมื่อเครือข่ายล้ม)
//     200 { version, state? | changes? } · 409 { latestVersion } · 422 { errors:[...] } · 401/403 ไม่ได้ล็อกอิน/ไม่มีสิทธิ์
import { applyOp, applyChanges, summarizeChanges } from './ops.js';
import { emptyState, legacyViolations, uid } from './store.js';

// entry.place ที่ไม่มี id: สร้างฝั่งไคลเอนต์ก่อนส่ง เพื่อให้ทำนายซ้ำ/ส่งซ้ำ (409 retry) ได้ id เดิม
const withId = (op) => (op && op.type === 'entry.place' && op.id === undefined ? { ...op, id: uid('e') } : op);

const fail = (errors, extra = {}) => ({ ok: false, errors, ...extra });
const CONFLICT_MSG = 'มีผู้แก้ไขพร้อมกัน โปรดตรวจสอบ';

export function createStorageAdapter({ apiClient } = {}) {
  if (!apiClient || typeof apiClient.getState !== 'function' || typeof apiClient.postOp !== 'function') {
    throw new Error('ต้องส่ง apiClient ที่มี getState() และ postOp()');
  }
  let state = emptyState();
  let version = 0;

  const networkError = () => fail([{ type: 'network', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ลองใหม่อีกครั้ง' }], { offline: true });

  async function load() {
    try {
      const res = await apiClient.getState();
      state = res.state;
      version = res.version;
      return { state, version, legacyViolations: legacyViolations(state) };
    } catch {
      return networkError();
    }
  }

  async function send(op) {
    let res;
    try {
      res = await apiClient.postOp({ op, baseVersion: version });
    } catch {
      return networkError();
    }
    const { status, body = {} } = res;
    if (status === 200 && op && op.dryRun === true) {
      // dryRun: เซิร์ฟเวอร์ไม่เขียน/ไม่เพิ่ม version — ส่งรายงานให้ UI โดยไม่แตะ state/version ในเครื่อง
      return { ok: true, dryRun: true, ...body };
    }
    if (status === 200) {
      // ลำดับความเชื่อ: state เต็มจากเซิร์ฟเวอร์ > delta (changes) จากเซิร์ฟเวอร์ > ทำนายเอง
      // ใช้ delta ของเซิร์ฟเวอร์ก่อนทำนาย เพื่อให้ id/ผลตรงกับเซิร์ฟเวอร์เสมอ (เช่น id ที่สร้างอัตโนมัติ)
      let next = body.state;
      let predicted = null;
      if (!next && body.changes) next = applyChanges(state, body.changes);
      if (!next) {
        predicted = applyOp(state, op);
        next = predicted.ok ? predicted.state : null;
      }
      if (!next) return fail([{ type: 'stale', message: 'ข้อมูลไม่ตรงกับเซิร์ฟเวอร์ โปรดโหลดใหม่' }], { stale: true });
      const prev = state;
      state = next;
      version = body.version ?? version + 1;
      return {
        ok: true,
        state,
        version,
        changes: body.changes ?? predicted?.changes,
        warnings: body.warnings ?? predicted?.warnings ?? [],
        affected: body.affected ?? predicted?.affected ?? summarizeChanges(prev, next),
        ...(body.trimmed ?? predicted?.trimmed ? { trimmed: body.trimmed ?? predicted.trimmed } : {}),
      };
    }
    if (status === 409) {
      return fail([{ type: 'conflict', message: CONFLICT_MSG }], { conflict: true, latestVersion: body.latestVersion, status });
    }
    if (status === 422) {
      const errors = Array.isArray(body.errors) && body.errors.length ? body.errors : [{ type: 'invalid', message: 'เซิร์ฟเวอร์ปฏิเสธรายการนี้' }];
      return fail(errors, { status });
    }
    if (status === 401 || status === 403) {
      return fail([{ type: 'auth', message: status === 401 ? 'ยังไม่ได้เข้าสู่ระบบแอดมิน' : 'ไม่มีสิทธิ์แก้ไข (โหมดดูอย่างเดียว)' }], { status });
    }
    return fail([{ type: 'server', message: 'เซิร์ฟเวอร์ขัดข้อง ลองใหม่อีกครั้ง' }], { status });
  }

  return {
    mode: 'remote',
    getState: () => state,
    getVersion: () => version,
    legacyViolations: () => legacyViolations(state),
    load,
    predict: (op) => applyOp(state, op),
    // 409: โหลด state ใหม่ → ทำนาย op ซ้ำ → ถ้าไม่ชนส่งอีกครั้งเดียว มิฉะนั้นคืน conflict ให้ UI แสดงข้อความ
    async apply(rawOp, { retry = true } = {}) {
      const op = withId(rawOp);
      const r = await send(op);
      if (r.ok || !r.conflict || !retry) return r;
      const fresh = await load();
      if (fresh.ok === false) return fresh;
      if (!applyOp(state, op).ok) return r;
      return send(op);
    },
    async clear() {
      return this.apply({ type: 'state.import', state: emptyState(), mode: 'replace' });
    },
  };
}
