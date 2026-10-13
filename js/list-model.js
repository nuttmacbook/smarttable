// โมเดลรายการ: ค้นหา/กรอง/เรียง/แบ่งหน้า — pure ไม่แตะ DOM/storage ไม่มี dependency (SPEC v5 §17)
// ไม่ใช้ object ธรรมดาเป็นดัชนีด้วยข้อมูล (W-02): ใช้ Map/WeakMap/Set เท่านั้น
//   normalizeText(s)                       -> string   NFC + lowercase + ตัดอักขระควบคุม/zero-width + ยุบช่องว่าง (ไทยค้นตรงตัว ไม่ตัดวรรณยุกต์/สระ)
//   matchQuery(item, fields, query)        -> boolean  ทุกคำ (แยกด้วยช่องว่าง) ต้องอยู่ใน field ใด field หนึ่ง (AND ของคำ)
//   filterItems(items, {query, fields, filters}) -> item[]
//   sortItems(items, {key, dir})           -> item[]   เรียงแบบ locale ไทย (Intl.Collator) เสถียร ไม่แก้ input
//   paginate(items, {page, pageSize})      -> {items, page, pageSize, total, totalPages, from, to}
//   queryList(items, opts)                 -> paginate(sort(filter(items)))  + matched (จำนวนหลังกรองก่อนแบ่งหน้า)
// fields = (item) => string[] (หรือ array ของ string สำหรับ matchQuery) · filters = [(item) => boolean]
import { sanitizeText } from './validate.js';

export const PAGE_SIZES = [25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;

export function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return sanitizeText(typeof value === 'string' ? value : String(value), { max: Infinity })
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const termsOf = (query) => {
  const q = normalizeText(query);
  return q === '' ? [] : q.split(' ');
};

// ดัชนีข้อความที่ normalize แล้วต่อรายการ (cache ต่อ ฟังก์ชัน fields + ออบเจ็กต์รายการ) — รายการใหม่/ถูกแทนที่ (immutable) = คำนวณใหม่
const INDEX = new WeakMap(); // fieldsFn -> WeakMap(item -> string[])
const indexOf = (item, fields) => {
  const compute = () => (typeof fields === 'function' ? fields(item) : fields).map(normalizeText);
  if (typeof fields !== 'function' || item === null || typeof item !== 'object') return compute();
  let per = INDEX.get(fields);
  if (!per) {
    per = new WeakMap();
    INDEX.set(fields, per);
  }
  let hay = per.get(item);
  if (!hay) {
    hay = compute();
    per.set(item, hay);
  }
  return hay;
};

const matchTerms = (hay, terms) => terms.every((t) => hay.some((h) => h.includes(t)));

export function matchQuery(item, fields, query) {
  const terms = termsOf(query);
  if (terms.length === 0) return true;
  return matchTerms(indexOf(item, fields), terms);
}

export function filterItems(items, { query = '', fields, filters = [] } = {}) {
  const list = Array.isArray(items) ? items : [];
  const terms = termsOf(query);
  const preds = Array.isArray(filters) ? filters.filter((f) => typeof f === 'function') : [];
  if (terms.length === 0 && preds.length === 0) return list.slice();
  const out = [];
  for (const item of list) {
    if (preds.length && !preds.every((f) => f(item))) continue;
    if (terms.length && !matchTerms(indexOf(item, fields), terms)) continue;
    out.push(item);
  }
  return out;
}

let collator;
const getCollator = () => {
  if (!collator) {
    try {
      collator = new Intl.Collator('th', { numeric: true, sensitivity: 'base' });
    } catch {
      collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    }
  }
  return collator;
};

// key = (item) => string|number ; dir 'asc'|'desc' ; ข้อความเทียบแบบ locale ไทย (เลขในรหัสเทียบเป็นตัวเลข), ตัวเลขเทียบตัวเลข; เสถียร
export function sortItems(items, { key = (x) => x, dir = 'asc' } = {}) {
  const sign = dir === 'desc' ? -1 : 1;
  const cmp = getCollator().compare;
  const decorated = (Array.isArray(items) ? items : []).map((item, i) => ({ item, i, k: key(item) }));
  decorated.sort((a, b) => {
    const ka = a.k ?? '';
    const kb = b.k ?? '';
    const c = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : cmp(String(ka), String(kb));
    return c !== 0 ? sign * c : a.i - b.i;
  });
  return decorated.map((d) => d.item);
}

export function paginate(items, { page = 1, pageSize = DEFAULT_PAGE_SIZE } = {}) {
  const list = Array.isArray(items) ? items : [];
  const size = PAGE_SIZES.includes(pageSize) ? pageSize : DEFAULT_PAGE_SIZE;
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const p = Number.isFinite(Number(page)) ? Math.trunc(Number(page)) : 1;
  const cur = Math.min(Math.max(p, 1), totalPages);
  const start = (cur - 1) * size;
  const slice = list.slice(start, start + size);
  return {
    items: slice,
    page: cur,
    pageSize: size,
    total,
    totalPages,
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + slice.length,
  };
}

// ทางลัด: กรอง → เรียง (ถ้ามี sort) → แบ่งหน้า ; matched = จำนวนที่ผ่านตัวกรอง
export function queryList(items, { query, fields, filters, sort, page, pageSize } = {}) {
  let list = filterItems(items, { query, fields, filters });
  const matched = list.length;
  if (sort) list = sortItems(list, sort);
  return { ...paginate(list, { page, pageSize }), matched };
}
