// End-to-end checks against a running dev server (npm run dev). Includes the plan's must-pass security tests.
const BASE = process.env.BASE || 'http://localhost:8787';
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) { passes++; console.log('  ✓', msg); } else { failures++; console.log('  ✗', msg); } };

async function api(token, method, path, body, isForm) {
  const headers = token ? { authorization: 'Bearer ' + token } : {};
  let b;
  if (isForm) b = body; else if (body !== undefined) { headers['content-type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers, body: b });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const S = (t, m, p, b, f) => api(t, m, '/api/s' + p, b, f);

async function login(identifier, pick) {
  const s = await api(null, 'POST', '/api/auth/start', { identifier });
  if (!s.json.devCode) throw new Error('no dev code for ' + identifier + ' ' + JSON.stringify(s.json));
  const v = await api(null, 'POST', '/api/auth/verify', { identifier, code: s.json.devCode, pick });
  if (v.json.choose) return api(null, 'POST', '/api/auth/verify', { identifier, code: s.json.devCode, pick: pick ?? 0 }).then((x) => x.json.token);
  if (!v.json.token) throw new Error('login failed ' + JSON.stringify(v.json));
  return v.json.token;
}
async function signup(name, email) {
  const s = await api(null, 'POST', '/api/signup/start', { school_name: name, admin_name: 'Admin ' + name, email, phone: '' });
  const v = await api(null, 'POST', '/api/signup/verify', { email, code: s.json.devCode });
  return v.json.token;
}
const uniq = Date.now().toString().slice(-6);
const phone = (n) => '0300' + String(uniq).slice(-3) + String(n).padStart(4, '0');

console.log('Setup');
const adminA = await signup('Alpha School', `a${uniq}@test.pk`);
const adminB = await signup('Beta School', `b${uniq}@test.pk`);
ok(adminA && adminB, 'two schools signed up with free trials');

const t1 = (await S(adminA, 'POST', '/staff', { name: 'Teacher One', email: `t1${uniq}@test.pk` })).json;
const t2 = (await S(adminA, 'POST', '/staff', { name: 'Teacher Two', email: `t2${uniq}@test.pk` })).json;
const acc = (await S(adminA, 'POST', '/staff', { name: 'Accountant', email: `acc${uniq}@test.pk`, role: 'subadmin', subrole: 'accountant' })).json;
const c7 = (await S(adminA, 'POST', '/classes', { name: '7-B', grade: 7, class_teacher_id: t1.id })).json;
const c8 = (await S(adminA, 'POST', '/classes', { name: '8-A', grade: 8, class_teacher_id: t2.id })).json;
await S(adminA, 'POST', `/classes/${c7.id}/subjects`, { subject: 'Maths', teacher_id: t2.id });
const s1 = (await S(adminA, 'POST', '/students', { name: 'Muhammad Ahmed', father_name: 'Ali Khan', class_id: c7.id, parent_phone: phone(1) })).json;
const s2 = (await S(adminA, 'POST', '/students', { name: 'Fatima Ahmed', father_name: 'Ali Khan', class_id: c8.id, parent_phone: phone(1) })).json;
const s3 = (await S(adminA, 'POST', '/students', { name: 'Usman Tariq', father_name: 'Tariq Mehmood', class_id: c8.id, parent_phone: phone(2) })).json;
ok(s1.reg_no && s2.guardian_id === s1.guardian_id, 'siblings share one parent sign-in');
const dup = await S(adminA, 'POST', '/students', { name: 'Muhammad Ahmed', father_name: 'Ali Khan', class_id: c7.id, parent_phone: phone(9) });
ok(dup.status === 409 && dup.json.needsConfirm, 'duplicate student warning');

const tok1 = await login(`t1${uniq}@test.pk`);
const tok2 = await login(`t2${uniq}@test.pk`);
const tokAcc = await login(`acc${uniq}@test.pk`);
const parent1 = await login(phone(1));
const me = (await S(parent1, 'GET', '/me')).json;
ok(me.children.length === 2, 'parent sees both children');

console.log('Security tests (must pass before every release)');
ok((await S(parent1, 'GET', `/students/${s3.id}`)).status === 403, "a parent requesting another child's record is refused");
ok((await S(tok1, 'GET', `/classes/${c8.id}`)).status === 403, 'a teacher requesting a class they do not teach is refused');
ok((await S(tok1, 'GET', `/students/${s3.id}`)).status === 403, "a teacher requesting a student outside their classes is refused");
ok((await S(adminB, 'GET', `/students/${s1.id}`)).status === 404, 'a user from school A… B requesting a record of school A is refused');
const srch = (await S(tok1, 'GET', '/search?q=usman')).json;
ok(srch.students.length === 0, 'teacher search cannot find students outside their classes');
ok((await S(tok2, 'GET', `/students/${s1.id}`)).status === 200, 'subject teacher can view students of a class they teach');
const feeView = (await S(tok2, 'GET', `/students/${s1.id}`)).json;
ok(feeView.vouchers === null, 'subject teacher sees no fees');
ok((await S(parent1, 'POST', '/notices', { audience: 'school', title: 'x', body: 'y' })).status === 403, 'parent cannot post notices');
ok((await S(tok1, 'POST', '/staff', { name: 'X', email: 'x@x.pk' })).status === 403, 'teacher cannot add staff');
ok((await api(null, 'GET', '/api/s/students')).status === 401, 'signed-out request refused');
ok((await api(adminA, 'GET', '/api/s/internal/cron')).status === 404, 'internal routes not reachable from outside');

console.log('Search');
const fz = (await S(adminA, 'GET', '/search?q=mohammad')).json;
ok(fz.students.some((s) => s.id === s1.id), 'Mohammad finds Muhammad');
ok((await S(adminA, 'GET', '/search?q=ahm')).json.students.length >= 2, 'partial "ahm" finds Ahmed');
ok((await S(adminA, 'GET', '/search?q=' + phone(2).slice(-4))).json.students.some((s) => s.id === s3.id), 'last 4 digits of parent phone');

console.log('Attendance');
const today = new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10);
ok((await S(tok2, 'POST', `/attendance/${c7.id}/${today}/submit`, { records: {} })).status === 403, 'subject teacher cannot mark class attendance');
const sub = await S(tok1, 'POST', `/attendance/${c7.id}/${today}/submit`, { records: { [s1.id]: 'A' } });
ok(sub.status === 200 && sub.json.status === 'submitted', 'class teacher submits attendance');
ok((await S(tok1, 'PUT', `/attendance/${c7.id}/${today}`, { records: {} })).status === 409, 'teacher cannot edit after submit');
const notes = (await S(parent1, 'GET', '/notifications')).json;
ok(notes.some((n) => n.title === 'Absent today'), 'parent alerted of absence');
const cr = await S(tok1, 'POST', '/change-requests', { kind: 'attendance', student_id: s1.id, date: today, status: 'L', reason: 'Came late, not absent' });
ok(cr.status === 200, 'teacher sends change request');
ok((await S(adminA, 'POST', `/change-requests/${cr.json.id}/decide`, { approve: true })).status === 200, 'admin approves');
const reg = (await S(adminA, 'GET', `/register/${c7.id}/${today.slice(0, 7)}`)).json;
ok(reg.rows.find((r) => r.id === s1.id).days[today] === 'L', 'correction applied and on register');
const prof = (await S(adminA, 'GET', `/students/${s1.id}`)).json;
ok(prof.history.some((h) => h.action === 'attendance.correct'), 'correction is in change history');

console.log('Fees');
const setup = (await S(adminA, 'GET', '/fees/setup')).json;
const tuition = setup.heads.find((h) => h.name === 'Tuition');
await S(adminA, 'POST', '/fees/plans', { plans: [{ class_id: c7.id, head_id: tuition.id, amount: 3000 }, { class_id: c8.id, head_id: tuition.id, amount: 3500 }] });
await S(adminA, 'POST', `/students/${s2.id}/discounts`, { kind: 'sibling', amount: 500 });
const gen = (await S(adminA, 'POST', '/fees/generate', { month: today.slice(0, 7) })).json;
ok(gen.created === 3, 'monthly vouchers generated');
ok((await S(adminA, 'POST', '/fees/generate', { month: today.slice(0, 7) })).json.created === 0, 'voucher generation is idempotent');
const p1 = (await S(parent1, 'GET', `/students/${s1.id}`)).json;
const v1 = p1.vouchers[0];
ok(v1.total === 3000, 'voucher amount from class fee plan');
const p2 = (await S(parent1, 'GET', `/students/${s2.id}`)).json;
ok(p2.vouchers[0].total === 3000, 'sibling discount applied');
const fd = new FormData();
fd.set('voucher_id', v1.id); fd.set('method', 'easypaisa'); fd.set('amount', '3000'); fd.set('txn_id', 'EP' + uniq);
fd.set('slip', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'slip.png');
const pay = await S(parent1, 'POST', '/payments', fd, true);
ok(pay.status === 200, 'parent uploads Easypaisa slip');
const fd2 = new FormData(); for (const [k, v] of fd.entries()) fd2.set(k, v);
fd2.set('voucher_id', p2.vouchers[0].id);
ok((await S(parent1, 'POST', '/payments', fd2, true)).status === 409, 'duplicate transaction ID blocked');
ok((await S(parent1, 'POST', `/payments/${pay.json.id}/verify`)).status === 403, 'parent cannot verify own payment');
ok((await S(tok1, 'POST', `/payments/${pay.json.id}/verify`)).status === 403, 'class teacher cannot verify slips unless allowed');
const ver = await S(tokAcc, 'POST', `/payments/${pay.json.id}/verify`);
ok(ver.status === 200 && ver.json.receipt === 1, 'accountant verifies, receipt #1 issued');
const slipPath = (await S(adminA, 'GET', `/payments/${pay.json.id}`)).json.payment.slip_key.split('/').slice(1).join('/');
ok((await api(parent1, 'GET', '/files/' + slipPath)).status === 200, 'parent can open own slip');
ok((await api(tok2, 'GET', '/files/' + slipPath)).status === 403, 'subject teacher cannot open the slip');
ok((await api(adminB, 'GET', '/files/' + slipPath)).status === 404, 'other school cannot open the slip');
const cash = await S(tok2, 'POST', '/payments', { voucher_id: (await S(adminA, 'GET', `/students/${s3.id}`)).json.vouchers[0].id, method: 'cash_teacher', amount: 1000 });
ok(cash.status === 200, 'class teacher takes cash');
const held = (await S(tok2, 'GET', '/cash')).json;
ok(held.teachers[0]?.total === 1000, 'cash shows as held by teacher');
ok((await S(tok2, 'POST', '/cash/handover', { teacher_id: t2.id })).status === 403, 'teacher cannot confirm own handover');
ok((await S(tokAcc, 'POST', '/cash/handover', { teacher_id: t2.id, amount: 1000 })).json.total === 1000, 'accountant confirms handover');
ok((await S(tok2, 'GET', '/cash')).json.teachers.length === 0, 'teacher cash back to zero');
const unpaid = (await S(tok2, 'GET', '/fees/unpaid')).json;
ok(unpaid.length === 2 && unpaid.every((r) => r.class_name === '8-A'), 'class teacher sees only own class unpaid list');
ok((await S(adminA, 'POST', `/payments/${pay.json.id}/cancel`, { reason: 'Bank reversed' })).status === 200, 'main admin cancels receipt with reason');
ok((await S(adminA, 'GET', `/students/${s1.id}`)).json.vouchers[0].status === 'unpaid', 'voucher back to unpaid after cancellation');

console.log('Notices, threads, results');
ok((await S(tok2, 'POST', '/notices', { audience: 'class', target_id: c7.id, title: 'Maths test', body: 'Monday' })).status === 200, 'subject teacher posts to a class they teach');
ok((await S(tok1, 'POST', '/notices', { audience: 'class', target_id: c8.id, title: 'x', body: 'y' })).status === 403, 'teacher cannot post to a class they do not teach');
ok((await S(parent1, 'GET', '/notices')).json.some((n) => n.title === 'Maths test'), 'parent sees class notice');
ok((await S(parent1, 'POST', `/threads/${s1.id}`, { body: 'Salam, is homework due?' })).status === 200, 'parent writes in student thread');
ok((await S(tok1, 'GET', `/threads/${s1.id}`)).json.messages.length === 1, 'class teacher reads thread');
ok((await S(tokAcc, 'GET', `/threads/${s1.id}`)).status === 403, 'accountant has no thread access');
ok((await S(parent1, 'GET', `/threads/${s3.id}`)).status === 403, "parent cannot read another child's thread");
const rf = new FormData(); rf.set('title', 'Mid-term'); rf.append('files', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), `${s1.reg_no}.pdf`); rf.append('files', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'unknown.pdf');
const up = (await S(adminA, 'POST', '/results', rf, true)).json;
ok(up.results[0].ok && !up.results[1].ok, 'bulk results matched by registration number, unmatched flagged');
ok((await S(parent1, 'GET', `/students/${s1.id}`)).json.results.length === 0, 'result hidden until published');
await S(adminA, 'POST', '/results/publish', { class_id: c7.id, title: 'Mid-term' });
ok((await S(parent1, 'GET', `/students/${s1.id}`)).json.results.length === 1, 'result visible after publish');

console.log('Leaving and removed users');
const tTmp = (await S(adminA, 'POST', '/staff', { name: 'Leaving Teacher', email: `lv${uniq}@test.pk` })).json;
const tokLv = await login(`lv${uniq}@test.pk`);
ok((await S(tokLv, 'GET', '/me')).status === 200, 'teacher signed in');
await S(adminA, 'POST', `/staff/${tTmp.id}/deactivate`, { reason: 'resigned' });
ok((await S(tokLv, 'GET', '/me')).status === 401, "a removed user's old session is refused");
const p3 = await login(phone(2));
await S(adminA, 'POST', `/students/${s3.id}/left`, { reason: 'transferred' });
ok((await S(p3, 'GET', '/me')).status === 401, 'parent signed out once no child is active');
ok((await S(adminA, 'GET', `/students/${s3.id}`)).json.vouchers.length === 1, 'history kept after leaving');
await S(adminA, 'POST', `/students/${s3.id}/restore`, {});
ok((await S(adminA, 'GET', '/students')).json.some((s) => s.id === s3.id), 'student restored');
await api(parent1, 'POST', '/api/auth/logout');
ok((await S(parent1, 'GET', '/me')).status === 401, 'signed-out session refused');

console.log('Teacher adds a student for confirmation');
await S(adminA, 'POST', '/settings', { settings: { teacher_add_students: '1' } });
const pend = (await S(tok1, 'POST', '/students', { name: 'New Kid', father_name: 'Someone', class_id: c7.id, parent_phone: phone(3) })).json;
ok(pend.status === 'pending', 'teacher-added student awaits confirmation');
ok((await S(tok1, 'POST', '/students', { name: 'X', father_name: 'Y', class_id: c8.id, parent_phone: phone(4) })).status === 403, 'teacher cannot add to another class');
ok((await S(tok1, 'POST', `/students/${pend.id}/confirm`)).status === 403, 'teacher cannot confirm');
ok((await S(adminA, 'POST', `/students/${pend.id}/confirm`)).status === 200, 'admin confirms');

console.log('WhatsApp / SMS from admin phone');
const ob = (await S(adminA, 'GET', '/outbox')).json;
ok(ob.some((r) => r.phone === phone(1) && /Absent today/.test(r.text)), 'absence alert queued for parent phone');
ok((await S(tok1, 'GET', '/outbox')).status === 403, 'teacher cannot open the send list');
const qd = (await S(adminA, 'POST', '/outbox/compose', { to: 'parents', title: 'Holiday', text: 'School closed Friday' })).json;
ok(qd.queued >= 2, 'admin composes message to all parents');
await S(adminA, 'POST', '/outbox/mark', { ids: [ob[0].id], channel: 'whatsapp' });
ok((await S(adminA, 'GET', '/outbox?status=sent')).json.some((r) => r.id === ob[0].id), 'marked as sent');

console.log('Billing and owner panel');
const bill = (await api(adminA, 'GET', '/api/billing')).json;
ok(bill.status === 'trial', 'school is on trial');
const inv = (await api(adminA, 'POST', '/api/billing/invoice', { cycle: 'monthly' })).json;
ok(inv.amount === 1000 && inv.tier === 'starter', 'invoice sized to Starter tier');
const bf = new FormData(); bf.set('invoice_id', inv.id); bf.set('txn_id', 'JC' + uniq); bf.set('amount', '1000');
ok((await api(tok1, 'POST', '/api/billing/slip', bf, true)).status === 403, 'only main admin uploads billing slips');
ok((await api(adminA, 'POST', '/api/billing/slip', bf, true)).status === 200, 'main admin uploads billing slip');
const ownerTok = await login('owner@example.com');
const ov = (await api(ownerTok, 'GET', '/api/owner/overview')).json;
const slip = ov.slips.find((s) => s.txn_id === 'JC' + uniq);
ok(!!slip, 'owner sees slip waiting');
ok((await api(adminA, 'GET', '/api/owner/overview')).status === 401, 'school admin cannot open owner panel');
ok((await api(ownerTok, 'GET', `/api/s/students`)).status === 401, 'owner has no access to school records');
await api(ownerTok, 'POST', `/api/owner/slips/${slip.id}/confirm`);
ok((await api(adminA, 'GET', '/api/billing')).json.status === 'active', 'school active after owner confirms');
await api(ownerTok, 'POST', `/api/owner/schools/${ov.schools.find((s) => s.name === 'Alpha School' && s.id).id}`, { status: 'paused' });
const paused = await S(adminA, 'POST', '/students', { name: 'Z', father_name: 'Z', class_id: c7.id, parent_phone: phone(5) });
ok(paused.status === 402, 'paused school cannot add students');
ok((await S(adminA, 'GET', '/students')).status === 200, 'paused school can still view');
ok((await api(adminA, 'GET', '/api/export')).status === 200, 'paused school can still export');

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
