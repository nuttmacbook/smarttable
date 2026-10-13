// จุดเริ่มของแอป: ต่อ DOM จริงเข้ากับ createApp (js/app-core.js)
import { createApiClient } from './api-client.js';
import { createApp } from './app-core.js';
import { mountNavDrawer } from './nav-drawer.js';
import { skeletonHtml } from './pages/util.js';

// ฟอนต์ Sarabun โฮสต์เอง (ไม่ใช้ Google Fonts เพราะ CSP) — โหลดผ่าน Vite เท่านั้น; เปิดแบบ static ไม่มี import.meta.env → ใช้ฟอนต์ระบบ
if (import.meta.env) {
  try {
    await Promise.all([
      import('@fontsource/sarabun/thai-400.css'), import('@fontsource/sarabun/thai-600.css'), import('@fontsource/sarabun/thai-700.css'),
      import('@fontsource/sarabun/latin-400.css'), import('@fontsource/sarabun/latin-600.css'), import('@fontsource/sarabun/latin-700.css'),
    ]);
  } catch {
    // ไม่มีฟอนต์ก็ใช้ฟอนต์ระบบแทน
  }
}

const els = {
  nav: document.getElementById('nav'),
  main: document.getElementById('main'),
  status: document.getElementById('status'),
  legacy: document.getElementById('legacy-bar'),
};

els.navDrawer = mountNavDrawer({
  nav: els.nav,
  toggle: document.getElementById('nav-toggle'),
  backdrop: document.getElementById('nav-backdrop'),
  main: els.main,
  status: els.status,
});
els.main.innerHTML = skeletonHtml(5); // รอโหลดข้อมูล/ตรวจสิทธิ์ครั้งแรก

const app = createApp({
  api: createApiClient(),
  els,
  env: {
    getHash: () => location.hash,
    setHash: (h) => history.replaceState(null, '', h === '#/' ? location.pathname + location.search : h),
    title: (t) => { document.title = t; },
  },
});

window.addEventListener('hashchange', () => app.onHashChange());

await app.start();
