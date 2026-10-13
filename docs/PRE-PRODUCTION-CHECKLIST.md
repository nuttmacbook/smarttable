# เช็คลิสต์ก่อนขึ้น production (ไม่ต้องมีชุดทดสอบ)

เรียงจากถูก/เร็วไปแพง · ทำที่โฟลเดอร์ `timetable` · ข้อ 1–3 รันในเครื่องได้ ข้อ 4–5 ต้องมี deployment จริง
ขั้นตอนตั้งค่าอยู่ที่ [`DEPLOY.md`](DEPLOY.md) · ชื่อตัวแปรต้องตรงกันทั้ง `DEPLOY.md`, `.env.example` และ `process.env.*` ในโค้ด

## 1. build ด้วย env จำลองของแพลตฟอร์ม (ไม่ใช่ env ว่าง)
- ตั้ง `VERCEL=1 VERCEL_ENV=production VITE_VERCEL_ENV=production VITE_VERCEL_URL=example.vercel.app` แล้วรัน `node node_modules/vite/bin/vite.js build` → **ต้องผ่าน**
- รันอีกรอบโดยตั้ง `VITE_SESSION_SECRET=x` → **ต้องล้ม** (guard ใน `vite.config.js`)
- ยืนยันทั้งสองด้าน: guard ไม่บล็อกตัวแปรของแพลตฟอร์ม แต่ยังบล็อกความลับจริง

## 2. สแกน `dist/` หลัง build
- `grep -rE 'UPSTASH|SESSION_SECRET|ADMIN_ACCOUNTS|scrypt\$' dist/` → ต้องไม่พบอะไร
- ในโฟลเดอร์โปรเจกต์ต้องไม่มีไฟล์ `.env` (มีแค่ `.env.example`)

## 3. import โมดูลทุกไฟล์ใน node
- import ทุกไฟล์ใน `js/` (ยกเว้น `app.js` ที่ต้องใช้ DOM), `server/`, `api/` + `node --check` ไฟล์ที่เหลือ → จับ import ที่ตายหลังลบไฟล์ได้ทันที
- เทียบชื่อ env ใน `DEPLOY.md` = `.env.example` = `process.env.*` ในโค้ด

## 4. smoke ด้วย curl หลัง deploy (Preview ก่อน Production)
- `GET /api/auth/me` → 401 และมี `cache-control: no-store`
- `POST /api/op` โดยไม่ล็อกอิน → 401 (ต้องไม่ใช่ 500)
- `GET /api/public` → 200 หรือ 403 (public-disabled) · ถ้ายังไม่ยืนยันค่าซ่อนชื่อครู response ต้องไม่มี `teachers`/`teacherIds`
- หน้าแรกต้องมี header `content-security-policy` และ `strict-transport-security`

## 5. เปิดเบราว์เซอร์จริง ~10 นาที (ส่งออก JSON สำรองเก็บไว้ก่อนเริ่ม)
- ล็อกอินผิด 1 ครั้ง / ถูก 1 ครั้ง
- ลงวิชา 1 คาบ + ลองลงให้ชนครู → ต้องถูกปฏิเสธ
- ส่งออก JSON แล้วนำเข้าไฟล์เดิมกลับ → ข้อมูลต้องไม่เปลี่ยน
- ส่งออก PDF เปิดดู 1 หน้าไม่ล้น
- เปิด Console (F12) → ต้องไม่มี Content Security Policy violation
- เปิดลิงก์ดูอย่างเดียวในหน้าต่างส่วนตัว → ต้องไม่เห็นเมนู/ปุ่มแก้

## สถานะการรันจริง (อัปเดตเมื่อมีคนรัน)
| ข้อ | สถานะ |
|---|---|
| 1 | รันจริง 2026-10-13 (T60): `VITE_VERCEL_*` 17 ตัวผ่าน, `VITE_SECRET_X` / `VITE_API_KEY` ล้ม · ชุด env ตามข้อนี้ทั้งหมด (`VERCEL=1` ฯลฯ) ยังไม่ได้รันซ้ำ |
| 2, 3 | รันจริง 2026-10-13 (T57/T58) |
| 4, 5 | **ยังไม่เคยรันบน Vercel/เบราว์เซอร์จริง** — ผู้รันครั้งแรกจดผลที่ตารางนี้ |
