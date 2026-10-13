// กฎชนของตารางสอน (v4) — pure functions ไม่แตะ DOM / localStorage
// กลุ่มเรียน (groups, groupId) = นักเรียนสังกัด · ห้องเรียน (rooms, roomId) = สถานที่เรียน
// ครูผู้สอน: subject.teacherIds (0..n) และ entry.teacherId (เลือกจาก teacherIds)
import { DAYS, PERIODS, LUNCH, dayName, periodLabel } from './constants.js';

const byId = (list, id) => (list || []).find((x) => x.id === id);
const has = (v) => v !== undefined && v !== null && v !== '';
const idsOf = (subject) => (subject && Array.isArray(subject.teacherIds) ? subject.teacherIds : []);

// วิชาสามัญเดียวกัน (id เดียวกัน) เรียนรวมข้ามกลุ่มเรียนได้
export function canMerge(subjectA, subjectB) {
  return Boolean(subjectA && subjectB && subjectA.id === subjectB.id && subjectA.type === 'general');
}

// ครูที่มีผลของ entry: entry.teacherId ถ้ามี ไม่งั้นครูคนเดียวของวิชา ไม่งั้น null
export function effectiveTeacherId(state, entry) {
  if (!entry) return null;
  if (has(entry.teacherId)) return entry.teacherId;
  const ids = idsOf(byId(state.subjects, entry.subjectId));
  return ids.length === 1 ? ids[0] : null;
}

// รายการ entry อื่นที่ชนห้องเรียน (ห้องเดียวกัน วัน+คาบเดียวกัน กลุ่มเรียนอื่น ยกเว้นเรียนรวม)
function classroomClashes(state, { groupId, day, period, subject, roomId }, entries) {
  if (!has(roomId)) return [];
  return entries.filter((e) => {
    if (e.roomId !== roomId || e.day !== day || e.period !== period || e.groupId === groupId) return false;
    return !canMerge(subject, byId(state.subjects, e.subjectId));
  });
}

export function checkPlacement(state, { groupId, day, period, subjectId, roomId, teacherId, ignoreEntryId } = {}) {
  const conflicts = [];
  const warnings = [];
  const result = () => ({ ok: conflicts.length === 0, conflicts, warnings });
  const invalid = (message) => {
    conflicts.push({ type: 'invalid', message });
    return result();
  };

  const group = byId(state.groups, groupId);
  if (!group) return invalid('ไม่พบกลุ่มเรียนที่เลือก');
  if (!DAYS.some((d) => d.id === day)) return invalid('วันไม่ถูกต้อง (ต้องเป็นจันทร์–ศุกร์)');
  if (period === LUNCH.id) {
    conflicts.push({
      type: 'lunch',
      message: `ช่วงพักเที่ยง ${LUNCH.start}–${LUNCH.end} ไม่ใช่คาบเรียน ลงวิชาไม่ได้`,
    });
    return result();
  }
  if (!PERIODS.some((p) => p.id === period)) return invalid('คาบไม่ถูกต้อง (ต้องเป็นคาบ 1–11)');
  const subject = byId(state.subjects, subjectId);
  if (!subject) return invalid('ไม่พบรายวิชาที่เลือก');
  const room = has(roomId) ? byId(state.rooms, roomId) : null;
  if (has(roomId) && !room) return invalid('ไม่พบห้องเรียนที่เลือก');

  const subjectTeacherIds = idsOf(subject);
  const subjName = `${subject.code} ${subject.name}`.trim();
  if (has(teacherId) && !subjectTeacherIds.includes(teacherId)) {
    return invalid(`ครูที่เลือกไม่ได้เป็นครูผู้สอนของวิชา ${subjName}`);
  }
  // ครูที่มีผลของรายการที่จะลง
  const effTeacher = has(teacherId) ? teacherId : subjectTeacherIds.length === 1 ? subjectTeacherIds[0] : null;
  const teacher = effTeacher ? byId(state.teachers, effTeacher) : null;

  const entries = (state.entries || []).filter((e) => e.id !== ignoreEntryId);
  const when = `วัน${dayName(day)} ${periodLabel(period)}`;

  // กฎ 4: ระดับของกลุ่มเรียนต้องอยู่ในระดับที่วิชาเปิดสอน
  if (Array.isArray(subject.levels) && !subject.levels.includes(group.level)) {
    conflicts.push({
      type: 'level',
      message: `วิชา ${subjName} เปิดสอนระดับ ${subject.levels.join(', ') || '(ไม่ระบุ)'} แต่กลุ่มเรียน ${group.name} เป็นระดับ ${group.level}`,
    });
  }

  // กฎ 1: กลุ่มเรียน+วัน+คาบ เดียวกันมีได้ 1 รายการ
  for (const e of entries) {
    if (e.groupId === groupId && e.day === day && e.period === period) {
      const other = byId(state.subjects, e.subjectId);
      conflicts.push({
        type: 'group',
        entryId: e.id,
        message: `กลุ่มเรียน ${group.name} ${when} มีวิชา ${other ? other.name : e.subjectId} ลงไว้แล้ว`,
      });
    }
  }

  // กฎ 2: ครูที่มีผลคนเดียวกัน วัน+คาบ เดียวกัน คนละกลุ่มเรียน ชน ยกเว้นวิชาสามัญเดียวกัน (เรียนรวม)
  if (effTeacher) {
    for (const e of entries) {
      if (e.day !== day || e.period !== period || e.groupId === groupId) continue;
      if (effectiveTeacherId(state, e) !== effTeacher) continue;
      const other = byId(state.subjects, e.subjectId);
      if (canMerge(subject, other)) continue;
      const otherGroup = byId(state.groups, e.groupId);
      const reason = other && subject.id === other.id ? ' (วิชาชีพเรียนรวมข้ามกลุ่มเรียนไม่ได้)' : '';
      conflicts.push({
        type: 'teacher',
        entryId: e.id,
        message: `ครู${teacher ? teacher.name : effTeacher} สอนวิชา ${other ? other.name : e.subjectId} ที่กลุ่มเรียน ${otherGroup ? otherGroup.name : e.groupId} ${when} อยู่แล้ว จึงสอนวิชา ${subjName} ที่กลุ่มเรียน ${group.name} พร้อมกันไม่ได้${reason}`,
      });
    }
  }

  // กฎ 3: ห้องเรียนเดียวกัน วัน+คาบ เดียวกัน ถูกกลุ่มเรียนอื่นใช้อยู่ (เรียนรวมใช้ห้องเดียวกันได้)
  for (const e of classroomClashes(state, { groupId, day, period, subject, roomId }, entries)) {
    const other = byId(state.subjects, e.subjectId);
    const otherGroup = byId(state.groups, e.groupId);
    conflicts.push({
      type: 'classroom',
      entryId: e.id,
      message: `ห้องเรียน ${room.name} ${when} ถูกใช้โดยกลุ่มเรียน ${otherGroup ? otherGroup.name : e.groupId} (วิชา ${other ? other.name : e.subjectId}) อยู่แล้ว`,
    });
  }

  // คำเตือน (ไม่ block)
  if (subjectTeacherIds.length === 0) {
    warnings.push(`วิชา ${subjName} ยังไม่ได้กำหนดครูผู้สอน`);
  } else if (!effTeacher) {
    warnings.push(`วิชา ${subjName} มีครูผู้สอนหลายคน ยังไม่ได้เลือกครูผู้สอนของคาบนี้`);
  }
  // วิชานอกแผนการเรียนของกลุ่ม (กลุ่มที่ subjectIds ว่าง = ไม่เตือน)
  if (Array.isArray(group.subjectIds) && group.subjectIds.length > 0 && !group.subjectIds.includes(subjectId)) {
    warnings.push(`วิชา ${subjName} ไม่อยู่ในแผนการเรียนของกลุ่มเรียน ${group.name}`);
  }

  // กฎ hours (v4): คาบของวิชานี้ในกลุ่มเรียน (ไม่นับ ignoreEntryId) ต้องไม่เกิน subject.hours — บล็อกจริง
  const hours = Number(subject.hours);
  if (Number.isFinite(hours) && hours > 0) {
    const used = entries.filter((e) => e.groupId === groupId && e.subjectId === subjectId).length;
    if (used + 1 > hours) {
      conflicts.push({
        type: 'hours',
        message: `วิชา ${subjName} กลุ่มเรียน ${group.name} กำหนด ${hours} ชม./สัปดาห์ ลงแล้ว ${used} คาบ ลงเพิ่มไม่ได้ (จะเกินเป็น ${used + 1} คาบ)`,
      });
    }
  }
  return result();
}

// ห้องเรียนที่เลือกได้ในช่วงนั้น (ไม่ชน หรือใช้ร่วมได้เพราะเรียนรวม) ให้ UI ใช้ทำตัวเลือก
export function availableClassrooms(state, { groupId, day, period, subjectId, ignoreEntryId } = {}) {
  const subject = byId(state.subjects, subjectId);
  const entries = (state.entries || []).filter((e) => e.id !== ignoreEntryId);
  return (state.rooms || []).filter(
    (r) => classroomClashes(state, { groupId, day, period, subject, roomId: r.id }, entries).length === 0,
  );
}

// ครูของวิชา + ว่างหรือไม่ ณ คาบนั้น (conflicts เฉพาะชนครู) ให้ UI ทำตัวเลือกครู
export function availableTeachers(state, { groupId, day, period, subjectId, ignoreEntryId } = {}) {
  const subject = byId(state.subjects, subjectId);
  if (!subject) return [];
  return idsOf(subject)
    .map((tid) => ({ tid, teacher: byId(state.teachers, tid) }))
    .filter((x) => x.teacher)
    .map(({ tid, teacher }) => {
      const r = checkPlacement(state, { groupId, day, period, subjectId, teacherId: tid, ignoreEntryId });
      const conflicts = r.conflicts.filter((c) => c.type === 'teacher');
      return { teacher, ok: conflicts.length === 0, conflicts };
    });
}

// รายการ hours เกิน หนึ่งรายการต่อ กลุ่มเรียน+วิชา; entryId = คาบแรก (เรียง วัน→คาบ) ที่เกินจากโควตา
export function hoursViolations(state) {
  const buckets = new Map();
  for (const e of state.entries || []) {
    const k = `${e.groupId}\u0000${e.subjectId}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(e);
  }
  const out = [];
  for (const list of buckets.values()) {
    const subject = byId(state.subjects, list[0].subjectId);
    const group = byId(state.groups, list[0].groupId);
    const hours = Number(subject && subject.hours);
    if (!subject || !group || !Number.isFinite(hours) || hours <= 0 || list.length <= hours) continue;
    const sorted = [...list].sort((a, b) => a.day - b.day || a.period - b.period);
    out.push({
      type: 'hours',
      message: `วิชา ${`${subject.code} ${subject.name}`.trim()} กลุ่มเรียน ${group.name} กำหนด ${hours} ชม./สัปดาห์ แต่ลงไว้ ${list.length} คาบ (เกิน ${list.length - hours} คาบ)`,
      entryId: sorted[hours].id,
      otherEntryId: undefined,
      groupId: group.id,
      subjectId: subject.id,
      hours,
      used: list.length,
    });
  }
  return out;
}

// ตรวจทั้งตารางก่อนบันทึก/นำเข้า คืนรายการชนทั้งหมด (คู่เดียวกันรายงานครั้งเดียว)
// แต่ละรายการ: { type, message, entryId, otherEntryId? } ; type 'hours' มี groupId, subjectId, hours, used เพิ่ม
export function validateAll(state) {
  const out = [];
  const seen = new Set();
  for (const e of state.entries || []) {
    const r = checkPlacement(state, {
      groupId: e.groupId,
      day: e.day,
      period: e.period,
      subjectId: e.subjectId,
      roomId: e.roomId,
      teacherId: e.teacherId,
      ignoreEntryId: e.id,
    });
    for (const c of r.conflicts) {
      if (c.type === 'hours') continue; // นับระดับกลุ่ม+วิชาใน hoursViolations
      const key = c.entryId
        ? `${c.type}:${[e.id, c.entryId].sort().join('|')}`
        : `${c.type}:${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ type: c.type, message: c.message, entryId: e.id, otherEntryId: c.entryId });
    }
  }
  return out.concat(hoursViolations(state));
}
