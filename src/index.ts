import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Env, Ctx, now, rid, sha256, normId, pkt, addDays, addMonths, HttpError, fail } from './util';
export { SchoolDO } from './school';

type Sess = { school_id: string; kind: string; ref_id: string; token_hash: string };
type V = { Bindings: Env; Variables: { sess: Sess } };
const app = new Hono<V>();

const SESSION_DAYS = 30;
const OTP_MINUTES = 10;
const OTP_ATTEMPTS = 5;

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: 'Something went wrong' }, 500);
});

// ---------- helpers ----------
const school = (env: Env, id: string) => env.SCHOOL.get(env.SCHOOL.idFromName(id));

async function planFor(env: Env, s: any) {
  const plan: any = await env.DB.prepare('SELECT * FROM plans WHERE tier=?').bind(s.tier).first();
  return plan;
}

async function ctxFor(env: Env, schoolId: string, kind: 'staff' | 'guardian', refId: string): Promise<Ctx> {
  const s: any = await env.DB.prepare('SELECT * FROM schools WHERE id=?').bind(schoolId).first();
  if (!s) fail(401, 'School not found');
  const p = await planFor(env, s);
  return {
    schoolId, kind, refId, schoolStatus: s.status,
    studentCap: s.tier === 'trial' ? 50 : 1e9, // paid schools keep working past their tier; it is resized at renewal
    storageLimitBytes: Math.round((p.storage_gb + s.extra_storage_gb) * 1024 ** 3),
  };
}

async function callSchool(env: Env, ctx: Ctx, path: string, init: RequestInit = {}): Promise<Response> {
  const h = new Headers(init.headers);
  h.set('x-ctx', JSON.stringify(ctx));
  return school(env, ctx.schoolId).fetch('https://school' + path, { ...init, headers: h });
}
async function callSchoolJson(env: Env, ctx: Ctx, path: string, body?: any): Promise<any> {
  const r = await callSchool(env, ctx, path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const j: any = await r.json();
  if (!r.ok) fail(r.status, j.error || 'error');
  return j;
}
const systemCtx = (env: Env, id: string) => ctxFor(env, id, 'staff', 'system');

async function newOtp(env: Env, identifier: string, purpose: string, payload?: any) {
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await env.DB.prepare('INSERT OR REPLACE INTO otps (identifier, code_hash, expires_at, attempts, purpose, payload) VALUES (?,?,?,?,?,?)')
    .bind(identifier, await sha256(identifier + ':' + code), Date.now() + OTP_MINUTES * 60000, 0, purpose, payload ? JSON.stringify(payload) : null).run();
  // Production: send `code` by email (e.g. Resend / MailChannels) or SMS here.
  console.log(`[otp] ${identifier}: ${code}`);
  return env.DEV_OTP === '1' ? { devCode: code } : {};
}

async function checkOtp(env: Env, identifier: string, code: string, purpose: string, consume = true) {
  const o: any = await env.DB.prepare('SELECT * FROM otps WHERE identifier=?').bind(identifier).first();
  if (!o || o.purpose !== purpose || o.expires_at < Date.now()) fail(400, 'Code expired. Ask for a new one.');
  if (o.attempts >= OTP_ATTEMPTS) fail(429, 'Too many attempts. Ask for a new code.');
  if ((await sha256(identifier + ':' + String(code).trim())) !== o.code_hash) {
    await env.DB.prepare('UPDATE otps SET attempts=attempts+1 WHERE identifier=?').bind(identifier).run();
    fail(400, 'Wrong code');
  }
  if (consume) await env.DB.prepare('DELETE FROM otps WHERE identifier=?').bind(identifier).run();
  return o;
}

async function createSession(c: any, schoolId: string, kind: string, refId: string, label: string) {
  const token = rid(32);
  const device = (c.req.header('user-agent') || 'unknown').slice(0, 120);
  const t = now();
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  const seen = await c.env.DB.prepare('SELECT 1 FROM sessions WHERE school_id=? AND kind=? AND ref_id=? AND device=? LIMIT 1').bind(schoolId, kind, refId, device).first();
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, school_id, kind, ref_id, device, label, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(await sha256(token), schoolId, kind, refId, device, label, t, t, exp).run();
  setCookie(c, 'sid', token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
  if (!seen && kind !== 'owner') {
    const ctx = await systemCtx(c.env, schoolId);
    await callSchoolJson(c.env, ctx, '/internal/notify-admins', { title: 'New device sign-in', body: `${label} signed in on a new device: ${device.slice(0, 60)}` }).catch(() => {});
  }
  return token;
}

async function loadSession(c: any): Promise<Sess | null> {
  const auth = c.req.header('authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : getCookie(c, 'sid');
  if (!token) return null;
  const h = await sha256(token);
  const s: any = await c.env.DB.prepare('SELECT * FROM sessions WHERE token_hash=? AND revoked=0 AND expires_at>?').bind(h, now()).first();
  if (!s) return null;
  if (Date.now() - Date.parse(s.last_seen) > 3600e3) await c.env.DB.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').bind(now(), h).run();
  return s;
}

const requireSession = (kinds: string[]) => async (c: any, next: any) => {
  const s = await loadSession(c);
  if (!s || !kinds.includes(s.kind)) return c.json({ error: 'Please sign in' }, 401);
  c.set('sess', s);
  await next();
};

// ---------- auth ----------
app.post('/api/auth/start', async (c) => {
  const { identifier } = await c.req.json<any>();
  const id = normId(identifier);
  if (!id) fail(400, 'Enter your email or phone number');
  const isOwner = id === normId(c.env.OWNER_EMAIL);
  const found = await c.env.DB.prepare('SELECT 1 FROM logins WHERE identifier=? LIMIT 1').bind(id).first();
  // Same answer whether or not the number is registered, so nobody can probe who is a parent.
  const extra = isOwner || found ? await newOtp(c.env, id, 'login') : {};
  return c.json({ ok: true, message: 'If this email or phone is registered with a school, a code has been sent.', ...extra });
});

app.post('/api/auth/verify', async (c) => {
  const { identifier, code, pick } = await c.req.json<any>();
  const id = normId(identifier);
  if (id === normId(c.env.OWNER_EMAIL)) {
    await checkOtp(c.env, id, code, 'login');
    const token = await createSession(c, '', 'owner', 'owner', 'Owner');
    return c.json({ ok: true, kind: 'owner', token });
  }
  const rows = (await c.env.DB.prepare(
    'SELECT l.*, s.name AS school_name FROM logins l JOIN schools s ON s.id=l.school_id WHERE l.identifier=?').bind(id).all()).results as any[];
  if (rows.length > 1 && (pick === undefined || pick === null)) {
    await checkOtp(c.env, id, code, 'login', false);
    return c.json({ choose: rows.map((r, i) => ({ pick: i, label: `${r.school_name} — ${r.kind === 'guardian' ? 'Parent' : 'Staff'}` })) });
  }
  await checkOtp(c.env, id, code, 'login');
  const r = rows[Number(pick ?? 0)];
  if (!r) fail(400, 'This email or phone is not registered with any school');
  const ctx = await ctxFor(c.env, r.school_id, r.kind, r.ref_id);
  const me = await callSchoolJson(c.env, ctx, '/me');
  const token = await createSession(c, r.school_id, r.kind, r.ref_id, me.name);
  return c.json({ ok: true, kind: r.kind, token });
});

app.post('/api/auth/logout', async (c) => {
  const s = await loadSession(c);
  if (s) await c.env.DB.prepare('UPDATE sessions SET revoked=1 WHERE token_hash=?').bind(s.token_hash).run();
  deleteCookie(c, 'sid', { path: '/' });
  return c.json({ ok: true });
});

// ---------- school sign-up (free trial, no approval) ----------
app.post('/api/signup/start', async (c) => {
  const b = await c.req.json<any>();
  const email = normId(b.email);
  if (!b.school_name || !b.admin_name || !email.includes('@')) fail(400, 'School name, your name and email are required');
  const extra = await newOtp(c.env, email, 'signup', { school_name: b.school_name, admin_name: b.admin_name, phone: normId(b.phone), kind: b.kind === 'academy' ? 'academy' : 'school' });
  return c.json({ ok: true, message: 'Enter the code sent to your email.', ...extra });
});

app.post('/api/signup/verify', async (c) => {
  const { email, code } = await c.req.json<any>();
  const id = normId(email);
  const o = await checkOtp(c.env, id, code, 'signup');
  const p = JSON.parse(o.payload);
  const schoolId = await createSchool(c.env, { name: p.school_name, kind: p.kind, admin: { name: p.admin_name, email: id, phone: p.phone } });
  const ctx = await ctxFor(c.env, schoolId, 'staff', 'x');
  const me = await callSchoolJson(c.env, { ...ctx, refId: 'system' }, '/internal/main-admin', {});
  const token = await createSession(c, schoolId, 'staff', me.id, p.admin_name);
  return c.json({ ok: true, token, schoolId });
});

async function createSchool(env: Env, b: { name: string; kind?: string; admin: { name: string; email: string; phone?: string } }) {
  const id = 'sch_' + rid(12);
  const today = pkt().date;
  await env.DB.prepare('INSERT INTO schools (id, name, kind, tier, status, renews_at, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, b.name, b.kind || 'school', 'trial', 'trial', addDays(today, 14), now()).run();
  const ctx = await systemCtx(env, id);
  await callSchoolJson(env, ctx, '/internal/init', { name: b.name, admin: b.admin });
  return id;
}

// ---------- school API: everything goes through the school's own object ----------
app.all('/api/s/*', requireSession(['staff', 'guardian']), async (c) => {
  const s = c.get('sess');
  const ctx = await ctxFor(c.env, s.school_id, s.kind as any, s.ref_id);
  const url = new URL(c.req.url);
  const path = url.pathname.slice('/api/s'.length) + url.search;
  if (path.startsWith('/internal')) fail(404, 'Not found');
  return callSchool(c.env, ctx, path, { method: c.req.method, headers: c.req.raw.headers, body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body });
});

app.get('/files/*', requireSession(['staff', 'guardian']), async (c) => {
  const s = c.get('sess');
  const ctx = await ctxFor(c.env, s.school_id, s.kind as any, s.ref_id);
  return callSchool(c.env, ctx, new URL(c.req.url).pathname);
});

// ---------- signed-in devices (main admin) ----------
async function requireMainAdmin(c: any) {
  const s = c.get('sess');
  const ctx = await ctxFor(c.env, s.school_id, s.kind, s.ref_id);
  const me = await callSchoolJson(c.env, ctx, '/me');
  if (!me.isMainAdmin) fail(403, 'Only the main admin can do this');
  return { ctx, me };
}

app.get('/api/devices', requireSession(['staff']), async (c) => {
  await requireMainAdmin(c);
  const r = await c.env.DB.prepare('SELECT substr(token_hash,1,16) AS id, kind, label, device, created_at, last_seen FROM sessions WHERE school_id=? AND revoked=0 AND expires_at>? ORDER BY last_seen DESC LIMIT 300')
    .bind(c.get('sess').school_id, now()).all();
  return c.json(r.results);
});
app.post('/api/devices/:id/signout', requireSession(['staff']), async (c) => {
  await requireMainAdmin(c);
  await c.env.DB.prepare("UPDATE sessions SET revoked=1 WHERE school_id=? AND substr(token_hash,1,16)=?").bind(c.get('sess').school_id, c.req.param('id')).run();
  return c.json({ ok: true });
});

// ---------- billing for the main admin ----------
app.get('/api/billing', requireSession(['staff', 'guardian']), async (c) => {
  const s = c.get('sess');
  const sc: any = await c.env.DB.prepare('SELECT * FROM schools WHERE id=?').bind(s.school_id).first();
  const plan = await planFor(c.env, sc);
  const base = { status: sc.status, renews_at: sc.renews_at, grace_until: addDays(sc.renews_at, sc.grace_days), tier: sc.tier, school_name: sc.name };
  if (s.kind !== 'staff') return c.json(base);
  const ctx = await ctxFor(c.env, s.school_id, 'staff', s.ref_id);
  const me = await callSchoolJson(c.env, ctx, '/me');
  if (!me.isMainAdmin) return c.json(base);
  const invoices = (await c.env.DB.prepare('SELECT * FROM invoices WHERE school_id=? ORDER BY created_at DESC LIMIT 24').bind(s.school_id).all()).results;
  const slips = (await c.env.DB.prepare('SELECT * FROM billing_slips WHERE school_id=? ORDER BY created_at DESC LIMIT 24').bind(s.school_id).all()).results;
  const plans = (await c.env.DB.prepare('SELECT * FROM plans ORDER BY sort').all()).results;
  const announcements = (await c.env.DB.prepare('SELECT * FROM announcements WHERE school_id IS NULL OR school_id=? ORDER BY created_at DESC LIMIT 5').bind(s.school_id).all()).results;
  const support = await c.env.DB.prepare('SELECT granted_until FROM support_access WHERE school_id=?').bind(s.school_id).first();
  return c.json({ ...base, cycle: sc.cycle, plan, plans, invoices, slips, students: sc.students, storage_bytes: sc.storage_bytes,
    storage_limit_bytes: ctx.storageLimitBytes, accounts: c.env.PAYMENT_ACCOUNTS, announcements, support });
});

app.post('/api/billing/invoice', requireSession(['staff']), async (c) => {
  await requireMainAdmin(c);
  const { cycle } = await c.req.json<any>().catch(() => ({}));
  const sid = c.get('sess').school_id;
  if (cycle === 'monthly' || cycle === 'yearly') await c.env.DB.prepare('UPDATE schools SET cycle=? WHERE id=?').bind(cycle, sid).run();
  await c.env.DB.prepare("UPDATE invoices SET status='cancelled' WHERE school_id=? AND status='open'").bind(sid).run();
  const inv = await makeInvoice(c.env, sid);
  return c.json(inv);
});

app.post('/api/billing/slip', requireSession(['staff']), async (c) => {
  const { ctx } = await requireMainAdmin(c);
  const form = await c.req.formData();
  const inv: any = await c.env.DB.prepare("SELECT * FROM invoices WHERE id=? AND school_id=? AND status='open'").bind(form.get('invoice_id'), ctx.schoolId).first();
  if (!inv) fail(400, 'Invoice not found or already paid');
  const txn = String(form.get('txn_id') || '').trim().toUpperCase();
  if (!txn) fail(400, 'Transaction ID is required');
  const dup = await c.env.DB.prepare("SELECT 1 FROM billing_slips WHERE txn_id=? AND status!='rejected'").bind(txn).first();
  if (dup) fail(409, 'This transaction ID has already been used');
  const file = form.get('file') as unknown as File | null;
  let key: string | null = null;
  if (file && typeof file === 'object' && file.size) {
    if (file.size > 5 * 1024 * 1024) fail(400, 'File too large (max 5 MB)');
    key = `platform/${ctx.schoolId}/slips/${rid(12)}-${file.name.replace(/[^\w.-]/g, '_')}`;
    await c.env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  }
  await c.env.DB.prepare('INSERT INTO billing_slips (id, invoice_id, school_id, txn_id, amount, file_key, created_at) VALUES (?,?,?,?,?,?,?)')
    .bind('bs_' + rid(10), inv.id, ctx.schoolId, txn, Number(form.get('amount') || inv.amount), key, now()).run();
  return c.json({ ok: true });
});

app.post('/api/billing/support-access', requireSession(['staff']), async (c) => {
  await requireMainAdmin(c);
  const { hours } = await c.req.json<any>();
  const h = Math.max(0, Math.min(72, Number(hours) || 0));
  const sid = c.get('sess').school_id;
  if (!h) await c.env.DB.prepare('DELETE FROM support_access WHERE school_id=?').bind(sid).run();
  else await c.env.DB.prepare('INSERT OR REPLACE INTO support_access VALUES (?,?)').bind(sid, new Date(Date.now() + h * 3600e3).toISOString()).run();
  return c.json({ ok: true });
});

app.get('/api/export', requireSession(['staff']), async (c) => {
  const { ctx } = await requireMainAdmin(c);
  return callSchool(c.env, ctx, '/export');
});

// ---------- billing engine ----------
async function tierFor(env: Env, students: number) {
  return (await env.DB.prepare("SELECT * FROM plans WHERE tier NOT IN ('trial') AND max_students>=? ORDER BY sort LIMIT 1").bind(students).first()) as any;
}

async function makeInvoice(env: Env, schoolId: string) {
  const s: any = await env.DB.prepare('SELECT * FROM schools WHERE id=?').bind(schoolId).first();
  const p = await tierFor(env, s.students);
  const tier = s.tier !== 'trial' && s.price_override != null ? s.tier : p.tier;
  const plan: any = s.tier !== 'trial' && s.price_override != null ? await planFor(env, s) : p;
  let amount = s.price_override ?? (s.cycle === 'yearly' ? plan.yearly : plan.monthly);
  const today = pkt().date;
  const start = s.status === 'paused' || s.renews_at < today ? today : s.renews_at;
  const end = s.cycle === 'yearly' ? addMonths(start, 12) : addMonths(start, 1);
  if (s.extra_storage_gb) amount += (s.extra_storage_gb / 5) * (s.cycle === 'yearly' ? 2000 : 200);
  const inv = { id: 'inv_' + rid(10), school_id: schoolId, tier, cycle: s.cycle, amount, period_start: start, period_end: end,
    note: `${s.students} active students → ${plan.tier} tier`, status: 'open', created_at: now() };
  await env.DB.prepare('INSERT INTO invoices (id, school_id, tier, cycle, amount, period_start, period_end, note, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(inv.id, inv.school_id, inv.tier, inv.cycle, inv.amount, inv.period_start, inv.period_end, inv.note, inv.status, inv.created_at).run();
  return inv;
}

async function confirmSlip(env: Env, slipId: string) {
  const sl: any = await env.DB.prepare("SELECT * FROM billing_slips WHERE id=? AND status='submitted'").bind(slipId).first();
  if (!sl) fail(404, 'Slip not found');
  const inv: any = await env.DB.prepare('SELECT * FROM invoices WHERE id=?').bind(sl.invoice_id).first();
  await env.DB.batch([
    env.DB.prepare("UPDATE billing_slips SET status='verified', decided_at=? WHERE id=?").bind(now(), slipId),
    env.DB.prepare("UPDATE invoices SET status='paid' WHERE id=?").bind(inv.id),
    env.DB.prepare("UPDATE schools SET status='active', tier=?, cycle=?, renews_at=? WHERE id=?").bind(inv.tier, inv.cycle, inv.period_end, inv.school_id),
  ]);
  const ctx = await systemCtx(env, inv.school_id);
  await callSchoolJson(env, ctx, '/internal/notify-admins', { title: 'Payment confirmed', body: `Receipt: Rs ${inv.amount} received for ${inv.period_start} to ${inv.period_end}. Thank you.`, mainOnly: true }).catch(() => {});
}

async function runBilling(env: Env) {
  const today = pkt().date;
  const schools = (await env.DB.prepare('SELECT * FROM schools').all()).results as any[];
  for (const s of schools) {
    try {
      const ctx = await systemCtx(env, s.id);
      const st = await callSchoolJson(env, ctx, '/internal/cron', {});
      await env.DB.prepare('UPDATE schools SET students=?, storage_bytes=? WHERE id=?').bind(st.students, st.storage_bytes, s.id).run();
      s.students = st.students;
      const open = await env.DB.prepare("SELECT 1 FROM invoices WHERE school_id=? AND status='open'").bind(s.id).first();
      const daysLeft = Math.round((Date.parse(s.renews_at) - Date.parse(today)) / 864e5);
      const notify = (title: string, body: string) => callSchoolJson(env, ctx, '/internal/notify-admins', { title, body, mainOnly: true, once: `${title}:${today}` }).catch(() => {});
      if (!open && daysLeft <= 7 && s.tier !== 'custom') {
        const inv = await makeInvoice(env, s.id);
        await notify('Invoice ready', `${inv.note}. Amount Rs ${inv.amount} for ${inv.period_start} to ${inv.period_end}. Pay by Easypaisa/JazzCash and upload the slip under Billing.`);
      }
      if (s.cycle === 'yearly' && daysLeft === 30) await notify('Renewal in 30 days', `Your yearly plan renews on ${s.renews_at}.`);
      if (daysLeft === 5 || daysLeft === 0) await notify('Plan renewal', `Your plan renews on ${s.renews_at}. Please upload your payment slip under Billing.`);
      let status = s.status;
      if (daysLeft < 0) status = -daysLeft <= s.grace_days ? 'grace' : 'paused';
      if (status !== s.status) {
        await env.DB.prepare('UPDATE schools SET status=? WHERE id=?').bind(status, s.id).run();
        if (status === 'paused') await notify('School paused', 'Payment was not received. You can still view and export everything; upload your slip to restore.');
      }
    } catch (e) { console.error('billing', s.id, e); }
  }
}

// ---------- owner panel ----------
const owner = new Hono<V>();
owner.use('*', requireSession(['owner']));
owner.get('/overview', async (c) => {
  const schools = (await c.env.DB.prepare(`SELECT s.*, (SELECT COUNT(*) FROM billing_slips b WHERE b.school_id=s.id AND b.status='submitted') AS slips_waiting,
     (SELECT granted_until FROM support_access a WHERE a.school_id=s.id) AS support_until FROM schools s ORDER BY s.created_at DESC`).all()).results as any[];
  const slips = (await c.env.DB.prepare(`SELECT b.*, s.name AS school_name, i.amount AS invoice_amount, i.period_start, i.period_end, i.tier
     FROM billing_slips b JOIN schools s ON s.id=b.school_id JOIN invoices i ON i.id=b.invoice_id WHERE b.status='submitted' ORDER BY b.created_at`).all()).results;
  const month = pkt().month;
  const income: any = await c.env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status='paid' AND substr(created_at,1,7)=? THEN amount END),0) AS collected,
     COALESCE(SUM(CASE WHEN status='open' THEN amount END),0) AS expected FROM invoices`).bind(month).first();
  const plans = (await c.env.DB.prepare('SELECT * FROM plans ORDER BY sort').all()).results;
  const today = pkt().date;
  return c.json({ schools, slips, income, plans,
    byStatus: schools.reduce((a: any, s) => ((a[s.status] = (a[s.status] || 0) + 1), a), {}),
    renewalsThisWeek: schools.filter((s) => s.renews_at >= today && s.renews_at <= addDays(today, 7)),
    trialsEnding: schools.filter((s) => s.status === 'trial' && s.renews_at <= addDays(today, 7)) });
});
owner.post('/slips/:id/confirm', async (c) => { await confirmSlip(c.env, c.req.param('id')); return c.json({ ok: true }); });
owner.post('/slips/:id/reject', async (c) => {
  const { reason } = await c.req.json<any>();
  if (!reason) fail(400, 'A reason is required');
  const sl: any = await c.env.DB.prepare('SELECT * FROM billing_slips WHERE id=?').bind(c.req.param('id')).first();
  if (!sl) fail(404, 'Not found');
  await c.env.DB.prepare("UPDATE billing_slips SET status='rejected', reason=?, decided_at=? WHERE id=?").bind(reason, now(), sl.id).run();
  const ctx = await systemCtx(c.env, sl.school_id);
  await callSchoolJson(c.env, ctx, '/internal/notify-admins', { title: 'Payment slip rejected', body: `Reason: ${reason}. Please upload again under Billing.`, mainOnly: true }).catch(() => {});
  return c.json({ ok: true });
});
owner.get('/slips/:id/file', async (c) => {
  const sl: any = await c.env.DB.prepare('SELECT file_key FROM billing_slips WHERE id=?').bind(c.req.param('id')).first();
  const o = sl?.file_key && (await c.env.FILES.get(sl.file_key));
  if (!o) fail(404, 'No file');
  return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'application/octet-stream' } });
});
owner.post('/schools', async (c) => {
  const b = await c.req.json<any>();
  if (!b.name || !b.admin_name || !b.admin_email) fail(400, 'Name, admin name and admin email are required');
  const id = await createSchool(c.env, { name: b.name, admin: { name: b.admin_name, email: normId(b.admin_email), phone: normId(b.admin_phone) } });
  return c.json({ id });
});
owner.post('/schools/:id', async (c) => {
  const b = await c.req.json<any>();
  const id = c.req.param('id');
  const allowed = ['tier', 'price_override', 'extra_storage_gb', 'grace_days', 'status', 'renews_at', 'cycle', 'launch_price_until'];
  for (const k of allowed) if (k in b) await c.env.DB.prepare(`UPDATE schools SET ${k}=? WHERE id=?`).bind(b[k] === '' ? null : b[k], id).run();
  return c.json({ ok: true });
});
owner.post('/announce', async (c) => {
  const b = await c.req.json<any>();
  if (!b.title) fail(400, 'Title required');
  await c.env.DB.prepare('INSERT INTO announcements VALUES (?,?,?,?,?)').bind('an_' + rid(8), b.school_id || null, b.title, b.body || '', now()).run();
  const targets = b.school_id ? [b.school_id] : ((await c.env.DB.prepare('SELECT id FROM schools').all()).results as any[]).map((r) => r.id);
  for (const t of targets) await callSchoolJson(c.env, await systemCtx(c.env, t), '/internal/notify-admins', { title: b.title, body: b.body || '', mainOnly: true }).catch(() => {});
  return c.json({ ok: true });
});
owner.post('/run-billing', async (c) => { await runBilling(c.env); return c.json({ ok: true }); });
app.route('/api/owner', owner);

app.get('/api/whoami', async (c) => {
  const s = await loadSession(c);
  if (!s) return c.json({ signedIn: false });
  if (s.kind === 'owner') return c.json({ signedIn: true, kind: 'owner', name: 'Owner' });
  const ctx = await ctxFor(c.env, s.school_id, s.kind as any, s.ref_id);
  const r = await callSchool(c.env, ctx, '/me');
  if (!r.ok) return c.json({ signedIn: false });
  return c.json({ signedIn: true, ...(await r.json<any>()), schoolStatus: ctx.schoolStatus });
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runBilling(env));
  },
} satisfies ExportedHandler<Env>;
