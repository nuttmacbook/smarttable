# สัญญา API (`api/**`)

เอกสารฉบับทางการของ request/response ทุก endpoint ใช้โดย `js/api-client.js` · วิธี deploy ดู [`DEPLOY.md`](DEPLOY.md)
ถ้าโค้ดขัดกับเอกสารนี้ ให้แจ้งผู้ดูแลโค้ด — ห้ามเดา · โค้ดร่วมอยู่ที่ `server/` (ไม่ใช่ `api/_lib` — กันถูกนับเป็น endpoint, W-15)

## หลักการทั่วไป
- **Handler:** ทุกไฟล์ `export default async function handler(req, res)` แบบ Vercel Node Function (ESM) สร้างด้วย `route()` ใน `server/http.js`
- **เรียกได้เฉพาะ same-origin** (ไม่ตอบ CORS header ใด ๆ) · ทุก response: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, JSON
- **คำขอที่ไม่ใช่ GET (รวม login/logout) ต้องมีครบ ไม่งั้นถูกปฏิเสธก่อนถึง logic:**
  1. `Content-Type: application/json` (ไม่ใช่ → **415**)
  2. `X-Requested-With: tt` (ไม่มี → **403**)
  3. `Origin` **หรือ** `Sec-Fetch-Site` อย่างน้อยหนึ่ง (ไม่มีทั้งคู่ → **403**) · `Sec-Fetch-Site` ที่มาต้องเป็น `same-origin` · `Origin` ที่มาต้องอยู่ใน allowlist **`ALLOWED_ORIGINS`** (คั่น `,` เทียบ origin เต็ม scheme+host+port — ไม่ใช้ Host/x-forwarded-host) · ไม่ตั้ง `ALLOWED_ORIGINS` (หรือไม่มี origin ที่ถูกต้องสักตัว) → **500** ตั้งค่าไม่ครบ เสมอ ทุก environment ไม่มีค่า dev/localhost อัตโนมัติ
- **ลำดับตรวจ:** method (405 + `Allow`) → CSRF (403) → Content-Type (415) → สิทธิ์ (401) → อ่าน body (413/400) → logic (404/409/422/200)
- **รูป error ทุกแบบ:** `{ "error": "<รหัสอังกฤษคงที่>", "message": "<ข้อความไทย>", ...ฟิลด์เสริม }` · 5xx ไม่มี stack/รายละเอียดภายใน
- **ขนาด body:** `/api/op` ≤ 1 MB · `/api/import`, `/api/migrate` ≤ 4 MB · login/shares ≤ 16 KB → เกิน **413**; JSON เสีย/ไม่ใช่ object **400**
- **สถานะ:** 200 ทุกกรณีสำเร็จ · 400 · 401 ไม่ได้ล็อกอิน · 403 CSRF · 404 ไม่พบ/ลิงก์ใช้ไม่ได้ · 405 · 409 ชน (version/ฐานไม่ว่าง) · 413 · 415 · 422 ข้อมูลไม่ผ่านการตรวจ · 429 · 500/503
- **ผู้ดู (โทเค็นแชร์) ไม่มีทางเขียนได้ทุก endpoint** — โทเค็นใช้ได้กับ `GET /api/state` อย่างเดียว

## เซสชัน / คุกกี้
- `Set-Cookie: __Host-tt_session=<43 ตัวอักษร base64url>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200` (ไม่มี Domain)
- Redis: `sess:<HMAC-SHA256(SESSION_SECRET, token)>` = `{u: username, p: pwdVersion, c: createdAt, l: lastSeen}`
  - **`SESSION_SECRET`** (≥ 32 ไบต์ สุ่ม) = กุญแจ HMAC ของ key เซสชัน: คนที่อ่าน Redis ได้อย่างเดียวสร้างคุกกี้ใช้เองไม่ได้ · เปลี่ยนค่า = ทุกเซสชันใช้ไม่ได้ทันที (ขาด/สั้นกว่า 32 ไบต์ → 500)
  - **`pwdVersion`** = sha256(hash ของบัญชีใน `ADMIN_ACCOUNTS`) ย่อ 16 ตัว · ทุกคำขอตรวจกับ env ปัจจุบัน: บัญชีถูกลบ/เปลี่ยนรหัสผ่าน → เซสชันใช้ไม่ได้และถูกลบ (WA-01)
  - **idle 2 ชม.** (ต่ออายุเมื่อใช้ ≥ 1 นาทีนับจากครั้งก่อน) · **absolute 12 ชม.** นับจาก `createdAt` · login ใหม่ = token ใหม่ + ลบเซสชันเดิมของคุกกี้ที่มากับคำขอ
- คุกกี้ `__Host-` ต้องใช้บน https เท่านั้น (Safari ไม่รับบน `http://localhost`) — ใช้งานจริงผ่านโดเมน https ของ Vercel

## Endpoints

### `POST /api/auth/login`  `{ "username", "password" }`
- **200** `{ "admin": true, "username": "admin" }` + `Set-Cookie`
- **401** `{error:'invalid_credentials', message:'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'}` — ข้อความเดียวกันทุกกรณี (รหัสผิด/ไม่มี username) · ไม่ตั้งคุกกี้
- **429** `{error:'rate_limited', message}` + header **`Retry-After`** (body คงที่ ไม่มีตัวเลข) — ตรวจ **ก่อนเรียก scrypt** ด้วย Lua อะตอมมิก (INCR+EXPIRE) นับทุกความพยายาม เกินข้อใดข้อหนึ่งในหน้าต่าง 15 นาที:
  | ตัวนับ | เกณฑ์ |
  |---|---|
  | IP + username (ตัวพิมพ์เล็ก) | 5 |
  | username รวมทุก IP | 20 |
  | IP | 30 |
  | ทั้งระบบ | 300 |
  login สำเร็จล้างตัวนับ IP+username นั้น · key เก็บเป็น SHA-256 (ไม่มี IP/ชื่อดิบ) · ⚠️ ตัวนับ "username รวมทุก IP" ทำให้ผู้โจมตีกระจาย IP ล็อกแอดมินชั่วคราวได้ (15 นาที) — แลกกับการกัน brute force กระจาย IP
- **IP ผู้เรียก:** `x-vercel-forwarded-for` → `x-real-ip` → `x-forwarded-for` (ค่าแรก) → socket · ตามเอกสาร Vercel header เหล่านี้ถูกตั้งโดย Vercel (ไม่เชื่อค่าที่ไคลเอนต์ส่ง) **ยังไม่ได้ยืนยันบนแพลตฟอร์มจริง** — ต้องตรวจตอน deploy
- **400** body ไม่ครบ/ไม่ใช่ JSON · **500** ถ้า `ADMIN_ACCOUNTS`/`SESSION_SECRET`/`ALLOWED_ORIGINS` ตั้งผิด

### `POST /api/auth/logout`  `{}`
**200** `{ "ok": true }` + คุกกี้ `Max-Age=0` · ลบเซสชันฝั่งเซิร์ฟเวอร์ทันที · ไม่มีเซสชันก็ 200

### `GET /api/auth/me`
**200** `{ "admin": true, "username": "admin", "settings": {…รูปเดียวกับ GET /api/settings รวม revision…} }` (ให้หน้าแอดมินแสดงแบนเนอร์ "ยังไม่ได้ตัดสินใจเรื่องชื่อครู" โดยไม่ต้องยิงซ้ำ) · **401** `{error:'unauthorized'}`

### `GET /api/public` — โหมดสาธารณะ (ไม่ต้องล็อกอิน · SPEC v5 ข้อ 16.1 + ข้อ 22 V5-01..04)
| กรณี | ผล |
|---|---|
| เปิดโหมดสาธารณะ (ค่าเริ่มต้น) | **200** `{ "version":12, "settings":{ "publicMode":{ "enabled":true, "hideTeacherNames": null\|true\|false } }, "state":{ version, subjects, groups, rooms, entries [, teachers] } }` |
| ฐานว่าง | **200** `{ "version":0, "settings":{…}, "state":null }` |
| แอดมินปิดโหมดสาธารณะ | **403** `{ "error":"public-disabled", "message":"ผู้ดูแลปิดการเข้าชมสาธารณะ" }` ไม่มี state (ตรวจ settings ทุกคำขอก่อนใช้ ETag จึงไม่มี 304 ข้ามการปิด) |
| ส่ง `If-None-Match` ตรงกับ ETag ปัจจุบัน | **304** ไม่มี body |
| เกินเกณฑ์ | **429** + `Retry-After` — **300 ครั้ง/นาที/IP** ตัวนับ `rl:pub:ip:*` แยกจากผู้ดูลิงก์ (โรงเรียนอยู่หลัง NAT เดียว) ปรับได้ด้วย env `PUBLIC_RATE_LIMIT` (10–100000) |
| อ่าน settings หรือ state จาก Redis ไม่ได้ | **503** `{ error:'unavailable' }` + `Retry-After` — fail-closed: ไม่คืนข้อมูลบางส่วน ไม่ตกไปเป็น "แสดงชื่อครู" |
- **ซ่อนชื่อครู:** `effectiveHide = (hideTeacherNames !== false)` — ค่าเริ่มต้น `null` ("ยังไม่ยืนยัน") **ถือเป็นซ่อน**; ผู้ชมเห็นชื่อครูได้ก็ต่อเมื่อแอดมินตั้ง `false` เอง · `settings.publicMode.hideTeacherNames` ใน response เป็นค่าดิบ (`null`/`true`/`false`) — ไคลเอนต์ใช้ `!== false` เหมือนกันเพื่อตัดสินว่าซ่อนอยู่
  - **ซ่อนอยู่ (`effectiveHide = true`):** state **ไม่มีคีย์ `teachers`**, subject **ไม่มี `teacherIds`**, entry **ไม่มี `teacherId`**, ตัดช่อง **`note`** ของ subjects/rooms/groups ทิ้ง (ชื่อครูอาจอยู่ในข้อความอิสระ) → ไม่มีชื่อ/แผนก/id ครูเหลือใน response · ไคลเอนต์ต้องรับ state ที่ไม่มีคีย์เหล่านี้ได้ (ใส่ค่าเริ่มต้นเอง `teachers=[]`, `teacherIds=[]`, `teacherId=null`, `note=''` ก่อนส่งเข้า validator/ตัววาด)
  - **ไม่ซ่อน (`false`):** ส่ง `teachers`, `teacherIds`, `teacherId`, `note` ตามเดิม
  - ทุกกรณี **ไม่มีคีย์ `plans`** (`group.planId = null`) · ไม่ส่งบัญชีแอดมิน ลิงก์แชร์ audit snapshot `confirmedAt/updatedAt/updatedBy/revision`
- **แคช:** `Cache-Control: no-cache` + `ETag: W/"…"` เฉพาะ endpoint นี้ (ไม่มี `public`/`s-maxage`) · ETag ขึ้นกับ `tt:v` + ค่า `hideTeacherNames` ดิบ → แก้ตารางหรือสลับซ่อนชื่อครูแล้วเปลี่ยนทันที · ⚠️ `vercel.json` ตั้ง `Cache-Control: no-store` ให้ `/api/(.*)` ทั้งหมด — **ยังไม่ได้ตรวจบน Vercel ว่าค่าไหนชนะ** (ถ้า `no-store` ชนะ เบราว์เซอร์จะไม่ส่ง `If-None-Match` ก็แค่ไม่ได้ 304 — ข้อมูลยังถูกต้อง)
- ไม่รับ/ไม่สนใจ cookie, header โทเค็น และ query · **cookie แอดมินไม่ทำให้ได้ข้อมูลเพิ่ม** · ไม่มี method เขียน (POST/PUT/DELETE → **405**) · โหมดสาธารณะ **ไม่ให้สิทธิ์เขียนใด ๆ**
- ตารางทั้งสถานศึกษา (ไม่จำกัด scope) กรองที่เซิร์ฟเวอร์ ไม่ใช่แค่ UI · ถ้า `tt:settings` เสีย/ชนิดผิด/ขาดบางส่วน → ทั้งก้อนถือเป็น "ซ่อน" (ไม่เชื่อ `false` ที่อยู่ในก้อนที่เสีย) และใช้ `enabled` ถ้าอ่านได้ ไม่งั้นเปิด

### `GET /api/settings` · `PUT /api/settings` (แอดมินเท่านั้น · V5-01, V5-06)
- `GET` → **200** `{ "settings": { "publicMode":{ "enabled":true, "hideTeacherNames":null }, "confirmedAt":null, "updatedAt":null, "updatedBy":null, "revision":0 } }` — ค่าที่แสดงคือค่าเริ่มต้นเมื่อยังไม่เคยบันทึก · `hideTeacherNames:null` + `confirmedAt:null` = แอดมินยังไม่ตัดสินใจ → UI แสดงแบนเนอร์ "ยังไม่ได้ตัดสินใจเรื่องแสดงชื่อครูต่อสาธารณะ — ตอนนี้ซ่อนอยู่"
- `PUT` body `{ "revision": 0, "publicMode": { "enabled"?: boolean, "hideTeacherNames"?: boolean } }`
  - **`revision` บังคับ** = ค่าจาก `GET` ล่าสุด · ส่ง `publicMode` เฉพาะช่องที่จะเปลี่ยน (อย่างน้อย 1; ช่องที่ไม่ส่งคงค่าเดิม) · `hideTeacherNames` ส่งได้เฉพาะ `true`/`false` (**ห้ามส่ง `null` กลับ**) · ช่องอื่น/ชนิดอื่น/ไม่มี revision → **422** `{ error:'invalid', errors:[{type,message,field}] }`
  - ส่ง `hideTeacherNames` (true/false) = แอดมินยืนยันแล้ว → ตั้ง `confirmedAt` (ส่งแค่ `enabled` ไม่ตั้ง/ไม่เปลี่ยน `confirmedAt`)
  - สำเร็จ **200** `{ "settings": {…ค่าใหม่ทั้งก้อน revision+1…} }`
  - `revision` ไม่ตรงกับปัจจุบัน (มีแอดมินอีกคนบันทึกไปก่อน) → **409** `{ error:'conflict', message, latestRevision }` ไม่เขียนอะไร — UI โหลดค่าใหม่แล้วให้ผู้ใช้ตัดสินใจอีกครั้ง · ตรวจในสคริปต์ CAS เดียวกับการเขียน (เงื่อนไข `G` บน `tt:srev`) สองคำขอ revision เดียวกันพร้อมกันสำเร็จหนึ่งเดียว
  - **401** ไม่ได้ล็อกอิน · **403** CSRF ไม่ครบ · **400** body ไม่ใช่ JSON object
- เก็บที่ Redis `tt:settings` + ตัวนับ `tt:srev` (นอก state ตาราง **ไม่ขยับ `tt:v`** จึงไม่ทำให้ไคลเอนต์ติด 409) · audit `settings.update` (บันทึกเฉพาะสถานะ on/off/unset ไม่มีข้อมูลอื่น) ใน EVAL เดียวกับการเขียน · มีผลทันทีกับ `GET /api/public`

### `GET /api/state`
| ผู้เรียก | ส่งอะไร | ผล |
|---|---|---|
| แอดมิน | คุกกี้ | **200** `{ "role":"admin", "version":12, "state":{ version:4, subjects, teachers, groups, rooms, plans, entries }, "empty":false }` |
| แอดมิน, ฐานว่าง | คุกกี้ | **200** `{ "role":"admin", "version":0, "state":null, "empty":true }` |
| ผู้ดู | header **`X-Share-Token: <token>` เท่านั้น** | **200** `{ "role":"viewer", "version":12, "scope":"group:g1", "label":"ปวช.1/1", "state":{…เฉพาะ scope…} }` |
| ไม่มีทั้งคู่ | — | **401** |
- **`?share=` ถูกยกเลิก (W-04)** — ถูกมองเป็นคำขอแอดมินที่ไม่ได้ล็อกอิน (401) · ห้าม log header นี้ (โค้ดไม่ log)
- ลำดับฝั่งผู้ดู: ตรวจรูปแบบ token (`[A-Za-z0-9_-]{16,256}` — ผิด → 404 โดยไม่แตะ Redis) → **rate limit ต่อ IP 120 ครั้ง/นาที** (เกิน → **429** + `Retry-After`) → ค้นลิงก์ → อ่านข้อมูล (ใช้ `UPSTASH_REDIS_REST_READONLY_TOKEN` ถ้าตั้งไว้)
- token ผิดรูปแบบ/ไม่พบ/เพิกถอน/หมดอายุ/ฐานว่าง → **404** `{error:'not_found', message:'ลิงก์นี้ใช้ไม่ได้'}` ข้อความเดียวกันทุกกรณี
- `state` ผู้ดู: ครบ 6 คอลเลกชัน (ผ่าน `parseState`) · `entries` เฉพาะใน scope · `groups/subjects/teachers/rooms` เฉพาะที่อ้างถึง · `plans: []` · `group.planId = null` · `subjectIds`/`teacherIds` กรองให้เหลือที่ส่งไป · scope `all` ส่งทั้งหมด (รวม plans) · ไม่ส่งข้อมูลบัญชี/ลิงก์อื่นเด็ดขาด

### `POST /api/op`  `{ "op": {…}, "baseVersion": 12, "returnState"?: true, "dryRun"?: true }`
- **200** `{ version, noop, summary, destructive, revokedShares, changes, affected, warnings, remaining, …ผลเสริม (plan/trimmed/report), snapshotVersion? [, state] }` — `affected` = `{ subjects|teachers|groups|rooms|plans|entries:{added,updated,removed}, total:{added,updated,removed} }` จาก `applyOp` (โดม) ส่งต่อตรง ๆ ไว้ทำข้อความยืนยัน; `trimmed` ส่งเมื่อ `trimOverHours` ตัดคาบ (ทั้ง `/api/op` และ `/api/import`)
  - เป็น **delta (`changes` = `diffState` เดียวกับ `applyOp`) ไม่ส่ง state เต็ม** (ขอ state เต็มด้วย `returnState:true`) · `noop:true` = ไม่เปลี่ยนอะไร ไม่เขียน version ไม่ขยับ
  - `summary` = `{ subjects:{upsert,remove}, … }` จำนวนที่เปลี่ยน · `destructive` = เป็น op ทำลายล้าง (`state.import` แบบ replace หรือ `trimOverHours`) ที่ถ่าย snapshot แล้ว (`snapshotVersion` = version ที่สำรอง) · `revokedShares` = จำนวนลิงก์แชร์ที่ถูกเพิกถอนเพราะเอนทิตีหาย
  - **`dryRun:true`** → ตรวจ + ตอบ `{dryRun:true, version, noop, summary, destructive, revokedShares}` โดยไม่เขียนอะไร (UI ใช้ระบุ "จะลบ N รายการ" ก่อนยืนยัน — W-12)
- **op หลายช่อง (SPEC v5 ข้อ 15.2)** `entry.placeMany { items:[{groupId,day,period,subjectId,roomId?,teacherId?,id?}…≤200], policy:'all'|'valid', dryRun? }` · `entry.removeMany { entryIds:[…≤200], dryRun? }`
  - op เดียว = **CAS เดียว = version +1** · audit **1 รายการ** (`type`, `v`, ตัวเลข `placed`/`rejected`/`removed`) · เกิน 200 หรือโครงผิด = **422**
  - **สำเร็จ 200** `{ version, changes, affected, warnings, placed:[{index,day,period,id}], rejected:[{index,day,period,errors}], items:[{index,day,period,ok,id?,errors?}], … }` (removeMany มี `removed` = จำนวนที่ลบ)
  - **`policy:'all'` มีช่องไม่ผ่าน → 422** `{ error:'invalid', errors:[{type,message,index,day,period}], items:[…รายช่องครบทุกช่อง…], rejected:[…] }` — ไม่เขียนอะไร · `policy:'valid'` ลงเฉพาะที่ผ่าน (ไม่มีช่องผ่านเลย = 422)
  - **dry run — ทางหลักคือ `op.dryRun:true` (ใน op)**; `dryRun:true` ระดับคำขอ (นอก op) ถูกแปลงเป็น `op.dryRun` ให้สำหรับ op สองตัวนี้ → **สองทางได้ผลเหมือนกัน**: **200** `{ dryRun:true, version(ปัจจุบัน), wouldSucceed:boolean, items, placed, rejected, affected, warnings, errors? }` (ไม่มี `state`) — `wouldSucceed:false` ก็ยังเป็น 200 พร้อมรายงานรายช่อง · **ไม่เขียน Redis / ไม่เพิ่ม version / ไม่เขียน audit**
  - `dryRun` ที่ไม่ใช่ boolean → 400
- **409** `{ error:'conflict', latestVersion }` — `baseVersion` ไม่เท่า version ปัจจุบัน (ไม่รัน op) หรือแพ้ CAS
- **422** `{ error:'invalid', errors:[{ type, message, … }] }` — state/version ไม่เปลี่ยน · **400** `baseVersion`/`op` ผิดโครง หรือ type ไม่รู้จัก (`error:'unknown_op'`)
- ทุกการเขียนที่สำเร็จมี audit ใน CAS เดียวกัน
- ⚠️ `entry.place` ต้องส่ง `id` (จาก `uid()`) เสมอ — id ที่เซิร์ฟเวอร์สุ่มเองจะไม่ตรงกับที่ไคลเอนต์ทำนาย (adapter ของโดมใช้ `changes` ที่ตอบกลับอยู่แล้ว)

### `POST /api/import`  `{ "baseVersion", "state" | "patch" | "rows", "mode"?, "trimOverHours"?, "dryRun"? }` (≤ 4 MB)
= op `state.import` เต็มรูป · **เซิร์ฟเวอร์ไม่ parse .xlsx** (ไคลเอนต์ส่ง rows/ผล importer) ตรวจซ้ำทั้งหมด · response/สถานะเหมือน `/api/op` (+ `report` เมื่อส่ง `rows`) · แบบ replace (`state`) หรือ `trimOverHours` ถ่าย snapshot ก่อนเขียน

### `POST /api/migrate`  `{ "state": {…v1–v4 หรือข้อความ JSON…}, "force"?: true, "dryRun"?: true }` (≤ 4 MB)
- ฐานว่าง → migrate (v1→v2→v3→v4) + ตรวจ + เขียน · **200** `{ version, noop, summary, destructive, revokedShares, migrated, counts, remaining:[{type,message}], remainingCount, snapshotVersion? }`
- ฐานไม่ว่างและไม่ `force` → **409** `{error:'not_empty', latestVersion}` · `force:true` เขียนทับ **หลังถ่าย snapshot เสมอ** · ลิงก์ของเอนทิตีที่หายถูกเพิกถอนใน CAS เดียวกัน
- **422** state ผิดโครง/เวอร์ชันไม่รู้จัก **หรือมีข้อมูลผิดกฎนอกจาก hours เกิน** (ชนครู/ห้อง/กลุ่ม, อ้างอิงขาด) — `force` ข้ามไม่ได้ · hours เกินที่เป็นข้อมูลเดิมรับได้ แสดงใน `remaining`

### `GET /api/snapshots` (แอดมิน) — สำรอง + audit
- `GET /api/snapshots` → **200** `{ snapshots:[{version, createdAt, reason, bytes}], audit:[{t, u, type, v, ip}] }` — snapshot ล่าสุด **5 ชุด** หมดอายุ **30 วัน** (ถ่ายใน CAS เดียวกับ migrate force / import replace / trim) · audit ล่าสุด 50 รายการ (เก็บ ≤ 500: เวลา, username, ชนิด op, version, hash ย่อของ IP — ไม่มี secret/IP ดิบ)
- `GET /api/snapshots?version=<n>` → **200** `{ version, createdAt, reason, state }` ดาวน์โหลด (ย้อนกลับด้วย `POST /api/migrate {state, force:true}`) · ไม่มี/หมดอายุ → **404**
- ⚠️ การตั้งหมดอายุ 30 วันทำ best-effort หลังเขียนสำเร็จ (EXPIRE แยกคำสั่ง) ถ้าพลาด snapshot ค้างจนถูกชุดใหม่ดันออก (เก็บ 5 ชุด)

### `/api/shares` (แอดมินเท่านั้น ทุก method)
| Method | คำขอ | ผล |
|---|---|---|
| `GET` | — | **200** `{ shares:[{ id, label, scope, createdAt, expiresAt\|null, expired }] }` ใหม่→เก่า · ไม่มี token/hash |
| `POST` | `{ scope, label?≤80, expiresAt? }` | **200** `{ id, token, share }` — **token เต็มได้ครั้งเดียว** (43 ตัว = 256 บิต; เก็บเป็น SHA-256 เท่านั้น) |
| `DELETE` | `{ id }` (หรือ `?id=`) | **200** `{ ok:true, id }` ใช้ไม่ได้ทันที · ไม่พบ **404** |
| `PUT` | `{ id, expiresAt?}` | **200** `{ id, token, share }` สร้างใหม่ (ต่ออายุ): token เก่าใช้ไม่ได้ + ใหม่ id/scope/label เดิม |
- **`id` (shareId)** = ตัวสุ่ม 12 ตัวอักษร ไม่เกี่ยวกับ token (ไม่ลับ) ใช้ list/revoke/regenerate · ดัชนี `tt:shares` · URL ที่ UI สร้าง = `/#/view/<token>` (UI เก็บ token ในหน่วยความจำ ไม่เขียน localStorage)
- **หมดอายุ (W-18/19):** scope `all` ไม่ส่ง `expiresAt` = **+90 วัน** · `null`, อดีต, เกิน 365 วัน → **422** · `PUT` ลิงก์ `all` ไม่ส่ง `expiresAt` = ต่ออายุ +90 วัน · scope อื่นไม่ส่ง = ไม่หมดอายุ (ตั้งได้ ≤ 10 ปี) · `expiresAt` ผิดรูปแบบ/นอกช่วงวันที่ (เช่น `1e20`) → 422 (ไม่ใช่ 500)
- scope ผิดรูปแบบหรือ id เป็นชื่อสงวน (`__proto__`, `constructor` …) → **422** · เป้าหมายไม่มีอยู่จริง → **404** · `label` มีอักขระควบคุม/กำกับทิศทางหรือยาวเกิน → **422** · ครบ 100 ลิงก์ → **422**
- **สร้าง/เพิกถอน/สร้างใหม่ เป็นคำสั่ง EVAL เดียว (อะตอมมิก)** พร้อม audit และ "ตรวจ version" (ไม่ขยับ `tt:v` → client แอดมินไม่ติด 409) — ถ้ามี op ลบเอนทิตีแทรกกลางจะวนตรวจใหม่ (สูงสุด 4 ครั้ง แล้ว 503)
- **ลบกลุ่ม/ครู/ห้อง หรือ import/migrate ที่ทำให้เอนทิตีหาย = เพิกถอนลิงก์ที่ scope ชี้ id นั้นอัตโนมัติ ใน CAS เดียวกับ op นั้น (W-05)** — สร้าง id เดิมใหม่ภายหลัง ลิงก์เก่าก็ไม่กลับมาใช้ได้
  - **กัน race (WB-01):** การสร้าง/เพิกถอน/สร้างใหม่ลิงก์ไม่ขยับ `tt:v` จึงเพิ่มตัวนับ `tt:sv` ("ดัชนีลิงก์เปลี่ยน") — ทุกการเปลี่ยนดัชนีลิงก์ `INCR tt:sv`, ส่วน op/import/migrate ที่เขียนข้อมูลจะอ่าน `tt:sv` ก่อนอ่านดัชนีลิงก์ แล้วใส่เงื่อนไข `G` ในสคริปต์ CAS (ตรวจก่อนเขียนอะไรเลย) — ถ้ามีลิงก์แทรกระหว่างอ่านกับเขียน สคริปต์คืน `[2, …]` โดยไม่เขียน และ op อ่านใหม่/คำนวณรอบเพิกถอนซ้ำ (สูงสุด 4 รอบ แล้ว 503) · ชั้นกันซ้ำ: ฝั่งผู้ดู `GET /api/state` ตอบ 404 ถ้าเป้าหมายของลิงก์ไม่มีอยู่ใน state ที่โหลดมา
  - ข้อจำกัดที่รู้: เงื่อนไข `G`/`B` ของ Lua ยังไม่ได้ยืนยันบน Redis (Upstash) จริง

## รหัสผ่านและบัญชี
- `ADMIN_ACCOUNTS="user1:scrypt$32768$8$1$<saltB64>$<hashB64>;user2:…"` — **base64 มาตรฐาน** · สร้างด้วย `npm run hash-password -- <username>` (ใช้ `hashPassword` ตัวเดียวกับเซิร์ฟเวอร์) · รหัสผ่านขั้นต่ำ 10 ตัว
- scrypt ตั้ง `maxmem = 128·N·r·2·p` ทั้ง hash และ verify (ไม่งั้น Node ปฏิเสธ N=2^15 ด้วย `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`) · อ่าน N/r/p จากสตริง แต่ยอมรับเฉพาะ N = 2^12…2^17 (กำลังสอง), r ≤ 16, p ≤ 4 · `timingSafeEqual` หลังตรวจความยาว · username ไม่มี → เทียบ hash หลอกต้นทุนเท่ากัน (คำนวณล่วงหน้าตอน cold start ของ login) · รูปแบบ hash ผิด = ข้ามบัญชีนั้น

## ข้อมูลใน Redis
| key | ค่า |
|---|---|
| `tt:v` | version (INCR ในสคริปต์ CAS เท่านั้น; ไม่มี = 0 = ฐานว่าง) |
| `tt:meta` | `{stateVersion:4, updatedAt}` |
| `tt:subjects` `tt:teachers` `tt:groups` `tt:rooms` `tt:plans` | JSON array |
| `tt:entries:<groupId>` | JSON array คาบของกลุ่ม (**shard ต่อกลุ่มตั้งแต่แรก**) — id ผ่าน `isValidId` เท่านั้น (ชื่อสงวนถูกปฏิเสธโดย `parseState`/`applyOp`) |
| `sess:<hmac>` | เซสชัน (มี `EX`) |
| `tt:shares` (HASH) · `share:<sha256(token)>` | ดัชนีลิงก์ (shareId→บันทึก) · ทางเข้าของผู้ดู — ไม่มี plaintext token |
| `tt:snaps` · `tt:snap:<version>:<i>` | ดัชนี + ข้อมูล snapshot (gzip+base64 แบ่ง chunk ≤ 700 KB) |
| `tt:audit` (LIST) | audit ล่าสุด ≤ 500 (LPUSH+LTRIM ใน Lua เดียวกับการเขียน) · op หลายช่องมี `placed`/`rejected`/`removed` เป็นตัวเลข · การตั้งค่า = `settings.update` |
| `tt:settings` · `tt:srev` | `{ publicMode:{enabled, hideTeacherNames:null\|bool}, confirmedAt, updatedAt, updatedBy }` + ตัวนับ revision (นอก state ตาราง ไม่นับ `tt:v`) · ไม่มี key = เปิดสาธารณะ + `hideTeacherNames:null` (ซ่อนชื่อครู) |
| `rl:pub:ip:*` | ตัวนับ `/api/public` ต่อ IP (hash) 300/นาที แยกจาก `rl:view:ip:*` |
| `rl:login:*` · `rl:view:ip:*` | ตัวนับ rate limit (มี `EX`) |
| `tt:stage:*` | key ชั่วคราว (`EX 600`) เฉพาะตอนเขียนก้อนใหญ่เกิน ~700 KB |
- **Lua CAS** (`server/redis.js` `CAS_LUA`): ข้อมูลทั้งหมดเข้าทาง `KEYS`/`ARGV` (ไม่ประกอบสคริปต์จากข้อมูล) · `tt:v == baseVersion` (ไม่มี key = `'0'`) → ทำรายการเขียนทั้งหมด (SET/DEL/ย้ายจาก key ชั่วคราว/HDEL/HSET/LPUSH+LTRIM) แล้ว `INCR tt:v` (หรือไม่ขยับสำหรับลิงก์แชร์) · ไม่ตรง → `[0, version ล่าสุด]` → 409 · ค่าเดียวต่อ key ≤ 900 KB (เกิน → 413)
- อ่าน state: อ่าน `tt:v` ก่อน/หลังชุด `MGET` ถ้าเปลี่ยนระหว่างอ่านให้ลองใหม่ (สูงสุด 4 ครั้ง แล้ว 503)
- **Upstash read-only token (W-16, optional):** ตั้ง `UPSTASH_REDIS_REST_READONLY_TOKEN` → เส้นทาง "ค้นลิงก์ + อ่านข้อมูล" ของผู้ดูใช้ token นี้ (เขียนไม่ได้แม้โค้ดผิดพลาด) · ตัวนับ rate limit ของผู้ดูยังใช้ token หลัก (ต้องเขียน) · ไม่ตั้ง = ใช้ token หลักทั้งหมด · **ยังไม่ได้ทดสอบกับ Upstash จริง**

## สิ่งที่ยังไม่ได้ยืนยันบนระบบจริง (รายงานตรง ๆ)
- **ยังไม่เคยรันกับ Upstash หรือ Vercel จริง** — adapter `UpstashRedis`, Lua `EVAL` จริง (ใช้ RENAME/PERSIST/HSET/LPUSH/LTRIM, เงื่อนไข `G`/`B` และชนิดค่าที่คืนเช่น `[0,"7"]` vs `[1,7]`), เพดานคำขอ 1 MB, `maxDuration`, การแข่งกันข้ามอินสแตนซ์, read-only token, คุกกี้ `Secure`/`__Host-` ในเบราว์เซอร์+https
- header IP ของ Vercel (`x-vercel-forwarded-for`/`x-real-ip`) ตามเอกสารเท่านั้น · body ของ DELETE/PUT บน Vercel (มี fallback อ่าน stream) · CSP ไม่เคยลองในเบราว์เซอร์จริง · หัว `Cache-Control` ของ `/api/public` (`no-cache`) ที่ตั้งใน `vercel.json` ยังไม่ได้ตรวจจริง (ดู [`DEPLOY.md`](DEPLOY.md))
- ยังไม่ได้ยืนยันบน Node 22 ที่ Vercel ใช้ (`engines: 22.x`)
