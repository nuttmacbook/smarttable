// เมนูลิ้นชักบนมือถือ/แท็บเล็ตแคบ (≤768px): ปุ่ม #nav-toggle เปิด/ปิด #nav (คลาส is-open) + ม่าน #nav-backdrop
// - aria-expanded/aria-controls บนปุ่ม · ปิดเมื่อเลือกเมนู/กด Esc/คลิกม่าน/ขยายจอเกิน 768px
// - ขณะเปิด: โฟกัสวนอยู่ในปุ่ม+เมนู+ปุ่มในแถบสถานะ (รวมปุ่มออกจากระบบ) ส่วนเนื้อหาหลักเป็น inert (กดหลังม่านไม่ได้) ; ปิดแล้วคืนโฟกัสให้ปุ่ม
// - ปุ่มซ่อนเมื่อไม่มีเมนู (หน้าสาธารณะ/ล็อกอิน) ผ่าน sync() ; ไอคอนเป็น SVG ค่าคงที่จาก js/icons.js
import { icon } from './icons.js';

export function mountNavDrawer({ nav, toggle, backdrop, main, status, doc = globalThis.document, win = globalThis, mq = globalThis.matchMedia?.('(max-width: 768px)') }) {
  let open = false;
  const isMobile = () => (mq ? mq.matches : true);
  const focusables = () => {
    const sel = 'a[href],button:not([disabled])';
    return [toggle, ...(nav.querySelectorAll?.(sel) ?? []), ...(status?.querySelectorAll?.(sel) ?? [])].filter(Boolean);
  };

  function paint() {
    nav.classList.toggle('is-open', open);
    backdrop.classList.toggle('is-open', open);
    backdrop.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'ปิดเมนู' : 'เปิดเมนู');
    toggle.innerHTML = `${icon(open ? 'x' : 'menu')}<span class="nav-toggle-text">เมนู</span>`;
    doc.body?.classList?.toggle('nav-open', open);
    if (main) main.inert = open && isMobile();
  }
  function set(next, { restoreFocus = true } = {}) {
    if (open === next) return;
    open = next;
    paint();
    if (open) nav.querySelector?.('a[href]')?.focus?.();
    else if (restoreFocus) toggle.focus?.();
  }

  toggle.addEventListener('click', () => set(!open));
  backdrop.addEventListener('click', () => set(false));
  nav.addEventListener('click', (e) => {
    if (open && e.target?.closest?.('a[href]')) set(false, { restoreFocus: false });
  });
  doc.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault?.(); set(false); return; }
    if (e.key !== 'Tab') return;
    const list = focusables();
    if (!list.length) return;
    const i = list.indexOf(doc.activeElement);
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === -1 || i === list.length - 1 ? 0 : i + 1);
    e.preventDefault?.();
    list[next].focus?.();
  });
  // กด Back/เปลี่ยน hash ขณะเปิดลิ้นชัก → ปิด (ไม่ให้ลิ้นชักค้างและ main inert)
  win?.addEventListener?.('hashchange', () => set(false, { restoreFocus: false }));
  mq?.addEventListener?.('change', () => { if (!mq.matches) set(false, { restoreFocus: false }); });

  paint();
  return {
    // เรียกหลังเขียน #nav ใหม่: ไม่มีเมนู = ซ่อนปุ่มและปิดลิ้นชัก
    sync() {
      const has = Boolean(nav.innerHTML && nav.innerHTML.trim());
      toggle.hidden = !has;
      if (!has) set(false, { restoreFocus: false });
    },
    close: () => set(false),
    get isOpen() { return open; },
  };
}
