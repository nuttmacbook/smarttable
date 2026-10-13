// ตั้งค่าระบบ (SPEC v5 ข้อ 16.1 + ข้อ 22 V5-01..06)
//   tt:settings = { publicMode:{ enabled:boolean, hideTeacherNames: true|false|null }, confirmedAt, updatedAt, updatedBy }
//   tt:srev     = ตัวนับ revision ของ settings (INCR ทุกครั้งที่บันทึก) — PUT ต้องส่ง revision ล่าสุด ไม่ตรง → 409 (ตรวจในสคริปต์ CAS เดียวกับการเขียน ด้วยเงื่อนไข G)
// อยู่นอก state ตาราง ไม่นับ version ตาราง · เขียนแบบ CAS ที่ tt:v โดยไม่เพิ่ม version (bump:false) พร้อม audit ใน EVAL เดียวกัน
// V5-01: hideTeacherNames เริ่มต้น null = "ยังไม่ยืนยัน" และถือเป็นซ่อน — ผู้ชมทั่วไปเห็นชื่อครูเมื่อแอดมินตั้ง false เองเท่านั้น (effectiveHide = hideTeacherNames !== false)
// V5-02: fail-closed — ค่าเสีย/ชนิดผิด/ขาด ⇒ ซ่อน · อ่าน Redis ไม่ได้ ⇒ ผู้เรียกตอบ 503 (ไม่ตกไปเป็น "แสดงชื่อครู")
import crypto from 'node:crypto';
import { HttpError } from './http.js';
import { auditWrite, commit, getVersion } from './store.js';

export const SETTINGS_KEY = 'tt:settings';
export const REV_KEY = 'tt:srev';
const PUBLIC_FIELDS = ['enabled', 'hideTeacherNames'];

export const defaultSettings = () => ({
  publicMode: { enabled: true, hideTeacherNames: null },
  confirmedAt: null,
  updatedAt: null,
  updatedBy: null,
  revision: 0,
});

const isoOrNull = (x) => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? x : null);

/** แปลงข้อความใน Redis เป็น settings ที่ปลอดภัย: ช่องที่ขาด/ชนิดผิด → ค่าเริ่มต้นของช่องนั้น (hideTeacherNames ผิด = null = ซ่อน) */
export function normalizeSettings(raw, revision = 0) {
  const def = defaultSettings();
  let s = null;
  if (typeof raw === 'string') { try { s = JSON.parse(raw); } catch { s = null; } }
  const pm = s && typeof s === 'object' && !Array.isArray(s) && s.publicMode && typeof s.publicMode === 'object' && !Array.isArray(s.publicMode) ? s.publicMode : {};
  // V5-02: ถ้าส่วนใดของ publicMode เสีย (enabled ไม่ใช่ boolean, hideTeacherNames ไม่ใช่ true/false/null, ไม่มี publicMode) ถือว่าทั้งก้อนเสีย → ซ่อนชื่อครู
  //  ไม่เชื่อ "false" ที่อยู่ในก้อนที่เสีย · enabled ที่ใช้ไม่ได้ใช้ค่าเริ่มต้น (เปิด) เพราะซ่อนชื่อครูอยู่แล้ว
  const sound = typeof pm.enabled === 'boolean' && (typeof pm.hideTeacherNames === 'boolean' || pm.hideTeacherNames === null);
  return {
    publicMode: {
      enabled: typeof pm.enabled === 'boolean' ? pm.enabled : def.publicMode.enabled,
      hideTeacherNames: sound ? pm.hideTeacherNames : null,
    },
    confirmedAt: isoOrNull(s?.confirmedAt),
    updatedAt: isoOrNull(s?.updatedAt),
    updatedBy: typeof s?.updatedBy === 'string' ? s.updatedBy : null,
    revision,
  };
}

/** ซ่อนชื่อครูหรือไม่ — ซ่อนเสมอ ยกเว้นแอดมินตั้ง false เอง */
export const effectiveHide = (settings) => settings.publicMode.hideTeacherNames !== false;

const revisionOf = (text) => {
  const n = Number(text ?? 0);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

/** อ่านค่า settings + revision (อ่าน revision ก่อน: ถ้ามีการบันทึกแทรก revision จะเก่ากว่าค่า → PUT ที่ใช้มันจะได้ 409 ฝั่งปลอดภัย) · Redis ล้ม = throw */
export async function getSettings(redis) {
  const revision = revisionOf(await redis.get(REV_KEY));
  return normalizeSettings(await redis.get(SETTINGS_KEY), revision);
}

const invalid = (message, field) => new HttpError(422, 'invalid', message, { errors: [{ type: 'invalid', message, field }] });
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * ตรวจ body ของ PUT (V5-06): { revision:int, publicMode:{ enabled?:boolean, hideTeacherNames?:boolean } }
 *  allowlist ทีละคีย์ · ต้องมี publicMode อย่างน้อย 1 ช่อง · hideTeacherNames ส่งได้เฉพาะ true/false (ห้ามส่ง null กลับ) · ต้องมี revision
 * @returns {{ revision:number, patch:object }}
 */
export function parseSettingsInput(body) {
  if (!isObj(body)) throw invalid('body ต้องเป็น object', 'body');
  const extra = Object.keys(body).filter((k) => k !== 'publicMode' && k !== 'revision');
  if (extra.length) throw invalid(`ไม่รู้จักช่อง: ${extra.slice(0, 3).join(', ')}`, extra[0]);
  if (!Number.isInteger(body.revision) || body.revision < 0) throw invalid('ต้องส่ง revision (จำนวนเต็ม) จาก GET /api/settings', 'revision');
  const pm = body.publicMode;
  if (!isObj(pm)) throw invalid('publicMode ต้องเป็น object', 'publicMode');
  const extraPm = Object.keys(pm).filter((k) => !PUBLIC_FIELDS.includes(k));
  if (extraPm.length) throw invalid(`ไม่รู้จักช่องใน publicMode: ${extraPm.slice(0, 3).join(', ')}`, `publicMode.${extraPm[0]}`);
  const patch = {};
  for (const f of PUBLIC_FIELDS) {
    if (!Object.hasOwn(pm, f)) continue;
    if (typeof pm[f] !== 'boolean') throw invalid(`${f} ต้องเป็น true/false`, `publicMode.${f}`);
    patch[f] = pm[f];
  }
  if (Object.keys(patch).length === 0) throw invalid('ต้องส่งอย่างน้อยหนึ่งช่อง (enabled หรือ hideTeacherNames)', 'publicMode');
  return { revision: body.revision, patch };
}

const staleError = (latestRevision) => new HttpError(409, 'conflict', 'ตั้งค่าถูกแก้โดยผู้อื่นไปแล้ว โปรดโหลดใหม่แล้วลองอีกครั้ง', { latestRevision });

/**
 * บันทึก settings + audit ('settings.update') ใน EVAL เดียว · ไม่เพิ่ม tt:v
 *  revision ไม่ตรงกับปัจจุบัน → 409 (ตรวจทั้งก่อนเขียนและในสคริปต์ด้วยเงื่อนไข G กันสองคำขอแทรกกัน)
 *  hideTeacherNames ถูกส่งมา → ตั้ง confirmedAt (แอดมินตัดสินใจเรื่องชื่อครูแล้ว)
 * @returns {Promise<object>} settings ใหม่ (พร้อม revision ใหม่)
 */
export async function putSettings(redis, ctx, { revision, patch }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const version = await getVersion(redis);
    const cur = await getSettings(redis);
    if (cur.revision !== revision) throw staleError(cur.revision);
    const now = new Date().toISOString();
    const next = {
      publicMode: { ...cur.publicMode, ...patch },
      confirmedAt: Object.hasOwn(patch, 'hideTeacherNames') ? now : cur.confirmedAt,
      updatedAt: now,
      updatedBy: ctx.username,
    };
    const out = await commit(redis, version, [
      { key: REV_KEY, mode: 'G', value: String(cur.revision) },
      { key: SETTINGS_KEY, value: JSON.stringify(next) },
      { key: REV_KEY, mode: 'B', value: '' },
      auditWrite(ctx, 'settings.update', version, { hide: next.publicMode.hideTeacherNames === null ? 'unset' : next.publicMode.hideTeacherNames ? 'on' : 'off', public: next.publicMode.enabled ? 'on' : 'off' }),
    ], { bump: false });
    if (out.ok) return { ...next, revision: cur.revision + 1 };
    if (out.guard) throw staleError(revisionOf(await redis.get(REV_KEY))); // มีคนบันทึกแทรกระหว่างอ่านกับเขียน
    // tt:v เปลี่ยน (มีการแก้ตาราง) → อ่านใหม่แล้วลองอีกครั้ง
  }
  throw new HttpError(503, 'busy', 'ระบบไม่ว่างชั่วคราว โปรดลองใหม่อีกครั้ง', {}, { 'Retry-After': '1' });
}

/* ---------- ข้อมูลสาธารณะ (กรองที่เซิร์ฟเวอร์) */
const dropKeys = (obj, keys) => {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
};

/**
 * state สำหรับผู้ชมทั่วไป: subjects/groups/rooms/entries (+ teachers เมื่อไม่ซ่อน) · **ไม่มีคีย์ plans** (groups.planId = null)
 * hide=true (V5-04): ไม่มีคีย์ teachers · subject ไม่มี teacherIds · entry ไม่มี teacherId · ตัดช่องข้อความอิสระ `note` ของ subjects/rooms/groups
 *   (ชื่อครูอาจอยู่ในนั้น) · ไม่มีชื่อ/แผนก/id ครูเหลือใน response · hide=false: ส่ง note ตามเดิม
 */
export function publicStateFor(state, { hide }) {
  const subjects = state.subjects.map((s) => (hide ? dropKeys(s, ['teacherIds', 'note']) : { ...s }));
  const entries = state.entries.map((e) => (hide ? dropKeys(e, ['teacherId']) : { ...e }));
  const groups = state.groups.map((g) => ({ ...dropKeys(g, hide ? ['note'] : []), planId: null }));
  const rooms = state.rooms.map((r) => (hide ? dropKeys(r, ['note']) : { ...r }));
  return {
    version: state.version,
    ...(Array.isArray(state.levels) ? { levels: [...state.levels] } : {}), // รายชื่อระดับ (v5): ไม่ใช่ข้อมูลส่วนบุคคล ส่งเสมอ
    subjects,
    ...(hide ? {} : { teachers: state.teachers.map((t) => ({ ...t })) }),
    groups,
    rooms,
    entries,
  };
}

/** ETag ของผลสาธารณะ: ขึ้นกับ tt:v + ค่า hideTeacherNames ดิบ (ปิดโหมดตอบ 403 ก่อนถึงตรงนี้เสมอ) — ไม่ใช้แคชข้ามการสลับค่า */
export const publicEtag = (version, hideRaw) => `W/"${crypto.createHash('sha256').update(`pub|${version}|${String(hideRaw)}`).digest('hex').slice(0, 24)}"`;
