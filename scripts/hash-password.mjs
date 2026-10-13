// สร้างบรรทัดสำหรับ ADMIN_ACCOUNTS ของ Vercel (SPEC v5 ข้อ 16.2)
//   npm run hash-password -- <username>
//     → ถามรหัสผ่าน 2 ครั้ง (ไม่แสดงตัวอักษรบนจอ) → พิมพ์บรรทัด  ADMIN_ACCOUNTS=<username>:scrypt$...  พร้อมคัดลอกไปวางใน Vercel
//   (ไม่ใช่เทอร์มินัล เช่น เทสต์อัตโนมัติ: อ่านบรรทัดแรกจาก stdin แทน — ห้ามใช้ทางนี้กับรหัสผ่านจริง เพราะค้างใน history ของ shell)
// ความปลอดภัย: ไม่รับรหัสผ่านเป็น argument · ไม่พิมพ์รหัสผ่านซ้ำ · ไม่เขียนไฟล์ · hash→verify กลับก่อนพิมพ์ (กันสร้างแล้วใช้ไม่ได้)
// ใช้ hashPassword/verifyPassword ตัวเดียวกับที่เซิร์ฟเวอร์ใช้ตรวจ (server/auth.js)
import readline from 'node:readline';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../server/auth.js';

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const fail = (message) => { console.error(message); process.exit(1); };

const args = process.argv.slice(2);
if (args.length !== 1) {
  fail('วิธีใช้:  npm run hash-password -- <username>\n(ห้ามใส่รหัสผ่านเป็น argument — สคริปต์จะถามรหัสผ่านเอง)');
}
const username = args[0].toLowerCase(); // ระบบไม่แยกตัวพิมพ์เล็ก/ใหญ่: เก็บเป็นตัวพิมพ์เล็กเสมอ
if (!USERNAME_RE.test(username)) {
  fail('username ใช้ได้เฉพาะ A-Z a-z 0-9 . _ - ยาว 1-64 ตัวอักษร (ห้ามมีช่องว่าง : หรือ ;)');
}

// อ่านรหัสผ่านโดยไม่สะท้อนตัวอักษรบนจอ (เฉพาะเมื่อเป็นเทอร์มินัลจริง)
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(question); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
    rl.on('SIGINT', () => { rl.close(); reject(new Error('ยกเลิก')); });
  });
}

async function readFirstLineFromStdin() {
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) { rl.close(); return line.replace(/\r$/, ''); }
  return '';
}

try {
  let password;
  if (process.stdin.isTTY) {
    password = await promptHidden(`รหัสผ่านของ ${username} (อย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร): `);
    if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`รหัสผ่านสั้นไป — ต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร (ตอนนี้ ${password.length})`);
    const again = await promptHidden('พิมพ์รหัสผ่านซ้ำอีกครั้ง: ');
    if (password !== again) throw new Error('รหัสผ่านสองครั้งไม่ตรงกัน — ลองใหม่อีกครั้ง');
  } else {
    password = await readFirstLineFromStdin();
  }
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`รหัสผ่านสั้นไป — ต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร (ตอนนี้ ${password.length})`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error(`รหัสผ่านยาวเกิน ${MAX_PASSWORD_LENGTH} ตัวอักษร`);

  const hash = await hashPassword(password);
  if (!(await verifyPassword(password, hash)) || (await verifyPassword(`${password}x`, hash))) {
    throw new Error('ตรวจย้อนกลับ (hash→verify) ไม่ผ่าน — ห้ามใช้บรรทัดนี้ ลองรันใหม่');
  }
  const line = `ADMIN_ACCOUNTS=${username}:${hash}`;
  console.log(line);
  if (process.stdout.isTTY) {
    console.error([
      '',
      '✔ สร้างเสร็จ (ตรวจย้อนกลับผ่านแล้ว) — คัดลอกบรรทัดข้างบนทั้งบรรทัดไปตั้งค่าที่ Vercel → Settings → Environment Variables (วางตรง ๆ ไม่ต้องใส่คำพูด)',
      '',
      '  ถ้าจำเป็นต้องใส่ในไฟล์ .env บนเครื่อง (Vite/vercel dev ขยาย $… เป็นตัวแปร ทำให้แฮชเพี้ยนแม้ครอบคำพูด) ให้ใช้รูปที่ escape $ แล้วนี้แทน — ห้ามใช้รูปนี้บน Vercel:',
      `  ${line.replaceAll('$', '\\$')}`,
      '',
      '  • มีแอดมินหลายคน: ต่อท้ายด้วย ; เช่น  ADMIN_ACCOUNTS=admin1:scrypt$…;admin2:scrypt$…  (ใส่ค่าหลัง = เท่านั้น ไม่ต้องมีเครื่องหมายคำพูด)',
      '  • เปลี่ยนรหัสผ่านของคนเดิม: สร้างบรรทัดใหม่แล้วแทนที่ส่วนของคนนั้น — เซสชันเดิมของเขาจะหลุดทันที',
      '  • อย่า commit ลงไฟล์ อย่าส่งทางแชต · แก้ env แล้วต้อง Redeploy ถึงจะมีผล',
    ].join('\n'));
  }
} catch (err) {
  fail(err.message);
}
