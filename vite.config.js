import { defineConfig, loadEnv } from 'vite';

// ตัวแปรที่ขึ้นต้น VITE_ ถูกฝังลงไฟล์หน้าเว็บที่ผู้ใช้ทุกคนอ่านได้ — ห้ามใช้กับความลับ (ดู .env.example)
// ใช้ allowlist (ไม่ใช่รายชื่อคำต้องห้าม): ตัวแปร VITE_* ที่มีค่าและ "ไม่อยู่ในรายการนี้" ทำให้ build/dev ล้มทันที
// ตอนนี้โค้ดหน้าเว็บ (js/) ไม่อ่าน VITE_* ใด ๆ จึงว่างไว้ — BASE_URL / MODE ที่ Vite ให้เองไม่ขึ้นต้น VITE_ ไม่เกี่ยวข้อง
// ถ้าจะเพิ่ม: ใส่ชื่อที่เป็นข้อมูลสาธารณะจริง ๆ ที่นี่ พร้อมเหตุผล (ห้ามใส่ความลับ)
const ALLOWED_VITE_VARS = new Set([]);

// Vercel เปิด "Automatically expose System Environment Variables" แล้วสร้าง VITE_VERCEL_* ให้เองตอน build (VITE_VERCEL_ENV, VITE_VERCEL_URL,
// VITE_VERCEL_GIT_COMMIT_SHA ฯลฯ) — เป็นตัวแปรระบบ ไม่ใช่ที่เราตั้ง จึงยกเว้นเฉพาะคำนำหน้านี้ใน guard
// ความปลอดภัยของการยกเว้นอยู่ที่ envPrefix ด้านล่าง: Vite ไม่เปิดตัวแปร VITE_* ใดเข้า import.meta.env เลย จึงไม่ถูกฝังลง bundle ต่อให้มีค่ายาว/โทเค็น
// ห้ามเพิ่มชื่อใหม่ที่มีโทเค็นเข้า ALLOWED_VITE_VARS
const SYSTEM_VAR_PREFIX = 'VITE_VERCEL_';

const guards = () => ({
  name: 'tt-build-guards',
  config(userConfig, { mode }) {
    const fileEnv = loadEnv(mode, userConfig.root ?? process.cwd(), 'VITE_'); // รวมค่าจาก .env* ด้วย ไม่ใช่แค่ process.env
    const names = new Set([...Object.keys(process.env), ...Object.keys(fileEnv)].filter((k) => k.startsWith('VITE_')));
    // ค่าว่างไม่ฝังอะไร (ใช้ล้างค่าจากไฟล์ .env ในเทสต์/สคริปต์ได้) — ตัดสินจากค่าที่มีผลจริง (process.env ชนะไฟล์)
    const bad = [...names].filter((k) => !k.startsWith(SYSTEM_VAR_PREFIX) && !ALLOWED_VITE_VARS.has(k) && String(process.env[k] ?? fileEnv[k] ?? '') !== '');
    if (bad.length) {
      throw new Error(`ตัวแปร ${bad.join(', ')} ขึ้นต้นด้วย VITE_ จะถูกฝังลงบันเดิลที่ทุกคนอ่านได้ และไม่อยู่ในรายการที่อนุญาตของ vite.config.js — ความลับต้องใช้ชื่อไม่มี VITE_ และอ่านที่ api/ เท่านั้น; ถ้าไม่ใช่ความลับและโค้ดใช้จริง ให้เพิ่มชื่อใน ALLOWED_VITE_VARS (mode: ${mode})`);
    }
  },
});

export default defineConfig({
  plugins: [guards()],
  // คำนำหน้าที่ไม่มีใครใช้ → ไม่มีตัวแปร VITE_* ใดเข้า import.meta.env / bundle (กัน VITE_VERCEL_* ที่ Vercel สร้างให้)
  envPrefix: 'TT_PUBLIC_',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false, // ไม่เผยซอร์สแมปบนโปรดักชัน
    chunkSizeWarningLimit: 1000, // pdfmake (~970 kB) โหลดแบบ dynamic import เฉพาะตอนส่งออก
  },
  server: { port: 5173 },
});