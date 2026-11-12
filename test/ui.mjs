// Browser smoke test: signs up, seeds data, opens every screen as admin, teacher and parent, fails on any error.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require(require('node:child_process').execSync('npm root -g').toString().trim() + '/playwright')); }
const BASE = process.env.BASE || 'http://localhost:8787';
const SHOTS = process.env.SHOTS || '';
const u = Date.now().toString().slice(-6);
const browser = await chromium.launch();
let problems = 0;

async function newPage(width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { problems++; console.log('  PAGE ERROR', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' && !/401|403|409|404|Failed to load resource/.test(m.text())) { problems++; console.log('  CONSOLE', m.text()); } });
  return page;
}
async function visit(page, hash, label) {
  await page.goto(BASE + '/#' + hash);
  await page.waitForTimeout(500);
  await page.waitForLoadState('networkidle');
  const bad = await page.$$eval('.banner.bad', (els) => els.map((e) => e.textContent).filter((t) => !/paused|overdue/i.test(t)));
  const ok = bad.length === 0;
  if (!ok) problems++;
  console.log(`  ${ok ? '✓' : '✗'} ${label} ${hash}${ok ? '' : ' → ' + bad.join(' | ')}`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${label}-${hash.replace(/[^\w]+/g, '_')}.png`, fullPage: false });
}
async function codeLogin(page, identifier) {
  await page.goto(BASE + '/#/login');
  await page.fill('#f1 input', identifier);
  await page.click('#f1 button');
  await page.waitForSelector('#msg b');
  const code = (await page.textContent('#msg b')).match(/\d{6}/)[0];
  await page.fill('#f2 input', code);
  await page.click('#f2 button');
  await page.waitForTimeout(800);
}
const call = (page, path, body, method) => page.evaluate(async ([p, b, m]) => {
  const r = await fetch(p, { method: m || (b ? 'POST' : 'GET'), headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined });
  return r.json();
}, [path, body, method]);

console.log('Admin');
const admin = await newPage();
await admin.goto(BASE + '/#/signup');
await admin.fill('[name=school_name]', 'Green Valley School');
await admin.fill('[name=admin_name]', 'Rahim');
await admin.fill('[name=email]', `ui${u}@test.pk`);
await admin.click('#f1 button');
await admin.waitForSelector('#msg b');
await admin.fill('#f2 input', (await admin.textContent('#msg b')).match(/\d{6}/)[0]);
await admin.click('#f2 button');
await admin.waitForTimeout(1000);
const t = await call(admin, '/api/s/staff', { name: 'Ayesha Noor', email: `tui${u}@test.pk`, subjects: 'English' });
const c = await call(admin, '/api/s/classes', { name: '5-A', grade: 5, class_teacher_id: t.id });
await call(admin, '/api/s/classes', { name: '6-A', grade: 6 });
const st = await call(admin, '/api/s/students', { name: 'Hamza Iqbal', father_name: 'Iqbal Hussain', class_id: c.id, parent_phone: '0311' + u + '1' });
await call(admin, '/api/s/students', { name: 'Zainab Iqbal', father_name: 'Iqbal Hussain', class_id: c.id, parent_phone: '0311' + u + '1' });
const setup = await call(admin, '/api/s/fees/setup');
await call(admin, '/api/s/fees/plans', { plans: [{ class_id: c.id, head_id: setup.heads[0].id, amount: 2500 }] });
await call(admin, '/api/s/fees/generate', { month: new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 7) });
await call(admin, '/api/s/notices', { audience: 'school', title: 'Welcome back', body: 'School reopens Monday.' });
for (const h of ['/', '/setup', '/students', `/student/${st.id}`, `/student/${st.id}?tab=attendance`, `/student/${st.id}?tab=fees`, `/student/${st.id}?tab=history`, '/staff', `/staff/${t.id}`, '/classes', `/class/${c.id}`,
  '/attendance', `/attendance/${c.id}`, '/fees', '/fees/unpaid', '/fees/slips', '/fees/defaulters', '/fees/report', '/fees/setup', '/cash', '/notices', '/threads', `/thread/${st.id}`, '/results', '/requests',
  '/notifications', '/settings', '/settings?tab=holidays', '/settings?tab=devices', '/settings?tab=promotion', '/settings?tab=storage', '/settings?tab=data', '/settings?tab=audit', '/billing'])
  await visit(admin, h, 'admin');

console.log('Teacher marks attendance in the UI');
const teacher = await newPage(390);
await codeLogin(teacher, `tui${u}@test.pk`);
await visit(teacher, '/', 'teacher');
await visit(teacher, `/attendance/${c.id}`, 'teacher');
await teacher.click('.att-row:first-child button.A');
await teacher.click('#sub');
await teacher.click('#ok');
await teacher.waitForTimeout(800);
const day = await call(teacher, `/api/s/attendance/${c.id}/${new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10)}`);
const okSub = day.status === 'submitted' && day.students.some((s) => s.status === 'A');
console.log(`  ${okSub ? '✓' : '✗'} attendance submitted from phone-size screen`); if (!okSub) problems++;
for (const h of ['/students', `/student/${st.id}`, '/fees', '/fees/unpaid', '/cash', '/notices', '/results', '/requests']) await visit(teacher, h, 'teacher');

console.log('Parent');
const parent = await newPage(390);
await codeLogin(parent, '0311' + u + '1');
for (const h of ['/', `/student/${st.id}`, `/student/${st.id}?tab=attendance`, `/student/${st.id}?tab=fees`, '/notices', '/threads', `/thread/${st.id}`, '/notifications']) await visit(parent, h, 'parent');
const notes = await call(parent, '/api/s/notifications');
const alerted = notes.some((n) => n.title === 'Absent today');
console.log(`  ${alerted ? '✓' : '✗'} parent got the absence alert`); if (!alerted) problems++;

console.log('Owner');
const owner = await newPage();
await codeLogin(owner, 'owner@example.com');
await visit(owner, '/owner', 'owner');

await browser.close();
console.log(problems ? `\n${problems} problem(s)` : '\nAll screens OK');
process.exit(problems ? 1 : 0);
