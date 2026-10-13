// ที่เก็บ state ใน Redis + แปลง op → การเขียนแบบ compare-and-set (SPEC v4 ข้อ 7 + ข้อ 14)
// ใช้ js/ops.js (applyOp), js/scheduler.js, js/store.js ร่วมกับไคลเอนต์ — import จากที่เดียว ไม่ copy
//
// โครง key (ตัดสินใจ: แยก entries ต่อกลุ่มเรียนตั้งแต่แรก):
//   tt:v                 จำนวนเต็ม version (INCR ในสคริปต์ CAS เท่านั้น)
//   tt:meta              {"stateVersion":4,"updatedAt":ISO}
//   tt:subjects|teachers|groups|rooms|plans   JSON array
//   tt:levels            JSON array ของชื่อระดับ (v5) · ไม่มี key (ฐานข้อมูลรุ่น v4) → loadAll สร้างด้วย deriveLevels แล้วเขียน key นี้ในการเขียนครั้งแรก
//   tt:entries:<groupId> JSON array ของคาบทั้งหมดของกลุ่มนั้น (ไม่ชนเพดาน 1 MB ต่อคำสั่ง · op หนึ่งครั้งเขียนแค่กลุ่มที่เปลี่ยน)
//   tt:shares (HASH)     shareId → {hash, scope, label, createdAt, expiresAt}      ← ดัชนีลิงก์ (list/revoke/regenerate)
//   share:<sha256>       {id, scope, label, createdAt, expiresAt}                  ← ทางเข้าของผู้ดู (ไม่มี plaintext token)
//   tt:snaps / tt:snap:<version>:<i>   snapshot ก่อน op ทำลายล้าง (gzip+base64 แบ่ง chunk) ล่าสุด 5 ชุด หมดอายุ 30 วัน
//   tt:audit (LIST)      audit log ล่าสุด ≤ 500 รายการ (เวลา, username, ชนิด op, version, hash ของ IP)
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { HttpError } from './http.js';
import { CAS_LUA, AUDIT_MAX } from './redis.js';
import { ipFingerprint } from './auth.js';
import { STATE_VERSION } from '../js/constants.js';
import { emptyState, deriveLevels, migrateState } from '../js/store.js';
import { applyOp, diffState } from '../js/ops.js';
import { effectiveTeacherId } from '../js/scheduler.js';

const V_KEY = 'tt:v';
const META_KEY = 'tt:meta';
const COLLECTIONS = ['subjects', 'teachers', 'groups', 'rooms', 'plans'];
const KEY = Object.fromEntries(COLLECTIONS.map((k) => [k, `tt:${k}`]));
const LEVELS_KEY = 'tt:levels'; // v5: รายชื่อระดับที่แอดมินกำหนด (JSON array ของ string) — เก็บแยกจาก collection เพราะไม่ใช่รายการ object
// คีย์ระดับบนสุดของ state ที่เซิร์ฟเวอร์เก็บลง Redis ได้ — คีย์อื่นที่โผล่ใน state (เช่นฟีเจอร์ใหม่) ต้องเพิ่มที่นี่พร้อมวิธีเก็บ ไม่งั้น planWrites ปฏิเสธ (กัน "op สำเร็จแต่ข้อมูลหาย")
const PERSISTED_TOP_KEYS = new Set(['version', 'entries', 'levels', ...COLLECTIONS]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const entriesKey = (groupId) => `tt:entries:${groupId}`;

export const SHARES_INDEX = 'tt:shares';
export const shareKey = (hash) => `share:${hash}`;
export const AUDIT_KEY = 'tt:audit';
export const SNAP_INDEX = 'tt:snaps';
const snapKey = (version, i) => `tt:snap:${version}:${i}`;
const SNAP_KEEP = 5;
const SNAP_CHUNK_CHARS = 700 * 1000;
const SNAP_TTL_SECONDS = 30 * 24 * 60 * 60;

export const MAX_VALUE_BYTES = 900 * 1000; // ค่าเดียวต่อ key (เพดานคำขอ Upstash ≈ 1 MB)
const stageThreshold = 700 * 1000; // ผลรวมเกินนี้ → ส่งค่าผ่าน key ชั่วคราวก่อน แล้วค่อย EVAL เล็ก ๆ ย้ายเข้าที่ + CAS

export const conflictError = (latestVersion) =>
  new HttpError(409, 'conflict', 'มีผู้แก้ไขพร้อมกัน โปรดโหลดข้อมูลล่าสุดแล้วลองใหม่', { latestVersion });
const busyError = () => new HttpError(503, 'busy', 'ระบบไม่ว่างชั่วคราว โปรดลองใหม่อีกครั้ง', {}, { 'Retry-After': '1' });

/* ---------- อ่าน */
function parseList(text, what) {
  if (text === null || text === undefined) return [];
  let v;
  try { v = JSON.parse(text); } catch { v = null; }
  if (!Array.isArray(v)) throw new Error(`ข้อมูล ${what} ใน Redis เสีย`);
  return v;
}

function parseLevelsList(text) {
  if (text === null || text === undefined) return null; // ยังไม่มี key (ฐานข้อมูลรุ่นก่อน v5)
  let v;
  try { v = JSON.parse(text); } catch { v = null; }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error('ข้อมูล levels ใน Redis เสีย');
  return v;
}

/** version ปัจจุบัน (ไม่มี key = 0) */
export async function getVersion(redis) {
  const v = await redis.get(V_KEY);
  const n = v === null ? 0 : Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error('tt:v ไม่ใช่จำนวนเต็ม');
  return n;
}

/**
 * อ่าน state ทั้งก้อน + version อย่างสอดคล้องกัน (อ่าน tt:v ก่อน/หลัง ถ้าเปลี่ยนระหว่างอ่านให้ลองใหม่)
 * ฐานข้อมูลว่าง → { version: 0, state: null }
 */
export async function loadAll(redis) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const v1 = await redis.get(V_KEY);
    const version = v1 === null ? 0 : Number(v1);
    if (!Number.isInteger(version) || version < 0) throw new Error('tt:v ไม่ใช่จำนวนเต็ม');
    if (version === 0) return { version: 0, state: null };

    const cols = await redis.mget(...COLLECTIONS.map((k) => KEY[k]), LEVELS_KEY);
    const state = { version: STATE_VERSION };
    COLLECTIONS.forEach((k, i) => { state[k] = parseList(cols[i], k); });
    const storedLevels = parseLevelsList(cols[COLLECTIONS.length]);
    const levelsPersisted = storedLevels !== null;
    if (levelsPersisted) state.levels = storedLevels;
    const groupIds = state.groups.map((g) => g.id).filter((id) => ID_RE.test(String(id)));
    const perGroup = groupIds.length ? await redis.mget(...groupIds.map(entriesKey)) : [];
    const v2 = await redis.get(V_KEY);
    if (v2 !== v1) continue; // มีคนเขียนระหว่างอ่าน → อ่านใหม่
    state.entries = perGroup.flatMap((text, i) => parseList(text, `entries ของกลุ่ม ${groupIds[i]}`));
    if (levelsPersisted) return { version, state, levelsPersisted };
    // ไม่มี key (ฐานข้อมูลรุ่น v4) → อัปเกรดในหน่วยความจำด้วย migrateState (v4→v5: levels = ค่าเริ่มต้น + ระดับที่มีใช้ และแก้ชื่อระดับผิดรูปให้ตรงกัน — โดม)
    // storedState = สิ่งที่อยู่ใน Redis จริง (ไม่มี levels) ให้ planWrites เทียบกับมัน → การเขียนครั้งแรกที่มีการเปลี่ยนแปลงจะเขียน tt:levels
    // และ collection/entries ที่ migrate ปรับ (เช่นแก้ชื่อระดับผิดรูป) ใน CAS เดียวกัน ไม่ทิ้ง levels ใหม่คู่กับข้อมูลเก่าที่ไม่ตรงกัน · ถ้า migrate ล้ม ถอยไป deriveLevels
    let upgraded;
    try {
      const m = migrateState({ version: 4, subjects: state.subjects, teachers: state.teachers, groups: state.groups, rooms: state.rooms, plans: state.plans, entries: state.entries });
      upgraded = m && Array.isArray(m.levels) ? { ...m, version: STATE_VERSION } : null;
    } catch { upgraded = null; }
    return { version, state: upgraded ?? { ...state, levels: deriveLevels(state) }, levelsPersisted, storedState: state };
  }
  throw busyError();
}

/* ---------- เขียน */
const json = (x) => JSON.stringify(x);

function entriesByGroup(state) {
  const map = new Map();
  for (const g of state.groups) map.set(g.id, []);
  for (const e of state.entries) {
    if (!map.has(e.groupId)) map.set(e.groupId, []); // ข้อมูลที่ตรวจแล้วไม่ควรเกิด — กันไว้ไม่ให้คาบหาย
    map.get(e.groupId).push(e);
  }
  return map;
}

/** ทุกคีย์ระดับบนสุดของ state ต้องเป็นชนิดที่เซิร์ฟเวอร์รู้วิธีเก็บ — ไม่งั้น throw (ดีกว่าเขียนสำเร็จแล้วข้อมูลหายเงียบ ๆ) */
function assertPersistable(state) {
  const unknown = Object.keys(state ?? {}).filter((k) => !PERSISTED_TOP_KEYS.has(k));
  if (unknown.length) throw new Error(`state มีคีย์ที่เซิร์ฟเวอร์ยังไม่รู้วิธีเก็บ: ${unknown.join(', ')}`);
}

/**
 * รายการเขียน [{key, value|null}] ที่ต้องทำเพื่อเปลี่ยนจาก before (หรือ null = ว่าง) เป็น after — เฉพาะ key ที่เปลี่ยน + tt:meta
 * levelsPersisted:false (ฐานข้อมูลรุ่นก่อน v5 ยังไม่มี tt:levels) → เขียน tt:levels ด้วยในการเขียนครั้งแรกที่มีการเปลี่ยนแปลงอื่น (op ที่ไม่เปลี่ยนอะไรยังไม่เขียน)
 */
export function planWrites(before, after, { levelsPersisted = true } = {}) {
  assertPersistable(after);
  const writes = [];
  for (const k of COLLECTIONS) {
    if (!before || json(before[k]) !== json(after[k])) writes.push({ key: KEY[k], value: json(after[k]) });
  }
  const levelsChanged = Array.isArray(after.levels) && (!before || json(before.levels) !== json(after.levels));
  const beforeBy = before ? entriesByGroup(before) : new Map();
  const afterBy = entriesByGroup(after);
  for (const [gid, list] of afterBy) {
    const prev = beforeBy.get(gid) ?? [];
    if (json(prev) === json(list) && before) continue;
    if (list.length === 0) {
      if (beforeBy.has(gid) && prev.length > 0) writes.push({ key: entriesKey(gid), value: null });
    } else writes.push({ key: entriesKey(gid), value: json(list) });
  }
  for (const [gid, prev] of beforeBy) {
    if (!afterBy.has(gid) && prev.length > 0) writes.push({ key: entriesKey(gid), value: null }); // กลุ่มถูกลบ
  }
  if (Array.isArray(after.levels) && (levelsChanged || (!levelsPersisted && writes.length > 0))) writes.push({ key: LEVELS_KEY, value: json(after.levels) });
  if (writes.length > 0) writes.push({ key: META_KEY, value: json({ stateVersion: STATE_VERSION, updatedAt: new Date().toISOString() }) });
  return writes;
}

/**
 * การเขียนที่ต้องทำเพื่อไปสู่ state ใหม่จากที่ loadAll อ่านมา
 *  - ไม่มีการเปลี่ยนแปลงจริงเมื่อเทียบกับ state ที่อัปเกรดแล้ว (noop) → ไม่เขียนอะไรเลย แม้ฐานยังเป็นรุ่น v4 (op ที่ไม่เปลี่ยนอะไรต้องไม่ขยับ version)
 *  - มีการเปลี่ยนแปลงจริง → เทียบกับ storedState (ของจริงใน Redis) เพื่อเขียน tt:levels + ส่วนที่ migrate ปรับ ใน CAS เดียวกัน
 */
function planFor(cur, after) {
  if (planWrites(cur.state, after).length === 0) return [];
  return planWrites(cur.storedState ?? cur.state, after, { levelsPersisted: cur.levelsPersisted });
}

const modeOf = (w) => w.mode ?? (w.value === null ? 'D' : 'S');

/**
 * เขียนแบบ compare-and-set ด้วย Lua EVAL: tt:v == baseVersion ถึงเขียน (ทุก key ในสคริปต์เดียว)
 *   bump:true (ค่าเริ่ม) = INCR tt:v ด้วย · bump:false = "เขียนแบบตรวจ version" (ลิงก์แชร์: ไม่ทำให้ client ของแอดมินติด 409)
 * รายการเขียน: {key, value|null} (SET/DEL) หรือ {key, mode:'H'|'F'|'L', value} (HDEL field / HSET "field\nvalue" / LPUSH audit)
 * @returns {{ok:true, version:number} | {ok:false, latestVersion:number}}
 */
export async function commit(redis, baseVersion, writes, { bump = true } = {}) {
  const sized = writes.filter((w) => w.value !== null && modeOf(w) !== 'H');
  for (const w of sized) {
    if (Buffer.byteLength(w.value, 'utf8') > MAX_VALUE_BYTES) {
      throw new HttpError(413, 'payload_too_large', 'ข้อมูลส่วนนี้ใหญ่เกินกว่าที่ระบบเก็บต่อหนึ่งรายการได้');
    }
  }
  const total = sized.reduce((sum, w) => sum + Buffer.byteLength(w.value, 'utf8'), 0);
  const staged = total > stageThreshold;
  const stageId = crypto.randomBytes(8).toString('hex');

  const targets = [];
  const stagedKeys = [];
  const args = [];
  let i = 0;
  for (const w of writes) {
    targets.push(w.key);
    const mode = modeOf(w);
    if (mode === 'S' && staged) {
      const stagedKey = `tt:stage:${stageId}:${i}`;
      await redis.set(stagedKey, w.value, { ex: 600 }); // หมดอายุเองถ้าค้าง
      stagedKeys.push(stagedKey);
      args.push('R', stagedKey);
    } else args.push(mode, w.value ?? '');
    i += 1;
  }

  let res;
  try {
    res = await redis.eval(CAS_LUA, [V_KEY, ...targets, ...stagedKeys], [String(baseVersion), bump ? '1' : '0', String(writes.length), ...args]);
  } catch (err) {
    if (stagedKeys.length) await redis.del(...stagedKeys).catch(() => {});
    throw err;
  }
  if (Number(res[0]) === 1) return { ok: true, version: Number(res[1]) };
  if (stagedKeys.length) await redis.del(...stagedKeys);
  if (Number(res[0]) === 2) return { ok: false, guard: true }; // เงื่อนไข G ไม่ผ่าน (ดัชนีลิงก์เปลี่ยนระหว่างอ่านกับเขียน) — ผู้เรียกอ่านใหม่แล้วลองซ้ำ
  return { ok: false, latestVersion: Number(res[1]) };
}

/* ---------- ตัวนับ "ดัชนีลิงก์เปลี่ยน" (tt:sv) — WB-01
 * op ที่เพิกถอนลิงก์ (ลบกลุ่ม/ครู/ห้อง, import, migrate) อ่านดัชนีลิงก์ก่อนเขียน ถ้าระหว่างนั้นมีการสร้าง/เพิกถอน/สร้างใหม่ลิงก์แทรก
 * (ซึ่งไม่ขยับ tt:v) ลิงก์ใหม่จะหลุดรอบเพิกถอน จึงให้ทุกการเปลี่ยนดัชนีลิงก์ INCR tt:sv และให้ op เหล่านั้นใส่เงื่อนไข G ว่า tt:sv ยังเท่าเดิม */
export const SV_KEY = 'tt:sv';
export const bumpShareGen = () => ({ key: SV_KEY, mode: 'B', value: '' });
export const shareGenGuard = (value) => ({ key: SV_KEY, mode: 'G', value: String(value) });
export async function getShareGen(redis) {
  return (await redis.get(SV_KEY)) ?? '0';
}

/* ---------- audit */
/** รายการเขียน audit (ต้องอยู่ใน CAS เดียวกับการเปลี่ยนแปลง) — ไม่เก็บ secret: เวลา, username, ชนิด, version, hash ของ IP */
export function auditWrite(ctx, type, version, counts = {}) {
  return {
    key: AUDIT_KEY,
    mode: 'L',
    value: json({ t: new Date().toISOString(), u: ctx.username, type, v: version, ip: ipFingerprint(ctx.ip), ...counts }),
  };
}

/** จำนวนที่ audit ของ op หลายช่องบันทึก (1 รายการต่อ op): placed/rejected/removed — เฉพาะตัวเลข ไม่เก็บ id หรือข้อความ */
export function auditCounts(result) {
  const out = {};
  if (Array.isArray(result?.placed)) out.placed = result.placed.length;
  if (Array.isArray(result?.rejected)) out.rejected = result.rejected.length;
  if (Number.isInteger(result?.removed)) out.removed = result.removed;
  return out;
}

export async function recentAudit(redis, n = 50) {
  const rows = await redis.lrange(AUDIT_KEY, 0, Math.min(n, AUDIT_MAX) - 1);
  return (rows ?? []).map((text) => { try { return JSON.parse(text); } catch { return null; } }).filter(Boolean);
}

/* ---------- snapshot (W-12) */
const parseIndex = (text) => { try { const v = JSON.parse(text); return Array.isArray(v) ? v : []; } catch { return []; } };

/** รายการเขียนสำหรับ snapshot ของ state ปัจจุบัน (อยู่ใน CAS เดียวกับ op ทำลายล้าง) · เก็บล่าสุด 5 ชุด ชุดเก่ากว่าถูกลบในครั้งเดียวกัน */
async function snapshotWrites(redis, cur, reason) {
  const text = JSON.stringify(cur.state);
  const b64 = zlib.gzipSync(text).toString('base64');
  const chunks = [];
  for (let i = 0; i < b64.length; i += SNAP_CHUNK_CHARS) chunks.push(b64.slice(i, i + SNAP_CHUNK_CHARS));
  const entry = { version: cur.version, chunks: chunks.length, bytes: Buffer.byteLength(text, 'utf8'), createdAt: new Date().toISOString(), reason };
  const index = parseIndex(await redis.get(SNAP_INDEX));
  const kept = [entry, ...index.filter((e) => e.version !== cur.version)];
  const writes = chunks.map((value, i) => ({ key: snapKey(cur.version, i), value }));
  writes.push({ key: SNAP_INDEX, value: json(kept.slice(0, SNAP_KEEP)) });
  for (const old of kept.slice(SNAP_KEEP)) for (let i = 0; i < old.chunks; i += 1) writes.push({ key: snapKey(old.version, i), value: null });
  return { writes, expireKeys: chunks.map((_, i) => snapKey(cur.version, i)), entry };
}

async function expireSnapshot(redis, keys) {
  for (const k of keys) await redis.expire(k, SNAP_TTL_SECONDS).catch(() => {}); // best-effort: ถ้าพลาด snapshot ค้างจนถูกชุดใหม่ดันออก (เก็บแค่ 5 ชุด)
}

export async function listSnapshots(redis) {
  return parseIndex(await redis.get(SNAP_INDEX)).map(({ version, createdAt, reason, bytes }) => ({ version, createdAt, reason, bytes }));
}

/** state ณ version ที่ snapshot ไว้ (แอดมินดาวน์โหลด) · ไม่มี → null */
export async function readSnapshot(redis, version) {
  const entry = parseIndex(await redis.get(SNAP_INDEX)).find((e) => e.version === version);
  if (!entry) return null;
  const parts = await redis.mget(...Array.from({ length: entry.chunks }, (_, i) => snapKey(version, i)));
  if (parts.some((p) => p === null)) return null; // หมดอายุ/ถูกลบ
  try { return { version, createdAt: entry.createdAt, reason: entry.reason, state: JSON.parse(zlib.gunzipSync(Buffer.from(parts.join(''), 'base64')).toString('utf8')) }; } catch { return null; }
}

/* ---------- ลบเอนทิตี = เพิกถอนลิงก์ที่ชี้ id นั้น (W-05) */
const idsOf = (state, k) => new Set((state?.[k] ?? []).map((r) => r.id));
const SCOPE_KINDS = { group: 'groups', teacher: 'teachers', room: 'rooms' };

/** รายการเขียนที่เพิกถอนลิงก์ (share:<hash> + ดัชนี) ของกลุ่ม/ครู/ห้องที่หายไประหว่าง before → after */
async function revocationWrites(redis, before, after) {
  const removed = new Set();
  for (const [kind, k] of Object.entries(SCOPE_KINDS)) {
    const now = idsOf(after, k);
    for (const id of idsOf(before, k)) if (!now.has(id)) removed.add(`${kind}:${id}`);
  }
  if (removed.size === 0) return [];
  const all = (await redis.hgetall(SHARES_INDEX)) ?? {};
  const writes = [];
  for (const [id, text] of Object.entries(all)) {
    let rec = null;
    try { rec = JSON.parse(text); } catch { /* รายการเสีย: ข้าม */ }
    if (rec && removed.has(rec.scope)) {
      writes.push({ key: shareKey(rec.hash), value: null });
      writes.push({ key: SHARES_INDEX, mode: 'H', value: id });
    }
  }
  return writes;
}

/* ---------- op */
// result.items/rejected (placeMany policy:'all' ที่มีช่องไม่ผ่าน) ส่งกลับไปด้วย ให้ UI ทำรายงานรายช่อง
const toHttpErrors = (errors, result = {}) => {
  const unknown = errors.some((e) => e.type === 'unknown_op');
  const detail = Array.isArray(result.items) ? { items: result.items, rejected: result.rejected ?? [] } : {};
  return new HttpError(unknown ? 400 : 422, unknown ? 'unknown_op' : 'invalid', unknown ? 'ไม่รู้จัก op นี้' : 'ข้อมูลไม่ผ่านการตรวจสอบ', { errors, ...detail });
};

// changes.levels (v5) ไม่ใช่แถวมี id: รูป { replace:[ชื่อระดับทั้งหมดใหม่] } → รายงาน replace=จำนวนระดับใหม่ (คง upsert/remove = 0 ให้รูปเดียวกับ collection อื่น)
const summarize = (changes) => Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, Array.isArray(c?.replace)
  ? { upsert: 0, remove: 0, replace: c.replace.length }
  : { upsert: c.upsert.length, remove: c.remove.length }]));

/**
 * ใช้ op กับ state ปัจจุบันแล้วเขียนแบบ CAS (พร้อม audit; ลิงก์ของเอนทิตีที่ถูกลบถูกเพิกถอนใน CAS เดียวกัน;
 * state.import แบบ replace / trimOverHours ถ่าย snapshot ก่อน)
 * baseVersion ไม่ตรงกับ version ปัจจุบัน → 409 โดยไม่รัน op · op ไม่ผ่าน → 400/422 และไม่เขียนอะไร
 * dryRun:true → ตรวจ+สรุปจำนวนที่จะเปลี่ยน/ลบ แต่ไม่เขียน
 * @param {{username:string, ip:string}} ctx
 */
export async function runOp(redis, ctx, op, baseVersion, { dryRun = false } = {}) {
  // วนซ้ำเมื่อดัชนีลิงก์ (tt:sv) เปลี่ยนระหว่างอ่านกับเขียน (มีคนสร้าง/เพิกถอนลิงก์แทรก) — อ่านใหม่แล้วคำนวณรอบเพิกถอนอีกครั้ง (WB-01)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const cur = await loadAll(redis);
    if (cur.version !== baseVersion) throw conflictError(cur.version);
    const result = applyOp(cur.state ?? emptyState(), op); // ตรวจซ้ำที่เซิร์ฟเวอร์เสมอ (โครงสร้าง + validateAll รวม hours)
    if (!result.ok) throw toHttpErrors(result.errors, result);
    // op หลายช่องที่มี dryRun:true ใน op เอง (result.dryRun) = ตรวจอย่างเดียว เหมือน dryRun ระดับคำขอ: ไม่เขียน/ไม่เพิ่ม version/ไม่เขียน audit
    if (result.dryRun === true) dryRun = true;
    const writes = planFor(cur, result.state);
    const summary = summarize(result.changes);
    const destructive = op.type === 'state.import' && (op.state !== undefined || op.trimOverHours === true) && cur.state !== null;
    const gen = await getShareGen(redis); // ต้องอ่านก่อนอ่านดัชนีลิงก์
    const revoke = writes.length ? await revocationWrites(redis, cur.state, result.state) : [];

    if (dryRun) return { dryRun: true, version: cur.version, result, noop: writes.length === 0, summary, destructive, revokedShares: revoke.length / 2 };
    if (writes.length === 0) return { version: cur.version, result, noop: true, summary, destructive: false, revokedShares: 0 };

    const snap = destructive ? await snapshotWrites(redis, cur, op.trimOverHours === true ? 'import-trim' : 'import-replace') : null;
    const all = [shareGenGuard(gen), ...writes, ...revoke, ...(revoke.length ? [bumpShareGen()] : []), ...(snap?.writes ?? []), auditWrite(ctx, op.type, baseVersion + 1, auditCounts(result))];
    const out = await commit(redis, baseVersion, all);
    if (out.guard) continue;
    if (!out.ok) throw conflictError(out.latestVersion);
    if (snap) await expireSnapshot(redis, snap.expireKeys);
    return { version: out.version, result, noop: false, summary, destructive, revokedShares: revoke.length / 2, snapshotVersion: snap ? snap.entry.version : undefined };
  }
  throw busyError();
}

/** ส่วนของผลที่ส่งกลับไคลเอนต์ (ไม่ส่ง state ทั้งก้อน ยกเว้นขอ returnState) */
export function responseFor(done, { returnState = false } = {}) {
  const { ok, state, ...rest } = done.result;
  const { version, noop, summary, destructive, revokedShares, snapshotVersion, dryRun } = done;
  return {
    ...(dryRun ? { dryRun: true } : {}),
    version, noop, summary, destructive, revokedShares,
    ...(snapshotVersion !== undefined ? { snapshotVersion } : {}),
    ...rest,
    ...(returnState ? { state } : {}),
  };
}

/** เขียนทับทั้งฐานข้อมูลด้วย state ที่ตรวจแล้ว (migrate) — ฐานว่างเท่านั้น เว้นแต่ force (ถ่าย snapshot ก่อนทับ) */
export async function replaceAll(redis, ctx, nextState, { force = false, dryRun = false } = {}) {
  for (let attempt = 0; attempt < 4; attempt += 1) { // วนซ้ำเมื่อดัชนีลิงก์เปลี่ยนระหว่างอ่านกับเขียน (WB-01)
    const cur = await loadAll(redis);
    if (cur.version !== 0 && !force) {
      throw new HttpError(409, 'not_empty', 'ฐานข้อมูลมีข้อมูลอยู่แล้ว ต้องยืนยันการเขียนทับ (force)', { latestVersion: cur.version });
    }
    const writes = planFor(cur, nextState);
    const summary = summarize(diffState(cur.state ?? emptyState(), nextState));
    const destructive = cur.state !== null;
    const gen = await getShareGen(redis);
    const revoke = writes.length ? await revocationWrites(redis, cur.state, nextState) : [];
    if (dryRun) return { dryRun: true, version: cur.version, noop: writes.length === 0, summary, destructive, revokedShares: revoke.length / 2 };
    if (writes.length === 0) return { version: cur.version, noop: true, summary, destructive: false, revokedShares: 0 };

    const snap = destructive ? await snapshotWrites(redis, cur, 'migrate-force') : null;
    const out = await commit(redis, cur.version, [
      shareGenGuard(gen), ...writes, ...revoke, ...(revoke.length ? [bumpShareGen()] : []), ...(snap?.writes ?? []), auditWrite(ctx, 'migrate', cur.version + 1),
    ]);
    if (out.guard) continue;
    if (!out.ok) throw conflictError(out.latestVersion);
    if (snap) await expireSnapshot(redis, snap.expireKeys);
    return { version: out.version, noop: false, summary, destructive, revokedShares: revoke.length / 2, snapshotVersion: snap ? snap.entry.version : undefined };
  }
  throw busyError();
}

/* ---------- มุมมองผู้ดู (กรองตาม scope) */
/**
 * คืน state ที่มีเฉพาะ entry ใน scope + ชื่อกลุ่ม/วิชา/ครู/ห้องที่จำเป็นต่อการแสดง
 * ไม่มีแผนการเรียน (plans = []) · การอ้างอิงที่หลุดนอก scope ถูกตัดออก (subjectIds/teacherIds กรอง, planId = null) ให้ state ยังผ่าน parseState
 * @param {object} state state เต็ม
 * @param {string} scope 'all' | 'group:<id>' | 'teacher:<id>' | 'room:<id>'
 */
export function viewFor(state, scope) {
  if (scope === 'all') return { ...state };
  const [kind, id] = [scope.slice(0, scope.indexOf(':')), scope.slice(scope.indexOf(':') + 1)];
  let entries;
  if (kind === 'group') entries = state.entries.filter((e) => e.groupId === id);
  else if (kind === 'teacher') entries = state.entries.filter((e) => effectiveTeacherId(state, e) === id);
  else if (kind === 'room') entries = state.entries.filter((e) => e.roomId === id);
  else entries = [];

  const groupIds = new Set(entries.map((e) => e.groupId));
  const subjectIds = new Set(entries.map((e) => e.subjectId));
  const teacherIds = new Set(entries.map((e) => effectiveTeacherId(state, e)).filter(Boolean));
  const roomIds = new Set(entries.map((e) => e.roomId).filter(Boolean));
  if (kind === 'group') groupIds.add(id);
  if (kind === 'teacher') teacherIds.add(id);
  if (kind === 'room') roomIds.add(id);

  const subjects = state.subjects.filter((s) => subjectIds.has(s.id)).map((s) => ({ ...s, teacherIds: (s.teacherIds ?? []).filter((t) => teacherIds.has(t)) }));
  return {
    version: state.version,
    ...(Array.isArray(state.levels) ? { levels: [...state.levels] } : {}), // รายชื่อระดับ (v5) ส่งครบ: ไม่ใช่ข้อมูลส่วนบุคคล และไคลเอนต์ใช้ตรวจ/เรียงกลุ่ม
    subjects,
    teachers: state.teachers.filter((t) => teacherIds.has(t.id)),
    groups: state.groups.filter((g) => groupIds.has(g.id)).map((g) => ({ ...g, subjectIds: (g.subjectIds ?? []).filter((s) => subjectIds.has(s)), planId: null })),
    rooms: state.rooms.filter((r) => roomIds.has(r.id)),
    plans: [],
    entries,
  };
}

/** scope ต้องมีเป้าหมายอยู่จริงใน state (ใช้ตอนสร้างลิงก์แชร์) */
export function scopeTargetExists(state, scope) {
  if (scope === 'all') return true;
  const i = scope.indexOf(':');
  const k = SCOPE_KINDS[scope.slice(0, i)];
  const id = scope.slice(i + 1);
  return Array.isArray(state?.[k]) && state[k].some((x) => x.id === id);
}
