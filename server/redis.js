// ตัวเชื่อม Redis ของ api/** — Upstash Redis (REST) เท่านั้น
// อินเทอร์เฟซ (async): get set del incr expire ttl mget hset hget hdel hgetall hlen lrange eval
// ค่าทุกตัวเป็น string (ไม่ใช้ auto-deserialize ของ @upstash/redis) — JSON.stringify/parse ทำที่ชั้น store/session เอง
//
// ⚠️ ยังไม่เคยรันกับ Upstash จริง: ตัวเชื่อม UpstashRedis, สคริปต์ Lua (CAS_LUA/RATE_LUA) บน Redis จริง, read-only token
import { ConfigError } from './http.js';

export const AUDIT_MAX = 500;

/* ---------- สคริปต์ Lua */

// compare-and-set: ถ้า tt:v == baseVersion (ไม่มี key = '0') ทำรายการเขียนทั้งหมดในสคริปต์เดียว แล้ว INCR tt:v (bump=1) หรือไม่ขยับ (bump=0 = "เขียนแบบตรวจ version")
// ไม่ตรง → คืน [0, version ล่าสุด]; ข้อมูลทั้งหมดมาทาง KEYS/ARGV (ไม่ประกอบสคริปต์จากข้อมูล)
//   KEYS = [tt:v, ...key ปลายทาง n ตัว, ...key ชั่วคราวที่ใช้ (mode R)]
//   ARGV = [baseVersion, bump, n, (mode, value) × n]
//   mode: S = SET key value · D = DEL key · R = ย้ายค่าจาก key ชั่วคราวชื่อ value มาเป็น key (กันคำขอ EVAL ใหญ่เกิน 1 MB)
//         H = HDEL key value(=field) · F = HSET key field value โดย value ในสคริปต์ = "field\nvalue" · L = LPUSH key value + LTRIM 0 499 (audit log)
//         G = เงื่อนไขเสริม: GET key (ไม่มี = '0') ต้องเท่ากับ value ไม่งั้นคืน [2, ค่าปัจจุบัน] โดยยังไม่เขียนอะไร (ตรวจก่อนเขียนทั้งหมด) · B = INCR key
//         ใช้ G/B กับตัวนับ tt:sv ("ดัชนีลิงก์เปลี่ยน") ให้ op ที่เพิกถอนลิงก์กับการสร้างลิงก์ไม่แทรกกัน (WB-01)
export const CAS_LUA = `
local v = redis.call('GET', KEYS[1])
if not v then v = '0' end
if v ~= ARGV[1] then return {0, v} end
local n = tonumber(ARGV[3])
for i = 1, n do
  if ARGV[2 * i + 2] == 'G' then
    local g = redis.call('GET', KEYS[i + 1])
    if not g then g = '0' end
    if g ~= ARGV[2 * i + 3] then return {2, g} end
  end
end
for i = 1, n do
  local key = KEYS[i + 1]
  local mode = ARGV[2 * i + 2]
  local val = ARGV[2 * i + 3]
  if mode == 'G' then
    -- ตรวจไปแล้วในรอบแรก (ก่อนเขียนอะไรเลย)
  elseif mode == 'B' then
    redis.call('INCR', key)
  elseif mode == 'S' then
    redis.call('SET', key, val)
  elseif mode == 'R' then
    if redis.call('EXISTS', val) == 1 then
      redis.call('RENAME', val, key)
      redis.call('PERSIST', key)
    else
      redis.call('DEL', key)
    end
  elseif mode == 'H' then
    redis.call('HDEL', key, val)
  elseif mode == 'F' then
    local sep = string.find(val, '\\n', 1, true)
    redis.call('HSET', key, string.sub(val, 1, sep - 1), string.sub(val, sep + 1))
  elseif mode == 'L' then
    redis.call('LPUSH', key, val)
    redis.call('LTRIM', key, 0, ${AUDIT_MAX - 1})
  else
    redis.call('DEL', key)
  end
end
if ARGV[2] == '1' then
  return {1, redis.call('INCR', KEYS[1])}
end
return {1, tonumber(v)}
`;

// นับครั้งแบบ atomic (INCR + ตั้ง EXPIRE ครั้งแรก) คืน [จำนวนครั้ง, TTL วินาทีที่เหลือ] — กัน key ค้างไม่มีวันหมดอายุเมื่อ INCR/EXPIRE ขาดกลางทาง
export const RATE_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
local t = redis.call('TTL', KEYS[1])
if t < 0 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])); t = tonumber(ARGV[1]) end
return {n, t}
`;

/* ---------- Upstash adapter (ยังไม่ได้ทดสอบกับ Upstash จริง) */
class UpstashRedis {
  constructor(client) {
    this.c = client;
  }

  get(key) { return this.c.get(key); }
  set(key, value, { ex } = {}) { return ex ? this.c.set(key, value, { ex }) : this.c.set(key, value); }
  del(...keys) { return this.c.del(...keys); }
  incr(key) { return this.c.incr(key); }
  expire(key, seconds) { return this.c.expire(key, seconds); }
  ttl(key) { return this.c.ttl(key); }
  mget(...keys) { return keys.length ? this.c.mget(...keys) : Promise.resolve([]); }
  hset(key, fields) { return this.c.hset(key, fields); }
  hget(key, field) { return this.c.hget(key, field); }
  hdel(key, ...fields) { return this.c.hdel(key, ...fields); }
  hgetall(key) { return this.c.hgetall(key); }
  hlen(key) { return this.c.hlen(key); }
  lrange(key, start, stop) { return this.c.lrange(key, start, stop); }
  eval(script, keys, args) { return this.c.eval(script, keys, args); }
}

/* ---------- เลือก adapter */
const upstash = { main: null, readOnly: null };

/**
 * คืน Redis adapter (สร้างครั้งเดียวต่ออินสแตนซ์) จาก UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (ขาด → ConfigError)
 *  - readOnly:true (เส้นทางผู้ดู, W-16) ใช้ UPSTASH_REDIS_REST_READONLY_TOKEN ถ้ามี (ไม่มี = ใช้ token หลัก) — ใช้อ่านอย่างเดียวเท่านั้น
 */
export async function getRedis({ readOnly = false } = {}) {
  const slot = readOnly && process.env.UPSTASH_REDIS_REST_READONLY_TOKEN ? 'readOnly' : 'main';
  if (upstash[slot]) return upstash[slot];
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = slot === 'readOnly' ? process.env.UPSTASH_REDIS_REST_READONLY_TOKEN : process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new ConfigError('ต้องตั้ง UPSTASH_REDIS_REST_URL และ UPSTASH_REDIS_REST_TOKEN');
  const { Redis } = await import('@upstash/redis'); // โหลดเฉพาะตอนใช้จริง (cold start ของ endpoint ที่ไม่แตะ Redis เร็วขึ้น)
  upstash[slot] = new UpstashRedis(new Redis({ url, token, automaticDeserialization: false }));
  return upstash[slot];
}