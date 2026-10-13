// ตัวเรียก api/ ฝั่งเบราว์เซอร์ (SPEC v4 ข้อ 7) — ไม่เก็บ secret/โทเค็นผู้ดูถาวรในที่ใดนอกหน่วยความจำ
// สัญญา endpoint ตาม SPEC ข้อ 7 และเทียบกับ docs/API.md ของไนน์แล้ว (รูป response ตรงกับเอกสารนั้น; ยังไม่ได้ทดสอบกับเซิร์ฟเวอร์จริง)
// ใช้ fetch ที่ฉีดได้ (ทดสอบใน node)

import { emptyState } from './store.js';

export class ApiError extends Error {
  constructor(status, body, message) {
    super(message || `คำขอไม่สำเร็จ (${status})`);
    this.status = status;
    this.body = body ?? null;
  }
}

const MESSAGES = {
  401: 'ต้องเข้าสู่ระบบแอดมินก่อน',
  403: 'ไม่มีสิทธิ์ทำรายการนี้',
  404: 'ไม่พบข้อมูลที่ขอ',
  409: 'มีผู้แก้ไขพร้อมกัน โปรดตรวจสอบข้อมูลล่าสุดแล้วลองใหม่',
  413: 'ข้อมูลมีขนาดใหญ่เกินกำหนด',
  422: 'ข้อมูลไม่ผ่านการตรวจสอบ',
  429: 'ลองบ่อยเกินไป โปรดรอสักครู่',
};
const messageFor = (status) => MESSAGES[status] ?? (status >= 500 ? 'ระบบขัดข้อง โปรดติดต่อผู้ดูแล' : `คำขอไม่สำเร็จ (${status})`);

export function createApiClient({ fetchImpl = globalThis.fetch?.bind(globalThis), base = '' } = {}) {
  async function request(method, path, { body, query, shareToken, signal } = {}) {
    const url = new URL(base + path, 'http://local.invalid');
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json'; // CSRF: ต้องเป็น json + header ด้านล่าง (SPEC ข้อ 7)
      headers['X-Requested-With'] = 'tt';
    }
    if (shareToken) headers['X-Share-Token'] = shareToken; // ผู้ดูส่งผ่าน header ไม่ใส่ใน URL
    let res;
    try {
      res = await fetchImpl(url.pathname + url.search, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ApiError(0, null, 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (ออฟไลน์?)');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) throw new ApiError(res.status, data, data?.message && typeof data.message === 'string' ? data.message : messageFor(res.status));
    return data;
  }

  return {
    // --- auth ---
    login: (username, password) => request('POST', '/api/auth/login', { body: { username, password } }),
    logout: () => request('POST', '/api/auth/logout', { body: {} }),
    me: () => request('GET', '/api/auth/me'), // 200 { admin:true, username } · 401 เมื่อไม่ได้ล็อกอิน
    // --- state ---
    // แอดมิน: { role:'admin', version, state, empty } (ฐานว่าง: version 0, state null, empty true)
    getState: () => request('GET', '/api/state'),
    // ผู้ดู: { role:'viewer', version, scope, label, state } · โทเค็นผิด/เพิกถอน/หมดอายุ = 404 ข้อความเดียวกัน
    getSharedState: (token) => request('GET', '/api/state', { shareToken: token }),
    // op เดียวต่อคำขอ + baseVersion; 200 {version,state?|delta?} · 409 {latestVersion} · 422 {errors}
    sendOp: (op, baseVersion) => request('POST', '/api/op', { body: { op, baseVersion } }),
    // โหมดสาธารณะ (SPEC v5 ข้อ 16.1): ไม่ต้องล็อกอิน · 200 { version, settings:{publicMode:{enabled,hideTeacherNames}}, state } · 403 { error:'public-disabled' }
    // (รูปตาม docs/API.md)
    getPublic: () => request('GET', '/api/public'),
    // ตั้งค่า (แอดมิน): GET -> { settings }, PUT { publicMode:{enabled,hideTeacherNames} } -> { settings }
    getSettings: () => request('GET', '/api/settings'),
    // publicMode = { enabled?, hideTeacherNames? } เป็น boolean (ห้าม null) ; revision = ค่าจาก GET ล่าสุด (ไม่ตรง → 409 { latestRevision })
    putSettings: (publicMode, revision) => request('PUT', '/api/settings', { body: revision === undefined ? { publicMode } : { publicMode, revision } }),
    // payload ต้องมี baseVersion (+ state|patch|rows, mode?, trimOverHours?)
    importState: (payload) => request('POST', '/api/import', { body: payload }),
    migrate: (state, { force = false } = {}) => request('POST', '/api/migrate', { body: { state, force } }),
    // --- ลิงก์แชร์ (แอดมิน) ---
    listShares: () => request('GET', '/api/shares'),
    // list: { shares:[{id,label,scope,createdAt,expiresAt,expired}] } ไม่มี token · create/regenerate: { id, token, share } (token เต็มได้ครั้งเดียว)
    createShare: ({ scope, label, expiresAt }) => request('POST', '/api/shares', { body: { scope, label, expiresAt } }),
    revokeShare: (id) => request('DELETE', '/api/shares', { body: { id } }),
    regenerateShare: (id, expiresAt) => request('PUT', '/api/shares', { body: expiresAt === undefined ? { id } : { id, expiresAt } }),
  };
}

// สร้างลิงก์ดูอย่างเดียวจากโทเค็น (แสดงเต็มครั้งเดียวตอนสร้าง/สร้างใหม่)
export const shareUrl = (token, origin = globalThis.location?.origin ?? '') => `${origin}/#/view/${token}`;

// อ่านโทเค็นจาก hash '#/view/<token>' (base64url เท่านั้น) · ไม่ตรงรูปแบบ → null
export function parseViewHash(hash) {
  const m = /^#\/view\/([A-Za-z0-9_-]{16,256})\/?$/.exec(hash || '');
  return m ? m[1] : null;
}

// เทียบ scope ของลิงก์: 'all' | 'group:<id>' | 'teacher:<id>' | 'room:<id>'
export function parseScope(scope) {
  if (scope === 'all') return { kind: 'all' };
  const m = /^(group|teacher|room):(.+)$/.exec(scope || '');
  return m ? { kind: m[1], id: m[2] } : null;
}

// อ่านเส้นทางผู้ดูจาก hash: '#/view/<token>' หรือ '#/view/<token>/<page>' · token อยู่ในหน่วยความจำของแอปเท่านั้น (W-04)
export function parseViewRoute(hash) {
  const m = /^#\/view\/([A-Za-z0-9_-]{16,256})(?:\/([a-z-]{1,32}))?\/?$/.exec(hash || '');
  return m ? { token: m[1], page: m[2] || '' } : null;
}

// ตัวห่อให้ตรงสัญญากับ js/storage-adapter.js: getState() -> {version,state}, postOp() -> {status, body}
// (postOp ไม่ throw ตามสถานะ HTTP; throw เฉพาะเครือข่ายล้ม)
export function toAdapterClient(api) {
  return {
    async getState() {
      const res = await api.getState();
      // ฐานว่าง: server ส่ง state:null → ใช้ state ว่างของรุ่นปัจจุบัน (UI เสนอนำเข้าข้อมูล)
      return { version: res.version ?? 0, state: res.state ?? emptyState() };
    },
    async postOp({ op, baseVersion }) {
      try {
        const body = await api.sendOp(op, baseVersion);
        return { status: 200, body: body ?? {} };
      } catch (err) {
        if (err instanceof ApiError && err.status > 0) return { status: err.status, body: err.body ?? {} };
        throw err;
      }
    },
  };
}

// จัดการผลลัพธ์ 409/422 ให้ UI: คืนประเภทที่ UI ใช้ตัดสินใจ
export function classifyOpError(err) {
  if (!(err instanceof ApiError)) return { kind: 'unknown', message: err?.message ?? 'เกิดข้อผิดพลาด' };
  if (err.status === 409) return { kind: 'conflict', latestVersion: err.body?.latestVersion ?? null, message: err.message };
  if (err.status === 422) return { kind: 'invalid', errors: err.body?.errors ?? [], message: err.message };
  if (err.status === 401) return { kind: 'auth', message: err.message };
  if (err.status === 0) return { kind: 'offline', message: err.message };
  return { kind: 'error', message: err.message };
}
