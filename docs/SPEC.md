# SPEC: ระบบจัดตารางเรียนตารางสอน (ฉบับรวม — สภาพ production)

สเปกฉบับรวมของระบบ ณ 13 ต.ค. 2569 (T56 / O20) · **รวมจากสเปกเดิมที่เคยซ้อนเป็นชั้น v1→v5 + ข้อตัดสินหลังรีวิวความปลอดภัย** ให้เหลือฉบับเดียวที่อ่านจากบนลงล่างได้ (ไม่ต้องอ่านย้อนจากท้ายไฟล์อีก)
เอกสารคู่กัน: `docs/HANDOFF.md` (ภาพรวม/สถานะ/ความเสี่ยง), `docs/API.md` (สัญญา endpoint), `docs/DEPLOY.md`, `docs/USER-GUIDE.md`, `docs/design.md` (UI)
ขอบเขต: โปรเจกต์ `company/project/timetable` เท่านั้น — **ห้ามแตะ `company/project/crypto-matrix/`** · ไม่มีความลับ/ค่า env จริงในไฟล์นี้

## 0. หลักการ
1. **Production อย่างเดียว:** ข้อมูลอยู่ที่เซิร์ฟเวอร์ (Vercel Functions + Upstash Redis) เท่านั้น ไม่มีที่เก็บข้อมูลในเบราว์เซอร์ ไม่มี API จำลอง ไม่มีข้อมูลตัวอย่างในตัวแอป · ย้ายข้อมูลเดิมด้วยนำเข้าไฟล์ JSON/Excel
2. **กฎธุรกิจอยู่ในโมดูล pure** (`scheduler/store/ops/importer/validate/list-model`) ที่ใช้ร่วมไคลเอนต์และเซิร์ฟเวอร์ — ไคลเอนต์ทำนายผล เซิร์ฟเวอร์ตรวจซ้ำและตัดสินจริงเสมอ
3. HTML/CSS/JS ธรรมดา (ES modules) + Vite · ไม่มี framework · ไม่เพิ่ม dependency โดยไม่จำเป็น (รายการที่อนุญาต ข้อ 12)
4. ภาษาไทยทั้ง UI ข้อความเหตุผล และเอกสาร · รองรับจอ ≥ 768px

## 1. ศัพท์ (ห้ามปนกัน)
- **กลุ่มเรียน** (`groups`) = กลุ่มนักเรียน เช่น ปวช.1/1 · **ห้องเรียน** (`rooms`) = สถานที่เรียน เช่น 411 · ในข้อมูล `entry.groupId` = กลุ่มเรียน, `entry.roomId` = ห้องเรียน (ไม่บังคับ)
- **ระดับ** (`state.levels`) = รายการที่แอดมินเพิ่ม/แก้ชื่อ/ลบ/เรียงลำดับได้ (หน้า "ระดับ") ค่าเริ่มต้น `DEFAULT_LEVELS` = `ปวช.1`–`ปวช.3`, `ปวส.1`–`ปวส.2` · ชื่อ trim แล้ว 1–20 ตัวอักษร ไม่ซ้ำ (ไม่สนตัวพิมพ์/ช่องว่างซ้ำ) ไม่มีอักขระควบคุมและไม่มี `,` `，` ได้ไม่เกิน 30 ระดับ · ลบระดับที่ยังมีวิชา/กลุ่ม/แผนใช้อยู่ไม่ได้ (op ตอบ `in_use` พร้อมจำนวน) · **แผนการเรียน** (`plans`) = ชุดวิชาของระดับหนึ่ง
- **ครูที่มีผล** ของคาบ = `entry.teacherId` ถ้ามี ไม่งั้นครูคนเดียวของวิชา ไม่งั้นไม่มี (`effectiveTeacherId`)
- **เรียนรวม** = วิชาสามัญ id เดียวกันหลายกลุ่มเรียนลงคาบเดียวกัน (`canMerge`) · วิชาชีพเฉพาะเรียนรวมไม่ได้

## 2. เวลาและผังตาราง
- จันทร์–ศุกร์ (`day` 1–5) · 11 คาบ/วัน คาบละ 1 ชม. 08:00–20:00 (`period` 1–11: 08–09, 09–10, 10–11, 11–12, 13–14, 14–15, 15–16, 16–17, 17–18, 18–19, 19–20)
- พักเที่ยง 12:00–13:00 ไม่ใช่คาบ (ค่าคงที่ `LUNCH`, รหัส `'lunch'`) แสดงเป็นคอลัมน์คั่นระหว่างคาบ 4 กับ 5 ลงวิชาไม่ได้
- ผังทุกมุมมองและทุกไฟล์พิมพ์/ส่งออก: **คอลัมน์ = คาบ (รวมคอลัมน์พักเที่ยง) แถว = วัน** หัวคอลัมน์มีเลขคาบ + เวลา

## 3. โมเดลข้อมูล (version 5)
```
state = { version: 5,
  levels:   [ชื่อระดับ, ...],                                       // เรียงลำดับ ไม่ซ้ำ
  subjects: [{ id, code, name, type:'general'|'vocational', credits, hours, theory?, practice?, teacherIds:[...0..n], levels:[...≥1], note }],
  teachers: [{ id, name, dept }],
  groups:   [{ id, name, level, major, subjectIds:[...], planId|null }],
  rooms:    [{ id, name, building?, capacity?, note }],              // name ไม่ซ้ำ
  plans:    [{ id, name, level, subjectIds:[...], note }],           // name ไม่ซ้ำ
  entries:  [{ id, groupId, day:1..5, period:1..11, subjectId, roomId|null, teacherId|null }] }
```
- `hours` = ท+ป (จำนวนเต็มบวก) = ชั่วโมงที่ต้องเรียนต่อสัปดาห์ต่อกลุ่มเรียน · `teacherIds` ไม่ซ้ำและต้องมีครูจริง · `entry.teacherId` (ถ้ามี) ต้องอยู่ใน `subject.teacherIds`
- id: `[A-Za-z0-9_-]{1,64}` และห้ามเป็นชื่อสงวนของ `Object.prototype` (`__proto__`, `constructor`, `prototype`, `toString`, `valueOf`, `hasOwnProperty` ฯลฯ — `validateId`) · ในโค้ดห้ามใช้ object ธรรมดาเป็นดัชนีด้วย id/ชื่อ (ใช้ `Map` / `Object.create(null)` + `Object.hasOwn`)
- ข้อความ (`sanitizeText`/`textIssues`): ไม่มีอักขระควบคุม/กำกับทิศทาง/zero-width, NFC; ชื่อ/รหัส ≤200 ตัวอักษร, `note`/`dept`/`major`/`building` ≤500
- `parseState` ตรวจโครงสร้างและอ้างอิง (id ซ้ำ, วิชา/กลุ่ม/แผนต้องอ้างระดับที่มีใน `state.levels` (วิชามี `levels` ≥1), รูปแบบชื่อระดับ, รหัสวิชาไม่ซ้ำ, ชื่อห้อง/แผนไม่ซ้ำ, `subjectIds`/`planId`/`roomId`/`teacherId` อ้างของที่มีจริง) · ไม่ตรวจชน/ชั่วโมง (ผู้เรียกใช้ `validateAll`) เพื่อให้ข้อมูลเดิมที่ผิดกฎโหลดได้

### 3.1 Migration (`migrateState` — idempotent ต่อโซ่ v1→v2→v3→v4→v5)
- ใช้กับการนำเข้าไฟล์ JSON (`importJSON`, op `state.import`) และ `/api/migrate` · ไฟล์ที่ไม่มี `version` = v1 · version อื่นนอก 1–5 ถูกปฏิเสธ
- **v1→v2:** `rooms`(เดิม)→`groups` (id เดิมคงไว้); `level` เดิม `'ปวช.'|'ปวส.'` + `year` → ระดับใหม่ เช่น `'ปวช.'+1` → `'ปวช.1'` (ปีไม่มี/นอกช่วง → 1; ปวส. สูงสุด 2, ปวช. สูงสุด 3); `entry.roomId`→`groupId` และเพิ่ม `roomId:null`; `rooms` ใหม่ = `[]`; `subject.levels` = ชุดระดับของกลุ่มที่เคยมีคาบของวิชานั้น (ไม่มี = ทุกระดับ เพื่อไม่ให้ข้อมูลเก่าชนโดยไม่ตั้งใจ)
- **v2→v3:** `subject.teacherId` → `teacherIds` (`teacherId ? [teacherId] : []`, ลบ field เดิม); `entry.teacherId` = ครูคนเดียวของวิชาเดิม | null
- **v3→v4:** `plans = []`; `group.subjectIds` = วิชาที่กลุ่มนั้นมีคาบอยู่ (เรียงตามรหัสวิชา); `group.planId = null`
- **v4→v5:** `levels` = `DEFAULT_LEVELS` + ระดับที่มีใช้อยู่นอกค่าเริ่มต้น (ตามลำดับที่พบ) · ชื่อระดับผิดรูปในข้อมูลเดิม (มี `,`, ยาวเกิน 20, อักขระควบคุม, ว่าง/ไม่ใช่ข้อความ) ถูกซ่อมเป็นชื่อที่ถูกต้องแล้วเขียนอ้างอิงใหม่ให้ตรงกันทั้งหมด (`canonicalizeLevels`; ชนชื่ออื่น → ต่อท้าย " 2", " 3") · เซิร์ฟเวอร์เก็บใน key `tt:levels`
- ผลลัพธ์ต้องผ่าน `validateAll` ถ้าข้อมูลเดิมไม่ชน

### 3.2 ค่าตั้งนอก state
`settings = { publicMode:{ enabled:true, hideTeacherNames:null|true|false }, confirmedAt, updatedAt, updatedBy }` เก็บใน Redis `tt:settings` พร้อมตัวนับ `revision` — ไม่อยู่ใน state ตาราง ไม่นับ version ตาราง

## 4. กฎกันชน (`scheduler.js`)
`checkPlacement(state, {groupId, day, period, subjectId, roomId?, teacherId?, ignoreEntryId?}) → {ok, conflicts:[{type,message,entryId?}], warnings:[string]}` · `validateAll(state) → conflicts[]` (ทั้งตาราง คู่เดียวกันรายงานครั้งเดียว) · `hoursViolations(state)` · `availableClassrooms(...)` · `availableTeachers(...) → [{teacher, ok, conflicts}]` · `effectiveTeacherId(state, entry)` · `canMerge(a, b)`

กฎที่ **บล็อก** (ข้อความเหตุผลภาษาไทย ระบุกลุ่ม/ครู/ห้อง/วัน/คาบ):
| type | กฎ |
|---|---|
| `group` | กลุ่มเรียน + วัน + คาบ เดียวกัน มีได้ 1 รายการ |
| `teacher` | ครูที่มีผลคนเดียวกัน วัน+คาบเดียวกัน คนละกลุ่มเรียน ชน **ยกเว้น** `canMerge` · ครูต่างคนของวิชาเดียวกันต่างกลุ่มคาบเดียวกันได้ · ชนข้ามวิชาก็ชน · วิชาชีพเฉพาะเดียวกัน ครูคนเดียวกัน ต่างกลุ่ม = ชน |
| `classroom` | `roomId` เดียวกัน วัน+คาบเดียวกัน ถูกกลุ่มเรียนอื่นใช้ ชน **ยกเว้น** `canMerge` ที่ใช้ห้องเดียวกันได้ · `roomId` ว่างไม่ตรวจ · `roomId` ที่ไม่มี = `invalid` |
| `level` | `group.level` ต้องอยู่ใน `subject.levels` (ข้อความบอกระดับกลุ่มและระดับที่วิชาเปิด) |
| `hours` | จำนวนคาบของ (กลุ่มเรียน + วิชา) ต้องไม่เกิน `subject.hours` (`used + 1 > hours` ชน; `ignoreEntryId` ไม่นับ; เรียนรวมนับแยกต่อกลุ่ม) · `validateAll` รายงาน 1 รายการต่อกลุ่ม+วิชา `{groupId, subjectId, hours, used, entryId = คาบแรกที่เกินโควตา}` |
| `lunch` / `invalid` | พักเที่ยง · วัน/คาบ/กลุ่ม/วิชา/ห้องไม่ถูกต้อง หรือ `teacherId` ไม่อยู่ใน `subject.teacherIds` |

คำเตือน (ไม่บล็อก): วิชายังไม่มีครู · วิชามีหลายครูแต่ยังไม่เลือกครูของคาบ (ไม่นับชนครู) · วิชาไม่อยู่ใน `group.subjectIds` (กลุ่มที่ `subjectIds` ว่าง = ไม่เตือน)

### 4.1 ข้อมูลเดิมที่ผิดกฎ (legacy)
โหลดได้ไม่ throw ไม่ตัดคาบเงียบ ๆ (`legacyViolations(state)`) · ขณะมีรายการผิดกฎ op ที่เป็น "ซ่อม" ทำได้ถ้าไม่ทำให้แย่ลงและไม่เกิดรายการผิดใหม่ (`entry.remove`, `entry.removeMany`, `entry.move`, `group.delete`, `subject.delete`, `subject.upsert`) ส่วน op อื่นถูกปฏิเสธด้วย type `legacy` · นำเข้าไฟล์ที่ชั่วโมงเกินถูกปฏิเสธ เว้นแต่ตั้ง `trimOverHours` (`trimOverHours(state)` เก็บ `hours` คาบแรกเรียง วัน→คาบ ตัดที่ลงทีหลังสุด และรายงานรายการที่ถูกตัดครบ)

## 5. ops engine (`js/ops.js` — ตัวเดียวทั้งไคลเอนต์และเซิร์ฟเวอร์)
`applyOp(state, op) → { ok:true, state, changes, affected, warnings, remaining, … } | { ok:false, errors:[{type,message,…}] }` — pure ไม่แก้ input · ทุก op ตรวจ `parseState` + `validateAll` (รวมชั่วโมง) ก่อนคืน ok
- **op ทั้ง 18:** `subject|teacher|group|room|plan` × `.upsert {…:{id,…}}` (merge ฟิลด์ที่ส่ง) / `.delete {id}` (cascade: ลบกลุ่ม→ลบคาบ; ลบห้อง→`roomId=null`; ลบครู→ถอดจาก `teacherIds` และ `entry.teacherId=null`; ลบวิชา→ลบคาบ + ถอดจาก `group/plan.subjectIds`; ลบแผน→`group.planId=null`) · `group.applyPlan {groupId, planId, mode:'replace'|'merge'}` · `entry.place {id?, groupId, day, period, subjectId, roomId?, teacherId?}` · `entry.move {entryId, day, period, roomId?, teacherId?}` (ไม่ส่ง roomId/teacherId = คงเดิม, `null` = ล้าง) · `entry.update {entryId, roomId?, teacherId?}` · `entry.remove {entryId}` · `entry.placeMany` · `entry.removeMany` · `state.import {state | patch | rows, mode, trimOverHours}`
- `changes = { subjects|teachers|groups|rooms|plans|entries : { upsert:[แถว], remove:[id] } }` (delta) · `affected = { <คอลเลกชัน>:{added,updated,removed}, total:{…} }` (ใช้เขียนข้อความยืนยัน) · `applyChanges(state, changes)` ปรับ state ตาม delta
- ชนิด `errors[].type`: `unknown_op`, `invalid`, `invalid_id`, `notfound`, `duplicate`, `duplicate_slot`, `legacy`, `import` + ชนิดกฎชนข้อ 4 (`group|teacher|classroom|level|lunch|hours`)
- id ที่ไคลเอนต์ส่ง (`entry.place`, รายการใน `placeMany`) ต้องไม่ซ้ำของเดิม/ในชุด และผ่าน `validateId` ไม่งั้น `invalid_id` · ควรส่ง `id` เองเสมอ (`uid('e')`) เพื่อให้ฝั่งทำนายกับเซิร์ฟเวอร์ได้ id เดียวกัน
- ชื่อกลุ่มเรียนซ้ำถูกปฏิเสธใน `group.upsert` (ชื่อห้อง/แผนซ้ำถูกปฏิเสธโดย `parseState`)
- ข้อความฟิลด์ข้อความที่ส่งผ่าน op ถูกล้างอักขระอันตราย + NFC ให้ และมี warning บอกฟิลด์/id ที่ถูกแก้

### 5.1 ลง/ลบหลายช่อง (atomic)
```
{ type:'entry.placeMany', items:[{groupId, day, period, subjectId, roomId?, teacherId?, id?} …≤200], policy:'all'|'valid' (ค่าเริ่มต้น 'all'), dryRun? }
{ type:'entry.removeMany', entryIds:[…≤200], dryRun? }
```
- ตรวจ **เพดาน 200 และโครงสร้างก่อนทำงานหนัก** (เกิน/ว่าง/policy ผิด = `ok:false` `invalid`)
- ประมวลผลตามลำดับ **(day, period) น้อย→มาก** (เสมอกันใช้ index เดิม) ผลไม่ขึ้นกับลำดับที่ส่ง · แต่ละรายการตรวจกับ state + รายการก่อนหน้าที่ผ่านในชุด (ชนกันเอง/ชั่วโมงสะสม: เหลือ H ช่อง → ผ่านแค่ H ช่องแรก ที่เหลือ `hours`) · ต่อรายการใช้ `checkPlacement` แล้ว `validateAll` ครั้งเดียวตอนท้าย
- **ช่องซ้ำในชุด = กลุ่มเรียน + วัน + คาบ** → รายการหลังถูกปฏิเสธ `duplicate_slot` ("ช่องซ้ำในชุด")
- ผล: `items:[{index,day,period,ok,id?|errors?}]`, `placed:[{index,day,period,id}]`, `rejected:[{index,day,period,errors}]`, `summary:{placeable:K,total:N,rejected}`
- `policy:'all'` มีรายการไม่ผ่าน → `ok:false` ไม่เปลี่ยนอะไรเลย (เซิร์ฟเวอร์ตอบ 422 พร้อม `items` รายช่อง) · `policy:'valid'` ลงเฉพาะที่ผ่าน; ไม่มีรายการผ่านเลย = `ok:false`
- `removeMany`: ทุก id ต้องมีอยู่ (ไม่พบ/รูปแบบผิด = `ok:false` ทั้งชุด `errors:[{type,index,id}]`); id ซ้ำในชุดนับเป็นรายการเดียว; เป็น op "ซ่อม" (ข้อ 4.1)
- **`dryRun:true` (สัญญาเดียวทั้งระบบ):** คืน `{ok:true, dryRun:true, wouldSucceed, items, placed, rejected, summary, affected}` และ **HTTP 200 เสมอ** (ยกเว้นโครงคำขอผิด) ไม่เขียน/ไม่เพิ่ม version/ไม่เขียน audit/ไม่คืน state ใหม่ · `wouldSucceed` ตามความหมายของ policy
- op เดียว = CAS ครั้งเดียวที่ `tt:v` (เพิ่ม version 1 ครั้ง) ไม่ใช่หลาย op · audit บันทึก 1 รายการพร้อมจำนวน placed/rejected/removed

### 5.2 แผนการเรียน (`applyPlan`)
`applyPlan(state, groupId, planId, {mode}) → {ok, state, added, skipped:[{subjectId,reason,message}], kept, warnings}` — `replace` = `group.subjectIds` เท่ากับวิชาของแผนที่ระดับตรงกลุ่ม **และคงวิชาที่กลุ่มมีคาบอยู่แล้วแต่ไม่อยู่ในแผน** (พร้อม warning) ไม่ลบคาบเดิม; `merge` = เพิ่มเฉพาะที่ยังไม่มี; วิชาที่ `subject.levels` ไม่รวมระดับกลุ่มถูกข้ามและรายงาน; ระดับแผนไม่ตรงกลุ่ม = warning · ตั้ง `group.planId` ทั้งสองโหมด · UI เรียกฟังก์ชันนี้ตรง ๆ ได้เพื่อแสดงตัวอย่างก่อนยืนยัน (pure)

## 6. นำเข้า Excel (`js/importer.js` — pure; ตัวอ่านไฟล์เป็นของ UI)
`importWorkbook(state, sheets, {trimOverHours:false}) → { ok, report, state? (เฉพาะ ok) }`
- `sheets = { 'รายวิชา': rows, … }` โดย `rows` เป็น array ของ object `{__row, 'หัวคอลัมน์*': ค่า}` หรือ array ของ array (แถวแรกคือหัว) · หัวคอลัมน์ตัด `*` และช่องว่างหัวท้าย · `__row` = เลขแถวใน Excel (หัว = 1)
- `report = { ok, summary:{[ชื่อชีต]:{add,update,skip}}, rows:[{sheet,row,column?,level:'error'|'warning'|'info',message}], trimmed:[…] }` (แถวภาพรวม `sheet:'ภาพรวม' row:0` = ผลตรวจรวมหลังผสาน)
- ชีตและคอลัมน์ (หัวภาษาไทยตายตัว; `*` = จำเป็นสำหรับแถวใหม่):
| ชีต | คอลัมน์ |
|---|---|
| `รายวิชา` | `รหัสวิชา*` (คีย์), `ชื่อวิชา*`, `ประเภท*` (สามัญ\|วิชาชีพ), `ท`, `ป`, `ชม./สัปดาห์` (ว่าง = ท+ป; กรอกครบต้องเท่ากัน; ≥1), `หน่วยกิต`, `ระดับที่เปิดสอน*` (คั่น `,`), `ครูผู้สอน` (ชื่อครู คั่น `,`), `หมายเหตุ` |
| `ครูผู้สอน` | `ชื่อครู*` (คีย์), `แผนก/สาขา` |
| `ห้องเรียน` | `ชื่อห้องเรียน*` (คีย์), `อาคาร`, `ความจุ`, `หมายเหตุ` |
| `กลุ่มเรียน` | `ชื่อกลุ่มเรียน*` (คีย์), `ระดับ*`, `สาขา`, `แผนการเรียน` (ชื่อแผน), `รหัสวิชา` (คั่น `,` ผูกเพิ่ม) |
| `แผนการเรียน` | `ชื่อแผน*` (คีย์), `ระดับ*`, `รหัสวิชา*` (คั่น `,`), `หมายเหตุ` |
- ชีตที่ไม่มี = ข้าม · ชีตแปลก (เช่น `วิธีใช้`) = ข้ามพร้อมข้อมูล info · แถวว่างข้าม · ตัวเลขเป็นจำนวนเต็ม ≥0
- **merge ตามคีย์:** ตรงกัน = อัปเดตฟิลด์ที่กรอก (ว่าง = ไม่ทับ; ทับค่าเดิมที่ต่างกัน = warning) · ไม่ตรง = เพิ่มใหม่ · **ไม่ลบอะไร** · อ้างอิงข้ามชีต (ชื่อครู/รหัสวิชา/ชื่อแผน) หาไม่พบ = error · ชื่อซ้ำในไฟล์ = error (ครูซ้ำ = warning ข้ามแถว) · ชื่อซ้ำในระบบ = warning ใช้รายการแรก · เปรียบเทียบคีย์หลัง NFC/ตัดอักขระควบคุมทั้งสองฝั่ง
- **atomic:** error ≥1 → `ok:false` ไม่มี `state` ไม่เปลี่ยนอะไร · หลังผสานต้องผ่าน `parseState` และ `validateAll` (รวมชั่วโมง) · `trimOverHours:true` ตัดคาบส่วนเกินและรายงาน
- จำกัด: ไฟล์ ≤5 MB, ≤5,000 แถว/ชีต, เซลล์ ≤500 ตัวอักษร, ชื่อ/รหัส ≤200 (รายงานที่ชีต/แถว/คอลัมน์จริง) · `checkXlsxFile({name,size,bytes})` ตรวจนามสกุล .xlsx/ขนาด/magic bytes `PK` · ล้างอักขระควบคุม/กำกับทิศทางในเซลล์พร้อม warning
- **ไคลเอนต์** ผ่าน `zip-guard` ก่อนอ่าน (ไฟล์ ≤100 ใน zip, ขนาดหลังคลายรวม ≤50 MB, อัตราบีบอัด, ไม่มีชื่อไฟล์ `..`, ปฏิเสธ `vbaProject.bin`/`externalLinks`/.xlsm, ต้องมี `[Content_Types].xml` + `xl/workbook.xml`, ตรวจ `<dimension>`) แล้วอ่านด้วย `read-excel-file` · **เซิร์ฟเวอร์ไม่ parse .xlsx** ถือ rows เป็น JSON ไม่เชื่อถือ (จำกัดแถว/ความยาว/ชนิด/อักขระ + NFC) และรันตัวนำเข้าซ้ำ

## 7. ค้นหา/กรอง/แบ่งหน้า (`js/list-model.js`)
`normalizeText` (NFC + ตัวพิมพ์เล็ก + ตัดอักขระควบคุม/zero-width + ยุบช่องว่าง; ไทยค้นตรงตัว ไม่ตัดวรรณยุกต์/สระ) · `matchQuery(item, fields, query)` (ทุกคำแยกด้วยช่องว่างต้องอยู่ใน field ใด field หนึ่ง) · `filterItems(items, {query, fields, filters})` (มีดัชนี normalize cache ต่อรายการ — ใช้ฟังก์ชัน `fields` ตัวเดียวกันและรายการ immutable) · `sortItems(items, {key, dir})` (`Intl.Collator('th')` เลขในรหัสเรียงเชิงตัวเลข เสถียร) · `paginate(items, {page, pageSize})` → `{items, page, pageSize, total, totalPages, from, to}` (`pageSize` ∈ {25,50,100} อื่น→25, page clamp) · `queryList(...)` รวมสามขั้นตอน + `matched`
ไม่ใช้ object เป็นดัชนีด้วยคีย์จากข้อมูล · เป้าหมาย 500–5,000 รายการ ค้นต่อครั้ง < 50 ms (ใช้ `Map`/`WeakMap`)

## 8. หน้าจอและพฤติกรรม UI
- **เมนู/เส้นทาง (hash):** `#/schedule` จัดตาราง · `#/subjects` รายวิชา · `#/groups` กลุ่มเรียน · `#/plans` แผนการเรียน · `#/classrooms` ห้องเรียน · `#/teachers` ครู · `#/group-view` `#/teacher-view` `#/classroom-view` (ตารางอ่านอย่างเดียว) · `#/export` ส่งออก/พิมพ์ · `#/data` ข้อมูล (นำเข้า/ส่งออก JSON/Excel) · `#/shares` ลิงก์แชร์ · `#/settings` ตั้งค่า · `#/login` · `#/view/<token>/…` (ผู้ถือลิงก์) · `#/` ผู้ไม่ล็อกอิน = หน้าสาธารณะ
- **หน้ากลุ่มเรียน/ห้องเรียน/แผน/วิชา:** เพิ่ม/แก้/ลบ (ลบแบบ cascade ต้องยืนยันและบอกจำนวนที่กระทบ จากฟังก์ชัน cascade ของ `store`) · ฟอร์มวิชามี "ระดับที่เปิดสอน" หลายค่า (ต้องเลือก ≥1) และเลือกครูได้หลายคน · ลด `hours` ต่ำกว่าที่ลงแล้ว → ไม่บันทึก
- **หน้าลงตาราง:** เลือกกลุ่มเรียน → แผงวิชาของกลุ่ม (ต้องเรียน/จัดแล้ว/เหลือ + ครู; เรียงวิชาที่เหลือก่อน แล้วตามรหัส; ครบ = "เสร็จ ✓"; เกิน = แดง "เกิน N ชม."; กลุ่มที่ `subjectIds` ว่างแสดงข้อความพร้อมปุ่มลัดไปเลือกแผน) · คลิกวิชาในแผง = วิชาที่กำลังลง → คลิกช่องว่างเปิดขั้นเลือกครู/ห้องเรียน (ข้ามขั้นเลือกวิชา) · ช่องที่ลงไม่ได้แสดงเหตุผลเมื่อคลิก · ช่องที่ลงแล้วแสดงวิชา/ครู/ห้อง และแก้ครู/ห้องได้
- **ตัวกรอง "แสดงเฉพาะวิชาที่ลงได้":** ค่าเริ่มต้นติ๊ก ซ่อนวิชาที่ลงไม่ได้ (ระดับไม่ตรง/ชน/ชั่วโมงเต็ม/พักเที่ยง) แสดง "ซ่อน N วิชาที่ลงไม่ได้" และ empty state ถ้าไม่เหลือ; วิชาหลายครูถือว่าลงได้เมื่อมีครูอย่างน้อย 1 คนที่ไม่ชน · จำค่าในที่เก็บของเบราว์เซอร์ คีย์ `timetable.ui.onlyPlaceable` (`'1'`/`'0'`) ไม่อยู่ใน state/export
- **เลือกหลายช่อง:** ปุ่มสลับ "โหมดเลือกหลายช่อง" · ตั้งวิชา/ครู/ห้องครั้งเดียว · คลิกสะสม (คลิกซ้ำยกเลิก) · ลากต่อเนื่อง (สี่เหลี่ยมผืนผ้า) · Shift+คลิกช่วง · รองรับทัช (pointer events; ปุ่ม "เพิ่ม/ลบ ช่วงเลือก") · ช่องพักเที่ยง/ช่องที่มีวิชาแล้ว (ในโหมดลง) ไม่ถูกเลือก (ข้ามเงียบแต่นับในรายงาน) · แถบสถานะ "เลือก N ช่อง" (กรอบ + ✓ ไม่พึ่งสีอย่างเดียว) · ปุ่ม "ลงตาราง (N ช่อง)" / "ล้างการเลือก" / "ยกเลิกโหมด" · Esc = ล้างการเลือก · กดลง → `dryRun` → ทุกช่องลงได้ = ลงเลย; บางช่องไม่ได้ = กล่องผลรายช่อง (วัน/คาบ/สถานะ/เหตุผลไทย) + "ลงเฉพาะช่องที่ลงได้ (K จาก N)" / "ยกเลิกทั้งชุด" (ไม่มีการลงกึ่งกลาง) · โหมดลบหลายช่อง: เลือกช่องที่ลงแล้ว → "ลบที่เลือก (N)" → ยืนยันระบุจำนวน/รายชื่อวิชา → `entry.removeMany` · สำเร็จ = ล้างการเลือก + ข้อความสรุป; ล้มเหลว (409/422/ออฟไลน์/401) ไม่แสดงว่าสำเร็จ
- **ทุกรายการที่ยาว** ใช้ชุดค้นหา/กรองระดับ+ประเภท/แบ่งหน้า 25-50-100 เหมือนกัน (`list-kit`) · จำค่าต่อรายการในที่เก็บของเบราว์เซอร์คีย์ `tt.ui.list.<ชื่อ>` (ผู้ชมใช้ที่เก็บระดับแท็บ) ค่าที่อ่านกลับถือเป็นข้อมูลไม่เชื่อถือ (ตรวจชนิด, `pageSize` ∈ {25,50,100}, คำค้น ≤200, **ห้ามสร้าง `RegExp` จากคำค้น**) · logout ล้างทั้งหมด · เรนเดอร์เฉพาะหน้าปัจจุบัน (≤100 แถว)
- แถบสถานะการเชื่อมต่อ: บันทึกแล้ว / กำลังบันทึก / มีผู้แก้ไขพร้อมกัน / ออฟไลน์ · ไม่มีปุ่ม "บันทึกตารางทั้งก้อน" — ทุกการแก้ไขเป็น op ทีละรายการ (409 → ดึงข้อมูลใหม่ ทำนายซ้ำ ถ้าไม่ชนส่งอีกครั้งเดียว มิฉะนั้นขึ้น "มีผู้แก้ไขพร้อมกัน โปรดตรวจสอบ")
- ความปลอดภัยของ UI: ทุกค่าจากข้อมูลผ่าน `esc()` ตัวเดียว · ไม่มี inline handler (ใช้ `data-*` + event delegation) เพื่อรองรับ CSP

## 9. สิทธิ์ ล็อกอิน โหมดสาธารณะ ลิงก์แชร์
- **แอดมินเท่านั้นแก้ได้:** ทุก endpoint เขียนต้องผ่าน session แอดมิน — ลิงก์แชร์/โหมดสาธารณะไม่ให้สิทธิ์เขียนใด ๆ · UI ซ่อนปุ่มแก้ แต่สิทธิ์จริงตัดสินที่เซิร์ฟเวอร์
- **ล็อกอิน:** username + password · บัญชีใน env `ADMIN_ACCOUNTS` (`username:scryptHash` คั่น `;`; username ไม่แยกตัวพิมพ์; ซ้ำ = ConfigError) · รหัสผ่านขั้นต่ำ 10 ตัว สร้างแฮชด้วย `npm run hash-password -- <username>` (รับรหัสผ่านจาก prompt ซ่อนตัวอักษรหรือ stdin ไม่รับเป็น argument; ตรวจ roundtrip ก่อนพิมพ์; ไม่เก็บอะไรลงดิสก์) · scrypt `N=2^15, r=8, p=1` ตั้ง `maxmem` ≥ 128·N·r·2 ทั้ง hash/verify, อ่าน N/r/p จากสตริงแฮชแต่จำกัดสูงสุด (N ≤ 2^17, r ≤ 16, p ≤ 4), `timingSafeEqual` ตรวจความยาวก่อน, username ไม่พบเทียบกับ dummy hash · เปลี่ยนรหัส/เพิ่ม/ลบแอดมิน = แก้ env + redeploy (session เดิมของบัญชีนั้นตายทันที)
- **session:** token สุ่ม 32 ไบต์ → คุกกี้ `__Host-tt_session` (`HttpOnly; Secure; SameSite=Lax; Path=/` ไม่ตั้ง Domain) · ฝั่งเซิร์ฟเวอร์เก็บ `sess:<sha256(token)>` `{username, pwdVersion, createdAt, lastSeen}` ใน Redis · idle 2 ชม. ต่ออายุได้ / absolute 12 ชม. จาก `createdAt` · ทุกคำขอตรวจกับ `ADMIN_ACCOUNTS` · login ใหม่เปลี่ยน token และลบ session เดิมของ cookie ที่มากับคำขอ · logout ลบทิ้ง
- **CSRF:** คำขอเขียน/login ต้อง `Content-Type: application/json` + header `X-Requested-With: tt` + ตรวจ `Origin`/`Sec-Fetch-Site` (ไม่มีทั้งคู่ → 403) เทียบกับ allowlist `ALLOWED_ORIGINS` (ไม่ใช้ Host/x-forwarded-host) · ไม่ตอบ CORS header ใด ๆ · GET ไม่มีผลข้างเคียง
- **rate limit login:** ตรวจก่อนเรียก scrypt · ต่อ IP+username, ต่อ username รวมทุก IP (สูงกว่า), รวมทั้งระบบ; นับด้วย Lua อะตอมมิก (INCR+EXPIRE); IP จาก header ที่ Vercel เขียนให้ · ข้อความ/สถานะ/ขนาดตอบคงที่ ไม่บอกว่า username ถูกหรือไม่ · ไม่ log รหัสผ่าน/โทเค็น
- **โหมดสาธารณะ** (`GET /api/public`, ไม่ต้องล็อกอิน, ไม่สนใจ cookie ในการให้สิทธิ์): ผู้ชมทั่วไปเปิดเว็บเห็นตารางทั้งสถานศึกษาแบบอ่านอย่างเดียว (เลือกประเภท กลุ่มเรียน/ครู/ห้องเรียน → รายการค้นหาได้ → ตารางอ่านอย่างเดียว + พิมพ์/ส่งออกเอง) · `enabled:false` → 403 `{error:'public-disabled'}` ไม่มี state · ส่งเฉพาะ `subjects, groups, rooms, entries` ที่จำเป็น (ไม่ส่งบัญชีแอดมิน ลิงก์แชร์ audit snapshot settings อื่น token ใด ๆ) · rate limit แยกจากผู้ดูลิงก์ 300/นาที/IP (ตั้งค่าใน env ได้) และตรวจรูปแบบก่อนแตะ Redis · แคชผลกรองตาม `(tt:v, revision ของ settings, effectiveHide)` + `ETag`/`If-None-Match` → 304 (ตรวจ settings ทุกคำขอก่อนใช้แคช) · `Cache-Control: no-cache` + ETag เฉพาะ endpoint นี้ ห้ามมี `public`/`s-maxage`
- **ซ่อนชื่อครู (PDPA):** `hideTeacherNames` ค่าเริ่มต้น `null` = ยังไม่ยืนยัน = **ซ่อน** (`effectiveHide = hideTeacherNames !== false`) · ผู้ชมเห็นชื่อครูได้เมื่อแอดมินตั้ง `false` เอง (สวิตช์ "แสดงชื่อครูในโหมดสาธารณะ" + คำเตือน PDPA; แอดมินเห็นแบนเนอร์ "ยังไม่ได้ตัดสินใจเรื่องแสดงชื่อครูต่อสาธารณะ — ตอนนี้ซ่อนอยู่" จนกว่าจะบันทึกตั้งค่า บันทึก `confirmedAt`/`updatedBy`) · เมื่อ `effectiveHide=true`: response ไม่มี `teachers`, `teacherIds`, `teacherId`, `plans`, `dept` และตัด `note` ทุกฟิลด์ (subjects/rooms/groups) — ซ่อนที่เซิร์ฟเวอร์ ไม่ใช่แค่ UI · ส่งออกในหน้าสาธารณะใช้ข้อมูลที่กรองแล้วเท่านั้น
- **fail-closed:** `tt:settings` ขาด/เสีย/ชนิดผิด/Redis อ่านไม่ได้ → `effectiveHide=true`; อ่าน state ไม่ได้ → 503 ไม่คืนข้อมูลบางส่วน; ห้ามตกไปเป็น "แสดงชื่อครู"
- **ตั้งค่า** (`GET/PUT /api/settings`, แอดมินเท่านั้น, CSRF ครบ): allowlist ทีละคีย์ (`publicMode.enabled` boolean, `publicMode.hideTeacherNames` true/false เท่านั้น ห้ามส่ง null กลับ; คีย์/ชนิดอื่น = 422) · ต้องส่ง `revision` (ชน = 409) · บันทึก audit · มีผลทันทีไม่ต้อง deploy · ค่าเริ่มต้นเปิดโหมดสาธารณะตามที่บอสสั่ง
- **ลิงก์แชร์ดูอย่างเดียว** (`/#/view/<token>`): scope `all` | `group:<id>` | `teacher:<id>` | `room:<id>` · มี label · สร้างหลายลิงก์ · เพิกถอน (ใช้ไม่ได้ทันที) · สร้างใหม่ (เพิกถอนตัวเก่า + ออกโทเค็นใหม่ scope เดิม) · token สุ่ม ≥128 บิต base64url (ใช้ 256 บิต) เก็บฝั่งเซิร์ฟเวอร์เป็น SHA-256 เท่านั้น แสดงเต็มครั้งเดียว · ส่งทาง header `X-Share-Token` เท่านั้น (ไม่มี `?share=`) UI อ่านจาก fragment เก็บในหน่วยความจำ ไม่เขียนที่เก็บของเบราว์เซอร์ · แต่ละลิงก์มี `shareId` สุ่ม (ไม่ลับ) ใช้ list/revoke/regenerate + index `tt:shares` · **scope `all` หมดอายุ 90 วันโดยค่าเริ่มต้น** (ต่ออายุด้วยสร้างใหม่) scope อื่นตั้ง `expiresAt` ได้ · ลบกลุ่ม/ครู/ห้อง หรือ `state.import` แบบ replace → ลิงก์ที่ scope ชี้ id นั้นถูกเพิกถอนใน CAS เดียวกัน (สร้าง id เดิมใหม่ก็ไม่กลับมา) · API คืนเฉพาะ entry ใน scope + ชื่อที่จำเป็นต่อการแสดง · token ผิด/ถูกเพิกถอน → หน้า "ลิงก์นี้ใช้ไม่ได้" ไม่บอกรายละเอียด · rate limit ผู้ดู 120/นาที/IP ก่อนแตะข้อมูล ตรวจรูปแบบ token ก่อนเรียก Redis

## 10. API และที่เก็บข้อมูล
- Vercel Functions 11 ไฟล์ใน `api/` (เพดาน Hobby 12): `auth/{login,logout,me}`, `state`, `op`, `import`, `migrate`, `shares`, `snapshots`, `public`, `settings` · โค้ดร่วมอยู่ `server/` (ไม่นับเป็น endpoint) · สัญญาละเอียด: `docs/API.md`
- **`POST /api/op {op, baseVersion}`:** โหลด state → `applyOp` (โมดูลร่วม) → `validateAll` → เขียนด้วย Lua `EVAL` compare-and-set (`tt:v == baseVersion` → เขียนทุก key ที่เปลี่ยน + `INCR tt:v` ในสคริปต์เดียว; ไม่ตรง → 409 `{latestVersion}`) · ตอบ 200 `{version, changes, affected, warnings, …}` | 409 | 422 `{errors, items?}` · `dryRun` ระดับ body แปลงเป็นระดับ op ให้เป็นรูปเดียวกัน · ปฏิเสธ op ที่ไม่รู้จัก/โครงผิด/ขนาดเกิน (body ≤ 1 MB; import ≤ 4 MB)
- **Redis keys:** `tt:v` (version), `tt:meta`, `tt:subjects`, `tt:teachers`, `tt:groups`, `tt:rooms`, `tt:plans`, `tt:entries:<groupId>` (shard ต่อกลุ่ม เลี่ยงเพดานคำขอ 1 MB), `tt:settings`, `tt:shares`, `share:<hash>`, `sess:*`, `rl:*`, `tt:snap:<version>`, `tt:audit`
- **snapshot/audit:** ก่อน op ทำลายล้าง (`/api/migrate` แบบ `force`, `state.import` แบบ replace/trim) เก็บ `tt:snap:<version>` ล่าสุด 5 ชุด หมดอายุ 30 วัน ภายใน CAS เดียว ดาวน์โหลดได้ (แอดมิน) · audit `tt:audit` ≤500 รายการ (เวลา, username, ชนิด op, version, แฮช IP; ไม่เก็บ secret) · UI ยืนยันระบุจำนวนที่จะถูกลบ (`affected`/`trimmed`)
- **`/api/migrate`:** รับ state v1–v5 → migrate + validate → เขียนเมื่อฐานข้อมูลว่าง (หรือ `force:true` ที่แอดมินยืนยัน หลังถ่าย snapshot) · รับเฉพาะชั่วโมงเกินเป็น legacy ความผิดอื่น (ชน/อ้างอิงขาด) = 422
- **env ฝั่งเซิร์ฟเวอร์** (ห้ามขึ้นต้น `VITE_`): `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN` (หรือชุด `KV_REST_API_URL`+`KV_REST_API_TOKEN` ที่ Vercel Upstash integration สร้างให้ — ใช้ทั้งคู่จากชุดเดียวกัน ไม่ผสมชุด; รายละเอียดที่ `DEPLOY.md` ข้อ 2.1), `SESSION_SECRET` (≥32 ไบต์), `ADMIN_ACCOUNTS`, `ALLOWED_ORIGINS`; ไม่บังคับ `UPSTASH_REDIS_REST_READONLY_TOKEN` (เส้นทางผู้ดู), `PUBLIC_RATE_LIMIT` · ไม่มี secret ใน repo/bundle/log · build ล้มถ้าตั้งตัวแปร `VITE_*` ที่ชื่อเหมือนความลับ · แยก env Production กับ Preview (คนละฐานข้อมูล/บัญชีแอดมิน) และเปิด Deployment Protection ให้ Preview
- **Headers (`vercel.json`):** CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` + `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` ปิดของที่ไม่ใช้, HSTS · `Cache-Control: no-store` กับ `/api/*` ยกเว้น `/api/public` (`no-cache` + ETag) · region `sin1`, `maxDuration` 10 · rewrites ของ SPA ยกเว้น `/api/*`
- ฟังก์ชันไม่ log secret · `Cache-Control`/header ตามข้างต้น

## 11. ส่งออก / พิมพ์ (`js/export/**`)
- **ประเภท/ขอบเขต:** รายครู / รายห้องเรียน / รายกลุ่มเรียน · เลือก "รายการเดียว" | "หลายรายการ (ติ๊ก)" | "ทั้งหมดของประเภท" | "ทุกประเภท" · รูปแบบ .xlsx และ .pdf เป็น **ไฟล์รวม** ชื่อไฟล์มีวันที่ (xlsx: 1 ชีตต่อรายการ ชื่อชีต ≤31 ตัวอักษร ไม่ซ้ำ ไม่มีอักขระต้องห้าม/`..`; pdf: 1 หน้า A4 แนวนอนต่อรายการ) · รายการว่างยังออกหน้า/ชีตพร้อม "ยังไม่มีคาบ" · ภาคเรียน/ปีการศึกษากรอกในกล่องส่งออก (ไม่เก็บในระบบ) · ผู้ดู/สาธารณะส่งออกได้เฉพาะข้อมูลที่ API ให้ (ภายใน scope)
- **เนื้อหาตาราง:** คอลัมน์ = คาบ 1–11 + พักเที่ยง, แถว = จันทร์–ศุกร์ · ช่อง = รหัส ชื่อวิชา + ครู/กลุ่ม/ห้องตามมุมมอง · เรียนรวมมีป้ายกำกับ · หัวกระดาษ = ชื่อรายการ + ภาคเรียน/ปี + วันที่พิมพ์
- **PDF:** `pdfmake` + ฟอนต์ Sarabun ฝัง (`public/fonts/` + ไฟล์ลิขสิทธิ์ OFL) โหลดแบบ dynamic import ตอนส่งออก · พอดี 1 หน้า A4 แนวนอน (margin ≤ 8 mm) · ขนาดฟอนต์ต่อช่องคำนวณจากเมตริกฟอนต์จริง (`font-metrics.js` สร้างด้วย `scripts/gen-font-metrics.mjs`) ลดได้ถึง ≥ 6 pt แล้วตัดบรรทัด/`…` · ข้อความที่ถูกตัดมีที่ให้อ่านครบ (legend รหัสวิชา→ชื่อเต็ม) · ห้ามข้อความล้นเส้นขอบช่อง
- **xlsx:** `write-excel-file` · ทุกเซลล์ที่มาจากข้อมูลเป็น string ชัดเจน ไม่มีสูตร (`<f>`); ค่าที่ขึ้นต้น `= + - @ \t \r` ถูก prefix กันตีความเป็นสูตร · เทมเพลตนำเข้า (5 ชีต + ชีต `วิธีใช้` ที่ importer ข้าม) และรายงานนำเข้า .xlsx ใช้ชื่อชีต/คอลัมน์จาก `IMPORT_SHEETS`/`IMPORT_COLUMNS`
- **พิมพ์จากเบราว์เซอร์:** `@page { size: A4 landscape; margin: 8mm }`, `table-layout: fixed`, `overflow-wrap: anywhere`, `lang="th"`, `break-inside: avoid`, 1 รายการต่อ 1 หน้า (`break-after: page`) · คลาสขนาดฟอนต์ในช่อง `tt-fs-1..4` คำนวณจากความยาวข้อความ (`cell-size.js`) ไม่ใช้ JS วัดพิกเซล
- **อ่านออกเมื่อพิมพ์ขาวดำ (ไม่พึ่งสีอย่างเดียว) ตรงกันทั้งจอ/พิมพ์เบราว์เซอร์/PDF:**
| ชนิดช่อง | สี (จอ) | ขาวดำ/พิมพ์ |
|---|---|---|
| วิชาสามัญ | พื้นอ่อน | ลายพื้นเทาอ่อน/ตัวปกติ + สัญลักษณ์ ○ "ส" |
| วิชาชีพเฉพาะ | พื้นเข้มขึ้น | ลายพื้นเทากลาง/ลายเส้นทแยง + ตัวหนา + ● "ช" |
| เรียนรวม | ขอบม่วง | ขอบคู่/ขอบหนา + "ร" |
| พักเที่ยง | เทา | ลายเส้นทแยงถี่ + ข้อความ "พัก/เที่ยง" |
| ช่องว่าง | ขาว | ขาว |

## 12. Dependency ที่อนุญาต (ปักเวอร์ชันตรง ๆ)
`vite` 8.3.4 (dev) · `@upstash/redis` 1.39.0 (ฝั่งเซิร์ฟเวอร์) · `read-excel-file` 9.3.12 (อ่าน .xlsx ฝั่งไคลเอนต์) · `write-excel-file` 4.1.1 · `pdfmake` 0.3.11 (dynamic import เฉพาะตอนส่งออก) · `@fontsource/sarabun` 5.3.0 (แหล่งไฟล์ฟอนต์ไทย OFL; คัดลอกเฉพาะที่จำเป็นไป `public/fonts/`) · **ไม่ใช้ `xlsx`/SheetJS จาก npm** (รุ่นบน npm เก่า มีช่องโหว่ที่ทราบ) · hash รหัสผ่านใช้ `node:crypto` scrypt (ไม่เพิ่ม lib) · `engines.node = 22.x` · ถ้าจำเป็นต้องเพิ่ม dependency: แจ้งเหตุผล ปักเวอร์ชัน และเพิ่มในตารางข้อ 4.4 ของ `docs/HANDOFF.md`

## 13. โครงไฟล์ (สภาพจริง)
```
index.html · package.json · vite.config.js · vercel.json · .env.example · .vercelignore · .gitignore · README.md
docs/        SPEC.md · HANDOFF.md · API.md · DEPLOY.md · USER-GUIDE.md · design.md
api/         auth/{login,logout,me}.js · state.js · op.js · import.js · migrate.js · shares.js · snapshots.js · public.js · settings.js
server/      auth.js · http.js · redis.js · session.js · settings.js · shares.js · store.js
js/          constants · scheduler · store · ops · importer · list-model · validate · selection-model · panel-model · cell-size
             zip-guard · excel-reader · storage-adapter · api-client · app · app-core · export/** · pages/**
css/style.css · public/fonts/ · scripts/{hash-password.mjs, gen-font-metrics.mjs} · dist/ (ผล build)
```
เจ้าของงานหลัก: โดม = `js/constants, scheduler, store, ops, importer, list-model, validate, storage-adapter` · ฟ้า = `index.html, js/app*, js/pages/**, js/api-client, js/selection-model, js/panel-model, js/cell-size, js/zip-guard, js/excel-reader` · มิ้นท์ = `docs/design.md, css/style.css` · ไนน์ = `api/**, server/**, vercel.json, vite.config.js, package.json, scripts/hash-password, docs/API.md, docs/DEPLOY.md` · อิงค์ = `js/export/**, public/fonts` · เปา = สเปก ตัดสินใจ ตรวจ และส่งมอบ

## 14. เกณฑ์ที่ใช้ตัดสินว่าเสร็จ (สภาพ production)
- `npm run build` ผ่าน · ไม่มี inline handler/ค่าจากข้อมูลที่ไม่ผ่าน `esc()` · ไม่มี secret ใน bundle · กฎชั่วโมงบล็อกทุกเส้นทาง (ลง ย้าย นำเข้า API) · เซิร์ฟเวอร์ปฏิเสธการเขียนจากผู้ดู/ผู้ชมทั่วไป/ผู้ไม่ล็อกอิน · ข้อมูลเดิม v1–v3 นำเข้าและ migrate ได้ · เอกสาร deploy ครบ
- รายงานตรงไปตรงมาเสมอว่าอะไรทดสอบจริง อะไรตรวจจากโค้ด อะไรไม่ได้ทดสอบ — สถานะปัจจุบันและรายการที่ยังไม่ได้ทดสอบอยู่ใน `docs/HANDOFF.md` ข้อ 6 (ไม่มีชุดทดสอบอัตโนมัติเหลือในโปรเจกต์ production)

## 15. สมมติฐานและคำถามค้างถึงบอส
สมมติฐานเรื่อง ศธ.02 (ข้อมูลหลัก ชม./สัปดาห์ = ท+ป เท่ากันทุกกลุ่ม ไม่ตรวจชั่วโมงสอนสูงสุดของครู/ความจุห้อง ข้อมูลชุดเดียวทั้งสถานศึกษา บัญชีแอดมินใน env) อยู่ใน `docs/HANDOFF.md` ข้อ 1.2 · คำถามค้างทั้งหมด (Q-A..Q-G, R-A..R-E, ขอบัญชี Upstash/Vercel, ยืนยันการตัดชุดทดสอบ) อยู่ที่ `docs/HANDOFF.md` ข้อ 7 — ระหว่างรอคำตอบใช้ค่าสมมติฐานเดิม

## ภาคผนวก ก. ที่มาของกติกา (คำสั่งบอส)
O1 = เว็บตารางเรียนเริ่มต้น (ตรวจชนครู/ห้อง/คาบ, เรียนรวมวิชาสามัญ) · O3 = กลุ่มเรียน/ห้องเรียน/ระดับ, ห้องไม่บังคับ, ผังคอลัมน์=คาบ แถว=วัน · O4 = ตัวกรองวิชาที่ลงได้ + หลายครูต่อวิชา · O15 = ชั่วโมงบังคับ, แผนการเรียน, นำเข้า Excel, ล็อกอินแอดมิน + ลิงก์แชร์, Vercel + Upstash, ส่งออก xlsx/pdf, แผงวิชาของกลุ่ม · O16 = ย้ายโฟลเดอร์เป็น `timetable/` · O17 = ลง/ลบหลายช่อง, โหมดสาธารณะ, ค้นหา/แบ่งหน้า, พิมพ์ A4 ขาวดำ · O20 = ตัดให้เหลือ production อย่างเดียว (ไม่มีโหมดทดลอง/ข้อมูลตัวอย่าง/ชุดทดสอบในโปรเจกต์)
