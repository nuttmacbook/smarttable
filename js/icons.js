// ไอคอน SVG ฝังเอง (ชุดเล็ก เส้น 1.75px ตามตาราง 24px) — ค่าคงที่ในโค้ดเท่านั้น ไม่ประกอบจากข้อมูลผู้ใช้
// ใช้ currentColor และขนาด 1em (ปรับด้วย CSS .icon) ; aria-hidden เสมอ (ความหมายอยู่ในข้อความ/aria-label ของปุ่ม)
// ไม่มี <script>/onload/xlink:href/ทรัพยากรภายนอก (CSP default-src 'self')
const PATHS = Object.freeze({
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  inbox: '<path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z"/><path d="M4 13h4.5l1 2.5h5l1-2.5H20"/>',
  alert: '<path d="M12 4l9 16H3L12 4z"/><path d="M12 10v4M12 17.5v.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4"/><path d="M15 8l4 4-4 4M19 12H9"/>',
});

export const ICON_NAMES = Object.freeze(Object.keys(PATHS));

// icon('x') -> '<svg class="icon icon-x" …>' ; ชื่อที่ไม่รู้จักคืนสตริงว่าง (ไม่ throw)
export function icon(name, extraClass = '') {
  const d = Object.prototype.hasOwnProperty.call(PATHS, name) ? PATHS[name] : null;
  if (!d) return '';
  const extra = /^[a-z0-9 -]{1,30}$/.test(extraClass) ? ` ${extraClass}` : '';
  return `<svg class="icon icon-${name}${extra}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;
}
