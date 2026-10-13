# design.md — สเปก UI ระบบจัดตารางเรียนตารางสอน (ศธ.02 / สอศ.)

เจ้าของ: มิ้นท์ · ผู้ใช้หลัก: เจ้าหน้าที่ธุรการ (ใช้งานบนจอ ≥768px, ไม่รองรับมือถือ) · สไตล์ทั้งหมดอยู่ที่ `css/style.css`

## 1. หลักการ
- อ่านง่าย ตัวอักษรไม่เล็กกว่า 13px (ข้อความในช่องตาราง .85rem) พื้นหลังอ่อน ขอบชัด
- สถานะห้ามพึ่งสีอย่างเดียว: ชน = ขอบหนา 2px + ข้อความ "ชน", พักเที่ยง = ลายเฉียง + คำว่า "พักเที่ยง", เรียนรวม = badge "เรียนรวม"
- ปุ่มและช่องกรอกสูง ≥40px, focus เป็นขอบส้ม 3px
- ภาษาไทยทั้งหมด

## 2. ฟอนต์
`Sarabun` → `Noto Sans Thai` → `Leelawadee UI` → `Tahoma` → system-ui
**self-host (CSP เข้ม ไม่โหลดจาก Google Fonts):** `@font-face` ต้นไฟล์ `css/style.css` ชี้ `/fonts/Sarabun-{Regular,SemiBold,Bold}.ttf` (ไฟล์ต้องอยู่ `public/fonts/` พร้อมไฟล์ลิขสิทธิ์ OFL — เจ้าของไฟล์ฟอนต์คือ exporter/เปา ตาม SPEC v4) ถ้ายังไม่มีไฟล์จะใช้ Sarabun ที่ติดตั้งในเครื่อง หรือ Noto Sans Thai/Tahoma ตามลำดับ · index.html ใส่แค่ `<link rel="stylesheet" href="css/style.css">`
ขนาด: base 16px · h1 1.6rem · h2 1.3rem · ช่องตาราง .85rem · line-height 1.6

## 3. สี (คอนทราสต์ตัวอักษร/พื้น ผ่าน AA ≥ 4.5:1 ทุกคู่)
| ความหมาย | พื้น | ตัวอักษร | ขอบ | class |
|---|---|---|---|---|
| ว่าง | `#ffffff` | `#475569` | `#94a3b8` เส้นประ | `.is-free` |
| ลงแล้ว | `#dbeafe` | `#1e3a8a` | `#3b82f6` | `.is-filled` |
| ชน | `#fee2e2` | `#7f1d1d` | `#dc2626` หนา 2px | `.is-conflict` |
| พักเที่ยง | `#e2e8f0` + ลายเฉียง | `#334155` | `#94a3b8` | `.tt-lunch` |
| เรียนรวม | `#ede9fe` | `#4c1d95` | `#7c3aed` | `.is-shared` |
| เตือน (เกิน ชม./สัปดาห์) | `#fef3c7` | `#78350f` | `#d97706` | `.is-warning` |
| ลงไม่ได้ (disabled) | `#e5e7eb` | `#4b5563` | `#9ca3af` | `.is-disabled` |
| สำเร็จ | `#dcfce7` | `#14532d` | `#16a34a` | `.alert-success` |

ปุ่มหลัก `#1d4ed8` ตัวอักษรขาว (6.7:1) · อันตราย `#b91c1c` ตัวอักษรขาว · พื้นหน้า `#f4f6fa`

## 4. Layout
```
.app
 ├─ header.app-header   (.app-title, .app-subtitle)
 ├─ nav.nav             (a.nav-link[.is-active] ×9: จัดตาราง / รายวิชา / กลุ่มเรียน / ห้องเรียน / ครู / ตารางรายกลุ่มเรียน / ตารางรายครู / ตารางรายห้องเรียน / ข้อมูล)
 └─ main.main           (.page-header + เนื้อหาเป็น .card)
```
เนื้อหากว้างสุด 1400px กึ่งกลาง · padding 24px · เมนู 9 รายการรวมกันอาจขึ้นบรรทัดใหม่ (`.nav` เป็น flex-wrap)

**ศัพท์:** "กลุ่มเรียน" = กลุ่มนักเรียน (เช่น ปวช.1/1) · "ห้องเรียน" = สถานที่ (เช่น 411) · "ระดับ" = ปวช.1–3 / ปวส.1–2 ห้ามใช้คำ "ห้อง" เดี่ยว ๆ แทนกลุ่มเรียน

## 5. ลำดับหน้าจอ
1. **จัดตาราง** — `.toolbar` [เลือกกลุ่มเรียน `.select`] [`.btn-primary` บันทึก] → `.alert` สรุปชน/เตือน → `.legend` → `.tt-wrap > table.timetable`
   - คลิก `.tt-cell.is-free` → `.modal` เลือกวิชาจาก `.pick-list` (ลงได้ = `.pick-item`, เรียนรวมได้ = `.is-shared`, ลงไม่ได้ เช่น ระดับไม่ตรง = `.is-disabled` + `.pick-item-reason`) แล้วเลือก "ห้องเรียน (ไม่บังคับ)" ด้วย `.select` ใน `.field` เดียวกับ `.field-hint` อธิบาย ("แสดงเฉพาะห้องที่ว่างในคาบนี้")
   - คลิก `.tt-cell.is-filled` → modal ย้าย/ลบ/เปลี่ยนห้องเรียน/เปลี่ยนครู (ปุ่ม `.btn-danger`)
   - **ตัวกรอง "แสดงเฉพาะวิชาที่ลงได้" (SPEC v3)** บนสุดของ modal เลือกวิชา:
     `.filter-bar > .field > .chip-group > label.chip > input[type=checkbox]+span` (ค่าเริ่มต้นติ้ก จำค่าใน localStorage) · ใต้แถบมี `p.filter-note` "ซ่อน **N** วิชาที่ลงไม่ได้" (ตัวเลขใส่ `<strong>`) · ถ้าซ่อนจนไม่เหลือวิชา ใช้ `.empty-state` ข้อความ "ไม่มีวิชาที่ลงได้ในคาบนี้ — เอาติ้ก "แสดงเฉพาะวิชาที่ลงได้" ออกเพื่อดูเหตุผล" · ไม่ติ้ก = แสดงทุกวิชา ที่ลงไม่ได้เป็น `.is-disabled` + เหตุผล (เหมือนเดิม)
   - **เลือกครูผู้สอน** หลังเลือกวิชา: `.field` > `.select` "ครูผู้สอน" ตัวเลือกครูที่ชนเติมท้าย " — ชน: <เหตุผลสั้น>" และ `disabled` (เบราว์เซอร์แสดงเป็นเทา) · วิชามีครูคนเดียว เลือกอัตโนมัติ · ต้องการแสดงสถานะชัดกว่า select ให้ใช้ `.pick-list` โดยแต่ละครูเป็น `.pick-item` (`.is-disabled` + `.pick-item-reason` เมื่อชน) และ `.badge-teacher-busy` "ครูไม่ว่าง"
   - **สามสถานะของวิชาใน modal:** ลงได้ปกติ = `.pick-item` (ฟ้า/ม่วงถ้า `.is-shared`) · **ลงได้แต่ต้องเลือกครู** (วิชามีหลายครู, ยังไม่ชนแน่ชัดจนกว่าจะเลือก) = `.pick-item.needs-teacher` (เหลืองอ่อน) + `.pick-item-hint` บอกจำนวน/ชื่อครูที่ว่าง เช่น "ว่าง 2 จาก 3 คน" · **ลงไม่ได้** (ครูทุกคนชน/ระดับไม่ตรง/ชนอื่น) = `.is-disabled` เทา + `.pick-item-reason` ต้องไม่ใช้สีเหลืองกับสถานะเทา
   - ในช่องตารางแสดงชื่อครูที่มีผลของคาบนั้นใน `.tt-cell-sub` (ถ้าวิชามีหลายครูแต่ยังไม่เลือก ใส่ `.tt-cell-badge` "ยังไม่เลือกครู" ร่วมกับ `.is-warning`)
2. **รายวิชา / กลุ่มเรียน / ห้องเรียน / ครู** — `.page-header` (หัวข้อ + ปุ่มเพิ่ม) → `.table-wrap.card > table.data-table` (คอลัมน์สุดท้าย `.col-actions`) · ไม่มีข้อมูล `.empty-state` · เพิ่ม/แก้ไขใน `.modal` + `.form-grid`
   - รายวิชา: ช่อง "ระดับที่เปิดสอน" ใช้ `.chip-group` (ต้องเลือก ≥1 ไม่ผ่านใส่ `.is-invalid` ที่ fieldset + `.field-error`) ตารางแสดงระดับเป็น `.badge-list > .badge.badge-level`
   - ฟอร์มรายวิชา "ครูผู้สอน" เลือกได้ 0..n คน: `fieldset.chip-group` เหมือนระดับ · ตารางรายวิชาแสดงครูทุกคนเป็น `ul.teacher-list > li > .badge.badge-teacher` (ไม่มีครู = `.text-muted` "ยังไม่กำหนด")
   - กลุ่มเรียน: คอลัมน์ ชื่อ / ระดับ (`.badge-level`) / สาขา
   - ห้องเรียน: คอลัมน์ ชื่อ / อาคาร / ความจุ (`.col-num`) / หมายเหตุ / จำนวนคาบที่ใช้ (`.col-num`)
3. **ตารางรายกลุ่มเรียน / รายครู / รายห้องเรียน** — `.toolbar` เลือกกลุ่ม/ครู/ห้อง + `.view-meta` สรุป → `.timetable` ใช้ `.is-readonly` ทุกช่อง · ปุ่มพิมพ์ (A4 แนวนอน ซ่อน nav/toolbar/legend)
4. **ข้อมูล** — `.card` ×3: ส่งออก JSON, นำเข้า JSON (`input type=file` + `.alert-warning` เตือนเขียนทับ), ล้างข้อมูล (`.btn-danger` + modal ยืนยัน)

## 6. โครงสร้างตารางคาบ
**ผัง v2 (SPEC v2 ข้อ 5): แถว = วัน จ–ศ (5 แถว) · คอลัมน์ = คาบ** — ใช้ทุกมุมมองและตอนพิมพ์
```html
<div class="tt-wrap"><table class="timetable">
 <thead><tr>
  <th class="tt-day" scope="col">วัน / คาบ</th>
  <th scope="col"><span class="tt-period-no">คาบ 1</span><span class="tt-period-time">08:00-09:00</span></th> … คาบ 2–4
  <th class="tt-lunch-head" scope="col">พักเที่ยง<span class="tt-period-time">12:00-13:00</span></th>
  <th scope="col">…คาบ 5</th> … คาบ 11
 </tr></thead>
 <tbody>
  <tr><th scope="row">จันทร์</th> td×4 · <td class="tt-lunch" rowspan="5">พักเที่ยง</td> · td×7 </tr>
  <tr><th scope="row">อังคาร</th> td×4 · td×7 (ไม่ต้องใส่ช่องพักเที่ยงซ้ำเพราะ rowspan) </tr> …
 </tbody>
</table></div>
```
- รวม 12 คอลัมน์ข้อมูล (คาบ 1–4, พักเที่ยง, คาบ 5–11) + หัวแถววัน · ช่องพักเที่ยงคลิกไม่ได้ (`cursor: not-allowed`)
- ถ้าไม่ใช้ rowspan ให้ใส่ `<td class="tt-lunch">` ทุกแถวแทนได้ (สไตล์เดียวกัน)
- **ความกว้าง:** `table-layout: fixed` · คอลัมน์วัน 76px · พักเที่ยง 46px · คาบ ≈ 84px ขึ้นไป · `min-width: 1060px`
  - จอ ≥ ~1100px พอดีจอไม่ต้องเลื่อน · จอ 768–1100px `.tt-wrap` เลื่อนแนวนอนได้ และหัวแถววัน (`tbody th`) ติดซ้ายขณะเลื่อน
- **ความสูงช่อง** 88px · ตัวอักษรช่อง .8rem (≈12.8px) เพื่อให้ชื่อวิชา + ครู + ห้องเรียน ใส่ได้ 4 บรรทัด
- **พิมพ์:** `@page A4 landscape` ซ่อน nav/toolbar/legend/ปุ่ม ตารางขยายเต็มหน้า ไม่เลื่อน สีพื้นคงอยู่ (`print-color-adjust: exact`)
- โครงช่อง:
```html
<td class="tt-cell is-filled">
  <span class="tt-cell-title">ภาษาไทยพื้นฐาน</span>
  <span class="tt-cell-sub">ครูสมชาย</span>
  <span class="tt-cell-room">411</span>          <!-- ใส่เมื่อมี roomId แสดงเป็น "ห้อง 411" -->
  <span class="tt-cell-badge">เรียนรวม</span>   <!-- ใส่เฉพาะเรียนรวม ร่วมกับ .is-shared -->
</td>
```
- มุมมองรายครู/รายห้องเรียน ช่องแสดง `.tt-cell-sub` = กลุ่มเรียน (เช่น "ปวช.1/1")
- สถานะแบบ combine: `is-filled is-shared`, `is-filled is-warning`, `is-filled is-readonly`
  - **ชนกลุ่มเรียน/ครู/ห้องเรียน** = `is-conflict` + `.tt-cell-badge` ข้อความบอกชนิด ("ชนครู" / "ชนห้องเรียน" / "ชนกลุ่มเรียน")
  - **ระดับไม่ตรง** = `is-level-mismatch` (พื้นแดงอ่อน ขอบเส้นประหนา) + badge "ระดับไม่ตรง"

## 7. รายชื่อ class
**Layout:** `.app` `.app-header` `.app-title` `.app-subtitle` `.nav` `.nav-link` `.is-active` `.main` `.page-header` `.card` `.toolbar` `.toolbar-spacer` `.stack` `.row` `.text-muted` `.text-right` `.text-center`
**ปุ่ม:** `.btn` `.btn-primary` `.btn-danger` `.btn-sm` (+ `disabled` หรือ `.is-disabled`)
**ฟอร์ม:** `.field` `.field-label` (`.required`) `.field-hint` `.field-error` `.input` `.select` `.textarea` `.is-invalid` `.form-grid` (`.span-2`) `.form-actions`
**ตารางข้อมูล:** `.table-wrap` `.data-table` `.col-actions` `.empty-state`
**ตารางคาบ:** `.tt-wrap` `.timetable` `.tt-day` `.tt-period-no` `.tt-period-time` `.tt-cell` `.tt-cell-title` `.tt-cell-sub` `.tt-cell-room` `.tt-cell-badge` `.tt-lunch` `.tt-lunch-head` · สถานะ `.is-free` `.is-filled` `.is-conflict` `.is-level-mismatch` `.is-shared` `.is-warning` `.is-readonly`
**ระดับ/ห้องเรียน:** `.badge-level` `.badge-room` `.badge-group` `.badge-list` `.badge-teacher` `.badge-teacher-busy` `.teacher-list` · `.filter-bar` `.filter-note` `.pick-item-teacher` `.pick-item.needs-teacher` `.pick-item-hint` · `.chip-group` > `label.chip` > `input[type=checkbox]` + `span` · `.view-meta` (สรุปใต้ตัวเลือกในหน้ารายกลุ่ม/รายครู/รายห้องเรียน) `.col-num`
```html
<fieldset class="chip-group" aria-label="ระดับที่เปิดสอน">
  <label class="chip"><input type="checkbox" name="levels" value="ปวช.1"><span>ปวช.1</span></label> …
</fieldset>
```
**Legend/แจ้งเตือน:** `.legend` `.legend-item` `.legend-swatch` (+ `.is-free` `.is-filled` `.is-conflict` `.is-lunch` `.is-shared` `.is-warning` `.is-level-mismatch`) · `.badge` `.badge-general` `.badge-vocational` `.badge-shared` `.badge-conflict` · `.alert` `.alert-info` `.alert-success` `.alert-warning` `.alert-error`
**Modal:** `.modal-backdrop` `.modal` (`.modal-lg`) `.modal-header` `.modal-title` `.modal-close` `.modal-body` `.modal-footer` · รายการเลือก `.pick-list` `.pick-item` (`.is-shared` `.is-disabled`) `.pick-item-title` `.pick-item-sub` `.pick-item-reason`
**Toast:** `.toast-area` > `.toast` (`.toast-success` `.toast-error`)
**Utility:** attribute `hidden` ซ่อนองค์ประกอบ

## 7.1 ข้อความตรวจฟอร์ม (ให้ตรงกับที่ store.js ปฏิเสธตอนนำเข้า)
รูปแบบ: ฟอร์ม = กรอกให้ครบ/ถูก (ชี้ที่ช่อง), นำเข้า = บอกตำแหน่งในไฟล์ เนื้อหากฎเดียวกัน
| กฎ | ข้อความในฟอร์ม | แสดงที่ |
|---|---|---|
| รหัสวิชาไม่ว่าง (trim แล้ว) | กรุณากรอกรหัสวิชา | `.field-error` ใต้ช่อง + `.is-invalid` |
| ชื่อวิชา/กลุ่มเรียน/ห้องเรียน/ครูไม่ว่าง | กรุณากรอกชื่อ… | เหมือนกัน |
| ชื่อห้องเรียนไม่ซ้ำ | ห้องเรียน X ซ้ำกับที่มีอยู่แล้ว | เหมือนกัน |
| ระดับที่เปิดสอนเลือก ≥ 1 | กรุณาเลือกระดับที่เปิดสอนอย่างน้อย 1 ระดับ | `.field-error` ใต้ `.chip-group` |
| รหัสวิชาไม่ซ้ำ | รหัสวิชา X ซ้ำกับวิชาที่มีอยู่แล้ว | เหมือนกัน |
| ชม./สัปดาห์ (ท+ป) เป็นจำนวนเต็มบวก | ชม./สัปดาห์ (ท+ป) ต้องเป็นจำนวนเต็มบวก | ใต้ช่อง ท/ป + `.alert-error` |
| หน่วยกิตไม่ติดลบ | หน่วยกิตต้องไม่ติดลบ | ใต้ช่อง |
- แสดงทุกข้อผิดพลาดพร้อมกันใน `.alert.alert-error > ul` ด้านบนฟอร์ม และขีดสีแดงช่องที่ผิด ไม่แสดงทีละข้อ
- ช่องข้อความ trim ก่อนตรวจเสมอ (ช่องที่มีแต่ช่องว่าง = ว่าง)

## 8. หมายเหตุสำหรับฟ้า
- ใส่ข้อความเหตุผลที่ชน (จาก scheduler `conflicts[].message`) ลง `.pick-item-reason` และ `.alert-error ul`
- badge ประเภทวิชา: general → `.badge-general` "สามัญ", vocational → `.badge-vocational` "ชีพ"
- modal: ใส่ `role="dialog" aria-modal="true"` และปิดด้วย Esc
- ถ้าต้องการ class เพิ่ม แจ้งมิ้นท์ จะเพิ่มใน style.css และอัปเดตไฟล์นี้

## 9. SPEC v4 (T32): แผงรายวิชา · login · ลิงก์แชร์ · นำเข้า · ส่งออก · โหมดดูอย่างเดียว
คอนทราสต์ใช้คู่สีในตารางข้อ 3 ซ้ำ

### 9.1 แผงรายวิชาในหน้าจัดตาราง
```html
<div class="schedule-layout">
  <aside class="subject-panel" id="subject-panel" aria-label="รายวิชาของกลุ่มเรียน">   <!-- <1100px เพิ่ม .is-open ตอนเปิดลิ้นชัก -->
    <div class="subject-panel-header"><h2 class="subject-panel-title">วิชาที่ต้องเรียน</h2><button class="btn btn-sm">ปิด</button></div>
    <div class="subject-panel-summary">เหลือ 3 วิชา · เสร็จ 4 วิชา</div>
    <ul class="subject-list">
      <li><button type="button" class="subject-item is-remaining is-active" aria-pressed="true">
        <span class="subject-item-title">20000-1101 ภาษาไทย</span>
        <span class="subject-item-sub">สามัญ · ครูสมชาย, ครูสมหญิง</span>
        <span class="subject-item-hours"><span>ต้อง 3 · จัดแล้ว 1</span><span class="status-chip status-remaining">เหลือ 2 ชม.</span></span>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="3" aria-valuenow="1"><div class="progress-bar" style="width:33%"></div></div>
      </button></li>
    </ul>
  </aside>
  <div class="schedule-main">
    <button class="btn panel-toggle" aria-controls="subject-panel">รายวิชา</button>   <!-- แสดงเฉพาะ <1100px -->
    <div class="placing-bar"><span>กำลังลง: <strong>ภาษาไทย</strong> เหลือ 2 ชม.</span><button class="btn btn-sm">ยกเลิก</button></div>
    … toolbar / legend / .tt-wrap
  </div>
</div>
<div class="panel-backdrop"></div>   <!-- เพิ่ม .is-open พร้อมลิ้นชัก คลิกแล้วปิด -->
```
- ≥1100px แผงอยู่ซ้ายกว้าง 290px (sticky) · <1100px เป็นลิ้นชักซ้าย + ฉากหลังมืด · ที่ ~1100–1500px ตารางจะเลื่อนแนวนอนในกรอบ `.tt-wrap` เพราะแผงกินพื้นที่
- **สถานะไม่พึ่งสี:** เหลือ = ขอบซ้ายเหลือง + ป้าย "◔ เหลือ N ชม." (`.is-remaining` + `.status-remaining`) · เสร็จ = ขอบเขียว พื้นจาง + "✓ เสร็จ" (`.is-done` + `.status-done`) · เกิน = พื้นแดงอ่อน + "⚠ เกิน N ชม." (`.is-over` + `.status-over`) · กำลังลง = ขอบน้ำเงินหนา + "▶" หน้าชื่อ + `aria-pressed` (`.is-active`) · ไอคอนเติมโดย CSS ไม่ต้องใส่ในข้อความ
- เรียงโดยฟ้า: เหลือ>0 ก่อน ครบไว้ท้าย (SPEC v4 ข้อ 9) · กลุ่มไม่มีวิชา: `.subject-panel-empty` "ยังไม่ได้ผูกวิชา — เลือกแผนการเรียน" + `.btn.btn-primary` ไปเลือกแผน

### 9.2 แถบสถานะ / โหมดดูอย่างเดียว (วางใน header ต่อจาก #status)
`.conn-status` + `.conn-saved` "บันทึกแล้ว" · `.conn-saving` "กำลังบันทึก…" · `.conn-conflict` "มีผู้แก้ไขพร้อมกัน" · `.conn-offline` "ออฟไลน์"
`.badge-admin` "แอดมิน: ชื่อ" · `.badge-readonly` "โหมดดูอย่างเดียว" (ขอบประ) · หน้าดูอย่างเดียวใส่ `.alert.alert-info.viewer-banner` อธิบายขอบเขตลิงก์
**ข้อมูลเดิมเกินชั่วโมง:** `<div class="legacy-bar" role="alert">มี N รายการเกินชั่วโมง ต้องแก้ก่อนบันทึก <button class="btn btn-sm">ดูรายการ</button></div>` วางบนสุดของ `.app` (sticky, แดง)

### 9.3 เข้าสู่ระบบแอดมิน
`.login-wrap > .login-card` : `h1` + `.field`×2 (`.input` ชื่อผู้ใช้/รหัสผ่าน) + `.field-error` (ข้อความคงที่ เช่น "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง") + `.btn.btn-primary` เข้าสู่ระบบ · 429 ใช้ `.alert.alert-warning` บอกให้ลองใหม่ภายหลัง

### 9.4 ลิงก์แชร์ (หน้าแอดมิน)
`.page-header` + ปุ่มสร้าง → `.table-wrap.card > table.data-table` คอลัมน์: ป้ายชื่อ / ขอบเขต `.badge.badge-scope` / สถานะ `.badge-status-active|revoked|expired` / สร้างเมื่อ / หมดอายุ / `.col-actions` (คัดลอก · สร้างใหม่ · เพิกถอน `.btn-danger`) · แถวที่เพิกถอน `tr.is-revoked`
หลังสร้าง/สร้างใหม่: modal แสดงลิงก์เต็มครั้งเดียว `.alert.alert-warning` "คัดลอกตอนนี้ — ระบบจะไม่แสดงอีก" + `.share-link > code.share-url + .btn.btn-sm` คัดลอก

### 9.5 รายงานนำเข้า Excel
`.dropzone` (`.is-over` ขณะลากไฟล์) → `.report-summary` ของ `.report-stat` (`.is-error` / `.is-warning` / `.is-info` + `.report-stat-num`) → ตัวกรองระดับด้วย `.chip-group` → `.report-scroll > table.data-table.report-table` คอลัมน์ ชีต / แถว / คอลัมน์ / ระดับ `<span class="level-badge level-error">ผิดพลาด</span>` (`level-warning` "เตือน", `level-info` "ข้อมูล") / ข้อความ · แถว `tr.row-error|row-warning|row-info`
ปุ่ม: ดาวน์โหลดรายงาน `.btn` · ยืนยันนำเข้า `.btn-primary` (`disabled` เมื่อมี error) · "นำเข้าและตัดคาบส่วนเกินออก" `.btn` แยกชัด

### 9.6 กล่องส่งออก/พิมพ์
`.export-box` : `.export-grid` (ประเภท `.select`, รูปแบบ xlsx/pdf `.chip-group`, ภาคเรียน/ปีการศึกษา `.input`) + `.export-list` (checkbox ทีละรายการ) + `.export-actions` (`.btn-primary` ส่งออก, `.btn` พิมพ์) · print CSS ซ่อนกล่องนี้ ตารางยัง A4 แนวนอน

### 9.7 class ใหม่ทั้งหมด (T32)
`.schedule-layout` `.schedule-main` `.subject-panel` (`.is-open`) `.subject-panel-header` `.subject-panel-title` `.subject-panel-summary` `.subject-panel-empty` `.panel-toggle` `.panel-backdrop` (`.is-open`) `.subject-list` `.subject-item` (`.is-active` `.is-remaining` `.is-done` `.is-over`) `.subject-item-title` `.subject-item-sub` `.subject-item-hours` `.status-chip` (`.status-remaining` `.status-done` `.status-over`) `.progress` `.progress-bar` `.placing-bar` · `.conn-status` (`.conn-saved` `.conn-saving` `.conn-conflict` `.conn-offline`) `.legacy-bar` `.badge-readonly` `.badge-admin` `.viewer-banner` · `.login-wrap` `.login-card` · `.share-link` `.share-url` `.badge-scope` `.badge-status-active|revoked|expired` `tr.is-revoked` `.token-reveal` · `.report-summary` `.report-stat` `.report-stat-num` `.report-table` `tr.row-error|row-warning|row-info` `.level-badge` (`.level-error|warning|info`) `.report-scroll` `.dropzone` (`.is-over`) · `.export-box` `.export-grid` `.export-list` `.export-actions`

## 10. SPEC v5 (T43): เลือกหลายช่อง · list-kit · สาธารณะ · ตั้งค่า · สัญลักษณ์ขาวดำ · พิมพ์ A4

### 10.1 ระบบสัญลักษณ์/ลาย (จอ = พิมพ์เบราว์เซอร์ = PDF ของอิงค์ ต้องตรงกัน)
ชนิดช่องกำหนดด้วย class บน `td.tt-cell` (`type-general` | `type-vocational`) + สัญลักษณ์ `<span class="tt-mark tt-mark-…">` หน้าชื่อวิชาใน `.tt-cell-title`
ใช้ **ตัวอักษรไทยที่มีใน Sarabun แน่นอน** (ส/ช/ร) + รูปทรงที่วาดจากเส้น/สีพื้น (วงกลม, วงกลมทึบ, กรอบคู่) ไม่ใช้ ○ ● ⧉ เพราะฟอนต์/PDF อาจไม่มีกลิฟ

| ชนิด | class (td) | สัญลักษณ์ | จอ | ขาวดำ/พิมพ์ (ตัวอักษรดำล้วน) |
|---|---|---|---|---|
| วิชาสามัญ | `type-general` (+`is-filled`) | `tt-mark-general` **ส** ในวงกลมโปร่ง | พื้น `#dbeafe` ตัว `#1e3a8a` ขอบ `#3b82f6` ตัวปกติ | พื้นเทาอ่อน `#ececec` ขอบดำ 1px |
| วิชาชีพเฉพาะ | `type-vocational` | `tt-mark-vocational` **ช** ตัวขาวในวงกลมทึบดำ | พื้น `#86efac` + ลายทแยง 135° ตัว `#052e16` ตัวหนา (600) | พื้นเทากลาง `#b8b8b8` + ลายทแยงดำ + ตัวหนา |
| เรียนรวม | `is-shared` (+type-general) | `tt-mark-shared` **ร** ในกรอบสี่เหลี่ยมขอบคู่ + ป้าย "เรียนรวม" | พื้น `#ede9fe` ขอบม่วง คู่ 4px | พื้นเทาอ่อน ขอบคู่ดำ 4px |
| พักเที่ยง | `td.tt-lunch` (rowspan) + `<span class="tt-lunch-text">พักเที่ยง</span>` | — | เทา + ลายทแยงถี่ + ข้อความแนวตั้ง | เทา `#d0d0d0` + ลายทแยงดำถี่ + ข้อความแนวตั้ง |
| ว่าง | `is-free` | — | ขาว เส้นประ | ขาว |
| ชน/เตือน/ระดับไม่ตรง | `is-conflict` / `is-warning` / `is-level-mismatch` | ป้ายข้อความ | สีเดิม (ข้อ 3) ทับสีชนิดวิชา | พื้นขาว ขอบดำ 2px + ป้ายข้อความ |
- **ใช้ร่วมกัน:** เรียนรวมให้ใส่ทั้ง `type-general is-shared` และ mark `ส` + `ร` ได้ (ส่วนมากใช้ `ร` ตัวเดียวตามพื้นที่) — ข้อตกลง: ช่องเรียนรวมใส่ mark `ร` อย่างเดียว
- ความต่างระดับเทา (Rec.601) ประมาณ: ว่าง 255 > สามัญ ~232 > ชีพ ~200 > พักเที่ยง/พิมพ์ชีพ ~184 ใช้ร่วมกับลาย+ตัวหนา+สัญลักษณ์ ไม่พึ่งความสว่างอย่างเดียว
- **อิงค์ (PDF):** วาดแบบเดียวกัน — วงกลมโปร่ง/ทึบ/สี่เหลี่ยมขอบคู่ที่หัวชื่อวิชา, ลายทแยง 135° ทึบกลาง/ถี่ 45° พักเที่ยง, ตัวหนาเฉพาะชีพ, legend ใต้ตารางอธิบาย ส/ช/ร/พักเที่ยง
- legend บนจอ: `.legend-swatch.type-general` `.type-vocational` `.is-shared` `.is-lunch` `.is-free` (+ mark ในข้อความ legend)

### 10.2 ข้อความในช่องไม่ล้น
- `table-layout: fixed` + `overflow-wrap: anywhere` (ตั้งแล้ว) · `<html lang="th">` ให้เบราว์เซอร์ตัดคำไทย
- ฟ้าใส่ class ขนาดที่ `td.tt-cell`: `tt-fs-1` (.8rem, ชื่อวิชาสูงสุด 3 บรรทัด) · `tt-fs-2` (.72rem, 4) · `tt-fs-3` (.68rem, 5) · `tt-fs-4` (.64rem, 6 — ขั้นต่ำบนจอ ≈10px) · บรรทัดครู/ห้อง/กลุ่ม (`.tt-cell-sub` `.tt-cell-room`) ตัดที่ 1 บรรทัด `…` · ส่วนเกินตัดด้วย `-webkit-line-clamp` + ใส่ `title="ชื่อเต็ม"` บนจอ
- พิมพ์: tt-fs-1..4 = 10.5 / 9.5 / 8.5 / 8px; ถ้ามีข้อความถูกตัด ให้แสดง `<ul class="tt-fulltext">` (รหัส → ชื่อเต็ม) ใต้ตารางในหน้าพิมพ์ (3 คอลัมน์)
- กติกาเลือกระดับ (ข้อเสนอ ฟ้าปรับได้): ตัวอักษรของ title ≤ 14 → 1 · ≤ 28 → 2 · ≤ 48 → 3 · เกิน → 4

### 10.3 โหมดเลือกหลายช่อง
```html
<div class="multi-bar is-on">                       <!-- is-on = เปิดโหมดลง; is-remove = โหมดลบ -->
  <label class="switch"><input type="checkbox" role="switch" checked><span class="switch-track"></span><span class="switch-label">โหมดเลือกหลายช่อง</span></label>
  <span class="multi-mode-label">ลงวิชา: ภาษาไทย</span>
  <span class="multi-count" role="status">เลือก 6 ช่อง</span>
  <div class="multi-actions"><button class="btn btn-primary">ลงตาราง (6 ช่อง)</button><button class="btn">ล้างการเลือก</button><button class="btn">ยกเลิกโหมด</button></div>
</div>
<div class="tt-wrap is-multi">   <!-- ขณะลาก เพิ่ม .is-selecting (กัน scroll/เลือกข้อความ) · โหมดลบเพิ่ม .is-remove -->
  <td class="tt-cell is-free is-selected"> … </td>
```
- **เลือกแล้ว** = `.is-selected`: กรอบน้ำเงินทึบ 3px + พื้นฟ้าโปร่ง + วงกลม ✓ มุมขวาบน · **โหมดลบ** ใช้กรอบแดงประ + ✕ · **ระหว่างลาก** `.is-range-preview` = กรอบประน้ำเงิน ไม่มีไอคอน (ต่างจากเลือกแล้ว: ทึบ+✓) · ช่องเริ่ม/ล่าสุด `.is-anchor` กรอบหนา 5px · ช่องข้าม (พักเที่ยง/มีวิชาแล้ว) `.is-skipped` จางลง + cursor not-allowed
- ปุ่มในแถบสูง 44px (ทัช); `@media (pointer: coarse)` ขยาย `.btn-sm` เป็น ≥40px ทั้งระบบ · ปุ่มสลับ "เพิ่ม/ลบ ช่วงเลือก" แทน Shift ใช้ `.chip-group` 2 ตัวเลือก

### 10.4 กล่องผลรายช่อง (dry run)
`.modal` : `.result-summary` ("ลงได้ 4 จาก 6 ช่อง") + `.table-wrap > table.data-table.result-table` แถวละช่อง: วัน / คาบ / สถานะ `<span class="result-ok">ลงได้</span>` หรือ `<span class="result-fail">ลงไม่ได้</span>` + `<span class="result-reason">ชนครู…</span>` · แถว `tr.row-ok` / `tr.row-fail` · ปุ่ม `.btn-primary` "ลงเฉพาะช่องที่ลงได้ (K จาก N)" + `.btn` "ยกเลิกทั้งชุด" (✓/✗ เติมโดย CSS)

**ป้ายเหตุผลต่อ type** (ข้อความเต็มอยู่ในแถวเสมอ ไม่ใช้ tooltip): `<span class="reason-chip reason-teacher">ชนครู</span><span class="result-reason">ครูสมชายสอนกลุ่ม … วันจันทร์ คาบ 3</span>`

| type (รหัสจากโดม ฟ้าแมปเอง) | class | ข้อความป้าย | เส้นขอบ |
|---|---|---|---|
| ลงได้ | `reason-ok` | ลงได้ | ทึบ (เขียว) |
| ชนครู | `reason-teacher` | ชนครู | ทึบ (แดง) |
| ชนห้อง | `reason-room` | ชนห้องเรียน | ทึบ (แดง) |
| ชั่วโมงเต็ม | `reason-hours` | ชั่วโมงเต็ม | ประ (เหลือง) |
| ระดับไม่ตรง | `reason-level` | ระดับไม่ตรง | ประ (เหลือง) |
| พักเที่ยง | `reason-lunch` | พักเที่ยง | จุด (เทา) |
| ช่องซ้ำ | `reason-dup` | ช่องซ้ำ | จุด (เทา) |
| id ผิด/อื่น ๆ | `reason-invalid` | ข้อมูลไม่ถูกต้อง | จุด (เทา) |
**แมปรหัสจากโดม (ตกลงแล้ว):** `teacher`→`reason-teacher` ชนครู · `classroom`→`reason-room` ชนห้องเรียน · `group`→`reason-group` **ชนกลุ่มเรียน** (กลุ่มมีวิชาในช่องนี้แล้ว; ขอบทึบแดงเหมือนชนครู) · `hours`→`reason-hours` · `level`→`reason-level` · `lunch`→`reason-lunch` · `duplicate_slot`/`duplicate`→`reason-dup` ช่องซ้ำ · `invalid`/`invalid_id`→`reason-invalid` ข้อมูลไม่ถูกต้อง · ลงได้→`reason-ok` · ข้อความป้ายต้องบอกชนิดเสมอ

### 10.5 สวิตช์ (โหมดหลายช่อง + หน้าตั้งค่า)
`label.switch > input[type=checkbox][role=switch] + span.switch-track + span.switch-label` · อ่านสถานะได้จากข้อความ "เปิด/ปิด" ในราง + ตำแหน่งปุ่มกลม (ไม่พึ่งสี) · สูง ≥44px

### 10.6 list-kit
```html
<div class="list-kit-bar">
  <div class="search-box"><input class="input" type="search" aria-label="ค้นหา"><button class="search-clear" aria-label="ล้างคำค้น">×</button></div>
  <div class="list-filters"><div class="field"><label class="field-label">ระดับ</label><select class="select">…</select></div> …</div>
  <span class="list-count" role="status">แสดง 1–25 จาก 312</span>
</div>
… ตาราง/รายการ …
<div class="pager"><span class="pager-info">หน้า 1 / 13</span>
  <div class="pager-btns"><button class="btn">ก่อนหน้า</button><button class="btn" aria-current="page">1</button><button class="btn">2</button>…<button class="btn">ถัดไป</button></div>
  <label class="page-size">ต่อหน้า <select class="select"><option>25</option><option>50</option><option>100</option></select></label></div>
```
ไม่พบรายการ: `.list-empty` · ปุ่ม/ช่องสูง 44px

### 10.7 หน้าสาธารณะ
`.public-page` : `.public-intro` → `.public-bar` (`.chip-group` เลือกประเภท กลุ่มเรียน/ครู/ห้องเรียน เป็น radio + list-kit เลือกรายการ + ปุ่มพิมพ์/ส่งออก) → `.public-title` (`h2` + `.badge-readonly`) → `.view-meta` → `.tt-wrap` อ่านอย่างเดียว (`is-readonly`) → `.public-footer` (ลิงก์ `a.link-muted` "เข้าสู่ระบบแอดมิน") · ปิดสาธารณะ: `.public-disabled.empty-state` + `.btn-primary` เข้าสู่ระบบ + ข้อความเรื่องลิงก์แชร์

### 10.7.1 ถ้อยคำเรื่องความเป็นส่วนตัว/ความปลอดภัย (กฎ: บอกสิ่งที่ถูกซ่อนจริง + ข้อจำกัด ห้ามสัญญาเกินที่โค้ดทำ)
- **ห้ามใช้คำ** "ปลอดภัย", "ป้องกันแล้ว", "ไม่รั่ว", "ไม่มีข้อมูลส่วนบุคคล" ในป้าย/ข้อความใด ๆ
- **ป้ายซ่อนครู** (`.badge-hidden-teachers`): "ไม่แสดงรายชื่อครู" (ไม่ใช่ "ไม่แสดงชื่อครู") + คำอธิบายสั้นที่มองเห็นได้ ไม่ซ่อนใน tooltip อย่างเดียว: "ชื่อครูที่พิมพ์อยู่ในชื่อวิชา ห้อง หรือกลุ่มอาจยังเห็นได้" (ข้อเท็จจริง: ระบบตัดรายชื่อ/รหัส/แผนกครู และหมายเหตุของวิชา-ห้อง-กลุ่ม แต่ไม่ตัดชื่อครูที่ผู้ใช้พิมพ์ในชื่อ)
- class: `.hidden-teachers-note` (บรรทัดอธิบายใต้ป้าย มองเห็นเสมอ) · `.show-names-warning` (กล่อง `.alert-warning` ตอนเปิดสวิตช์แสดงชื่อครู + ปุ่มยืนยัน)
- **หน้าตั้งค่า ยังไม่ยืนยัน** (`.unconfirmed-banner`): "ตอนนี้ระบบซ่อนรายชื่อครูไว้ก่อน (ค่าเริ่มต้น) — เลือกแสดงเมื่อพร้อม"
- **ตอนเลือกแสดงชื่อครู:** ต้องมีคำเตือน (`.alert-warning`) + ให้กดยืนยันก่อนบันทึก: "ชื่อครูและตารางสอนจะเป็นสาธารณะ ใครก็เปิดดูได้โดยไม่ต้องมีลิงก์ และไม่มีวันหมดอายุ (เป็นข้อมูลส่วนบุคคล)"
- **หน้าลิงก์แชร์:** ป้าย scope "ทั้งหมด" ต้องบอกว่า "เห็นชื่อครูทั้งหมด ไม่ขึ้นกับการตั้งค่าซ่อนในโหมดสาธารณะ" (คนละกลไก)
- **ป้าย "โหมดดูอย่างเดียว"** บอกแค่ว่าแก้ไม่ได้ ไม่สื่อว่าข้อมูลปลอดภัย
- **ข้อความ error:** login คงที่ "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" · 429 "ลองบ่อยเกินไป โปรดรอสักครู่" (ไม่ใส่จำนวนครั้ง/เวลาเหลือ) · 500/503 ทั่วไป "ระบบขัดข้อง โปรดติดต่อผู้ดูแล" (ไม่ระบุ env/ชื่อบัญชี/Redis/Upstash)
- **ข้อความ 422 ที่มีชื่อวิชา-ครู (ชั่วโมงเกิน/ชนครู)** ใช้เฉพาะหน้าแอดมิน ห้ามนำไปแสดงบนหน้าสาธารณะ/หน้าลิงก์แชร์
- **ส่งออก/พิมพ์:** ชื่อไฟล์และหัวเอกสารไม่มีชื่อครูเมื่อซ่อน · คำอธิบายใช้ "ซ่อนรายชื่อครู"

### 10.8 หน้าตั้งค่า
`.settings-list > .setting-row(.is-on)` : `.setting-text` (`.setting-title`, `.setting-desc`, `.alert.alert-warning.pdpa-note` คำเตือน PDPA/ช่องหมายเหตุ, `.setting-meta` แก้ไขล่าสุดโดย…) + `label.switch` ทางขวา · แถวที่เปิดมีแถบน้ำเงินซ้าย + สวิตช์แสดง "เปิด"

### 10.9 พิมพ์ A4 (ท้าย style.css)
`@page { size: A4 landscape; margin: 8mm }` · 1 `.print-sheet` = 1 หน้า (สูง 188mm ตารางยืดเต็มหน้า flex) `break-after: page` · ซ่อน nav/toolbar/panel/list-kit/multi-bar/public-bar · สีเป็นเทาล้วนตามข้อ 10.1 · `print-color-adjust: exact`
ข้อจำกัด: `.main:has(...)` ใช้ซ่อนส่วนอื่น (เบราว์เซอร์เก่าไม่รองรับ) · ความสูง `.print-sheet` 188mm ตั้งให้พอดีพื้นที่ใช้งาน A4 แนวนอนหลังหักขอบ 8mm

### 10.9.1 ชื่อ class ที่ตกลงกับฟ้า (ชนะข้อความข้างบนเมื่อขัดกัน)
- ขนาดฟอนต์ในช่อง = **`tt-fit-1..4`** (ฟ้าคำนวณ; `tt-fs-N` ใน 10.2 เป็นชื่อสำรองเทียบเท่า) · 3 ขึ้นไปมี `title` เต็ม
- โหมดหลายช่อง: `td.tt-cell.is-selected` (✓) · `.multi-bar` · `.multi-result` (กล่องห่อผลรายช่อง ใช้ร่วมกับ `.result-*` ได้) · `.btn.multi-toggle` (`aria-pressed="true"` = เปิด: พื้นน้ำเงิน + ✓ นำหน้า)
- V5-01 หน้าตั้งค่า: ค่า `hideTeacherNames` ยังเป็น null → `.alert.alert-warning.unconfirmed-banner` "ยังไม่ได้ยืนยันการตั้งค่า — ระบบซ่อนชื่อครูไว้ก่อน" + `.badge.badge-unconfirmed`; ยืนยันว่าซ่อน = `.badge-hidden-teachers` (ไอคอนกุญแจเติมโดย CSS) · มุมมองสาธารณะที่ซ่อนครูควรบอกผู้ชมด้วย `.badge-hidden-teachers` "ซ่อนชื่อครู"

- ที่ฟ้าเพิ่มเอง (รับรองแล้ว): `.pager-gap` (ตัว … คั่นเลขหน้า) · `.list-kit-body` (ห่อเนื้อหารายการ) · `#multi-box` `#grid-box` wrapper ไม่ต้องมีสไตล์ · `.setting-meta` ใช้คู่ `.text-muted` ได้

### 10.9.2 ช่องที่ลงวิชาที่เลือกไม่ได้ (ไฮไลต์แดง) — T66
เมื่อเลือกกลุ่ม+วิชาจากแผง ช่องว่างที่ลงไม่ได้ใส่ `tt-blocked` (คำนวณโดยฟ้าจาก scheduler.js ตัวเดียว) พร้อมสัญลักษณ์และเหตุผลสั้น
```html
<td class="tt-cell is-free tt-blocked tt-fit-2" tabindex="0" aria-label="ลงไม่ได้: ชนครู" title="ครูสมชายมีสอนกลุ่ม ปวช.1/2 คาบนี้">
  <span class="tt-blocked-mark" aria-hidden="true"></span><span class="tt-blocked-why">ชนครู</span>
</td>
```
- **แยกจากสถานะเดิมโดยไม่พึ่งสี:** `is-conflict` = ขอบทึบ 2px + ป้ายข้อความ (ข้อมูลที่ลงแล้วและชน) · `is-level-mismatch` = ขอบเส้นประ · **`tt-blocked` = ขอบจุด 2px + ลายตาข่ายทแยงสองทิศ + วงกลมขีดฆ่า (⊘ วาดด้วย CSS ไม่พึ่งกลิฟ) + ตัวหนา** · ชนิดวิชาใช้ลายทแยงทางเดียว (ชีพ 135°) พื้นเทา ส/ช/ร ไม่ซ้ำกัน
- สี: พื้น `#fee2e2` ตัว `#7f1d1d` ขอบ `#dc2626`; ข้อความเหตุผลอยู่บนแถบขาวกึ่งทึบ (`.tt-blocked-why`) จึงอ่านผ่าน AA ทับลาย (ตัว `#7f1d1d` บนขาว ≈ 10:1) · เหตุผลตัดที่ 2 บรรทัด `…` · ใช้ร่วมกับ `tt-fit-1..4` ได้ (สัญลักษณ์และตัวอักษรย่อตาม em)
- hover คงโทนแดง (ไม่เปลี่ยนเป็นฟ้าแบบช่องว่างปกติ) cursor `help` เพราะคลิกแล้วแสดงเหตุผลเต็ม · focus ใช้ขอบส้มเดิม · `is-selected` ซ้อนได้ (กรอบน้ำเงิน+✓) ในโหมดเลือกหลายช่อง
- พิมพ์/ขาวดำ: พื้นขาว + ตาข่ายทแยงดำ + ขอบจุดดำ + ตัวดำ (ต่างจากชีพ/พักเที่ยงที่เป็นเทา+ลายทางเดียว) · legend: `.legend-swatch.tt-blocked` "ลงไม่ได้ (ไฮไลต์แดง)"
- **ชื่อคลาสที่ฟ้าใช้จริง (รองรับคู่กับชื่อข้างบน ใช้ชุดใดชุดหนึ่งได้):** `td.tt-cell.is-free.is-blocked` > `.tt-cell-blocked` (`.tt-block-icon` ⊘ + `.tt-block-text`) + `.tt-cell-sub.tt-block-reason` · `title="ลงไม่ได้: เหตุผล"` · legend `.legend-swatch.is-blocked` · ช่องที่มีวิชาแล้วไม่ใส่ · ⊘ เป็นกลิฟตัวอักษร (ฟอนต์ระบบส่วนใหญ่มี) ใส่ `aria-hidden` และมี `.tt-block-text` "ลงไม่ได้" กำกับเสมอ จึงยังสื่อได้ถ้ากลิฟไม่แสดง
- ข้อเสนอเหตุผลสั้น (ฟ้าแมปจาก type): ชนครู · ชนห้อง · ชนกลุ่ม · ชั่วโมงเต็ม · ระดับไม่ตรง · พักเที่ยง

### 10.9.3 หน้าตั้งค่า: จัดการระดับ — T66
```html
<section class="level-manager">
  <p class="level-count">ทั้งหมด 5 ระดับ (สูงสุด 30)</p>
  <ul class="level-list">
    <li class="level-row">
      <span class="level-index">1</span><span class="level-name">ปวช.1</span>
      <span class="level-usage is-used">ใช้อยู่ 3 วิชา · 2 กลุ่ม · 1 แผน</span>
      <span class="level-actions"><button class="btn btn-sm btn-icon" aria-label="เลื่อนขึ้น">↑</button><button class="btn btn-sm btn-icon" aria-label="เลื่อนลง">↓</button><button class="btn btn-sm">แก้ชื่อ</button><button class="btn btn-sm btn-danger" disabled>ลบ</button></span>
      <p class="level-lock-note">ยังมีวิชา/กลุ่ม/แผนใช้ระดับนี้อยู่ (6 รายการ)</p>   <!-- ใส่คู่กับ li.is-locked -->
    </li>
    <li class="level-row is-editing"> … <input class="input"> ปุ่ม บันทึก/ยกเลิก … <p class="level-error-note">ชื่อระดับซ้ำกับที่มีอยู่</p></li>
  </ul>
  <form class="level-add"><div class="field"><label class="field-label">เพิ่มระดับ</label><input class="input" maxlength="20"><span class="field-hint">1–20 ตัวอักษร ไม่ซ้ำ</span></div><button class="btn btn-primary">เพิ่ม</button></form>
</section>
```
- แถวใช้อยู่: `.level-usage.is-used` (● นำหน้า) · ลบไม่ได้: `li.is-locked` ขอบซ้ายเหลือง + `.level-lock-note` ("ลบไม่ได้: …" เติมโดย CSS) + ปุ่มลบ `disabled` · โหมดแก้ชื่อ `li.is-editing` (กรอบน้ำเงิน) · ข้อผิดพลาดตรวจชื่อ `.level-error-note` (✖ นำหน้า) · ปุ่มเลื่อนขึ้นลง `.btn-icon` ≥40px; ระดับแรก/สุดท้ายใส่ `disabled` ที่ปุ่มขึ้น/ลงตามลำดับ

### 10.10 class ใหม่ทั้งหมด (T43)
`.tt-mark` (`-general` `-vocational` `-shared`) `.type-general` `.type-vocational` `.tt-lunch-text` `.tt-fs-1..4` `.tt-fulltext` `.legend-swatch.type-general|type-vocational` · `.multi-bar` (`.is-on` `.is-remove`) `.multi-count` `.multi-actions` `.multi-mode-label` `.tt-wrap.is-multi|is-selecting|is-remove` `.tt-cell.is-selected|is-range-preview|is-anchor|is-skipped` · `.result-summary` `.result-table` `.result-ok` `.result-fail` `.result-reason` `tr.row-ok|row-fail` · `.switch` `.switch-track` `.switch-label` · `.list-kit-bar` `.search-box` `.search-clear` `.list-filters` `.list-count` `.pager` `.pager-info` `.pager-btns` `.page-size` `.list-empty` · `.public-page` `.public-intro` `.public-bar` `.public-title` `.public-footer` `.public-disabled` `.link-muted` · `.settings-list` `.setting-row` (`.is-on`) `.setting-text` `.setting-title` `.setting-desc` `.setting-meta` `.pdpa-note`
