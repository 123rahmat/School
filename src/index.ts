import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Env, Ctx, now, rid, sha256, normId, pkt, addDays, addMonths, HttpError, fail } from './util';
export { SchoolDO } from './school';

type Sess = { school_id: string; kind: string; ref_id: string; token_hash: string };
type V = { Bindings: Env; Variables: { sess: Sess } };
const app = new Hono<V>();

const SESSION_DAYS = 30;
const SESSION_COOKIE = '__Host-inst_session';

app.use('*', async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/files/')) c.header('Cache-Control', 'no-store, private');
  const fetchSite = c.req.header('sec-fetch-site');
  if (fetchSite === 'cross-site') return c.json({ error: 'Cross-site requests are not allowed.' }, 403);
  const origin = c.req.header('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(c.req.url).origin) return c.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    } catch { return c.json({ error: 'Invalid request origin.' }, 403); }
  }
  await next();
});

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
    schoolId, kind, refId, institutionType: s.kind, schoolStatus: s.status,
    studentCap: Number(p?.max_students || 50),
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

async function createSession(c: any, schoolId: string, kind: string, refId: string, label: string): Promise<void> {
  const token = rid(32);
  const device = (c.req.header('user-agent') || 'unknown').slice(0, 120);
  const t = now();
  const exp = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  const seen = await c.env.DB.prepare('SELECT 1 FROM sessions WHERE school_id=? AND kind=? AND ref_id=? AND device=? LIMIT 1').bind(schoolId, kind, refId, device).first();
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, school_id, kind, ref_id, device, label, created_at, last_seen, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(await sha256(token), schoolId, kind, refId, device, label, t, t, exp).run();
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: SESSION_DAYS * 86400 });
  deleteCookie(c, 'sid', { path: '/' });
  if (!seen && kind !== 'owner') {
    const ctx = await systemCtx(c.env, schoolId);
    await callSchoolJson(c.env, ctx, '/internal/notify-admins', { title: 'New device sign-in', body: `${label} signed in on a new device: ${device.slice(0, 60)}` }).catch(() => {});
  }
}

async function loadSession(c: any): Promise<Sess | null> {
  const token = getCookie(c, SESSION_COOKIE);
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

// ---------- Google-only authentication ----------
async function verifyGoogleIdentity(env: Env, credential: unknown) {
  if (!env.GOOGLE_CLIENT_ID) fail(503, 'Google sign-in is not configured yet');
  const idToken = String(credential || '');
  if (!idToken || idToken.length > 10000) fail(401, 'Google sign-in failed');

  const response = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  const claims: any = await response.json().catch(() => ({}));
  const expiresAt = Number(claims.exp) * 1000;
  const issuerOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com';
  if (!response.ok || claims.aud !== env.GOOGLE_CLIENT_ID || !issuerOk ||
      String(claims.email_verified) !== 'true' || !claims.email ||
      !claims.sub || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    fail(401, 'Google sign-in failed. Please choose a verified Google account.');
  }
  return {
    email: normId(claims.email),
    name: String(claims.name || claims.given_name || claims.email).slice(0, 120),
    googleSubject: String(claims.sub),
  };
}

async function loginRows(env: Env, email: string) {
  return (await env.DB.prepare(
    'SELECT l.*, s.name AS school_name FROM logins l JOIN schools s ON s.id=l.school_id WHERE l.identifier=?'
  ).bind(email).all()).results as any[];
}

async function finishLogin(c: any, rows: any[], pick: any) {
  const r = rows[Number(pick ?? 0)];
  if (!r) fail(403, 'This Google email is not linked to an active institution account. Ask your institution administrator to add it.');
  const ctx = await ctxFor(c.env, r.school_id, r.kind, r.ref_id);
  const me = await callSchoolJson(c.env, ctx, '/me');
  await createSession(c, r.school_id, r.kind, r.ref_id, me.name);
  return c.json({ ok: true, kind: r.kind });
}

app.get('/api/config', (c) => c.json({
  googleClientId: c.env.GOOGLE_CLIENT_ID || null,
  contactEmail: c.env.PUBLIC_CONTACT_EMAIL || null,
}));

app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB.prepare('UPDATE sessions SET revoked=1 WHERE token_hash=?').bind(await sha256(token)).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  deleteCookie(c, 'sid', { path: '/' });
  return c.json({ ok: true });
});

app.post('/api/auth/google', async (c) => {
  const { credential, pick } = await c.req.json<any>();
  const identity = await verifyGoogleIdentity(c.env, credential);

  // The platform owner uses the same verified Google sign-in, with no email-code fallback.
  if (identity.email === normId(c.env.OWNER_EMAIL)) {
    await createSession(c, '', 'owner', 'owner', identity.name || 'Owner');
    return c.json({ ok: true, kind: 'owner' });
  }

  const rows = await loginRows(c.env, identity.email);
  if (!rows.length) fail(403, 'This Google email is not linked to an institution. Create an institution account or ask your institution administrator to register this exact email.');
  if (rows.length > 1 && (pick === undefined || pick === null)) {
    return c.json({ choose: rows.map((r, i) => ({
      pick: i, label: `${r.school_name} — ${r.kind === 'guardian' ? 'Parent' : 'Staff'}`,
    })) });
  }
  return finishLogin(c, rows, pick);
});

app.post('/api/signup/google', async (c) => {
  const { credential, school_name, admin_name, kind, phone } = await c.req.json<any>();
  const identity = await verifyGoogleIdentity(c.env, credential);
  if (identity.email === normId(c.env.OWNER_EMAIL)) fail(403, 'The platform owner account cannot register an institution.');
  const name = String(school_name || '').trim();
  const adminName = String(admin_name || identity.name || '').trim();
  const allowedKinds = new Set(['school', 'college', 'university', 'academy', 'training_institute', 'other']);
  const institutionKind = String(kind || '');
  if (!name || !adminName) fail(400, 'Institution name and administrator name are required.');
  if (!allowedKinds.has(institutionKind)) fail(400, 'Choose a supported institution category.');

  const schoolId = await createSchool(c.env, {
    name,
    kind: institutionKind,
    admin: { name: adminName, email: identity.email, phone: normId(phone) || '' },
  });
  const ctx = await ctxFor(c.env, schoolId, 'staff', 'system');
  const me = await callSchoolJson(c.env, ctx, '/internal/main-admin', {});
  await createSession(c, schoolId, 'staff', me.id, adminName);
  return c.json({ ok: true, kind: 'staff', schoolId });
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
  const storageRequests = (await c.env.DB.prepare('SELECT id, blocks, status, created_at, decided_at, decision_note FROM storage_requests WHERE school_id=? ORDER BY created_at DESC LIMIT 10').bind(s.school_id).all()).results;
  return c.json({ ...base, institution_kind: sc.kind, cycle: sc.cycle, plan, plans, invoices, slips, students: sc.students, storage_bytes: sc.storage_bytes,
    storage_limit_bytes: ctx.storageLimitBytes, accounts: c.env.PAYMENT_ACCOUNTS, announcements, support, storage_requests: storageRequests });
});

app.post('/api/billing/storage-request', requireSession(['staff']), async (c) => {
  const { ctx, me } = await requireMainAdmin(c);
  const { blocks, note } = await c.req.json<any>();
  const count = Number(blocks);
  if (!Number.isInteger(count) || count < 1 || count > 10) fail(400, 'Request between 1 and 10 storage blocks. Each block adds 5 GB.');
  const requestId = 'sr_' + rid(12);
  try {
    await c.env.DB.prepare('INSERT INTO storage_requests (id, school_id, requested_by, blocks, status, created_at, decision_note) VALUES (?,?,?,?,?,?,?)')
      .bind(requestId, ctx.schoolId, me.id, count, 'pending', now(), String(note || '').slice(0, 500)).run();
  } catch (error) {
    const existing = await c.env.DB.prepare("SELECT id FROM storage_requests WHERE school_id=? AND status='pending'").bind(ctx.schoolId).first();
    if (existing) fail(409, 'Your institution already has a pending storage request. Your platform owner will review it.');
    throw error;
  }
  return c.json({ ok: true, id: requestId, additional_gb: count * 5 });
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
  const schools = (await c.env.DB.prepare(`SELECT s.*, p.storage_gb AS base_storage_gb, p.sub_admins AS plan_sub_admins,
     (SELECT COUNT(*) FROM billing_slips b WHERE b.school_id=s.id AND b.status='submitted') AS slips_waiting,
     (SELECT granted_until FROM support_access a WHERE a.school_id=s.id) AS support_until
     FROM schools s LEFT JOIN plans p ON p.tier=s.tier ORDER BY s.created_at DESC`).all()).results as any[];
  const storageRequests = (await c.env.DB.prepare(`SELECT r.*, s.name AS institution_name, s.kind AS institution_kind, s.extra_storage_gb
     FROM storage_requests r JOIN schools s ON s.id=r.school_id WHERE r.status='pending' ORDER BY r.created_at ASC`).all()).results as any[];
  const slips = (await c.env.DB.prepare(`SELECT b.*, s.name AS school_name, i.amount AS invoice_amount, i.period_start, i.period_end, i.tier
     FROM billing_slips b JOIN schools s ON s.id=b.school_id JOIN invoices i ON i.id=b.invoice_id WHERE b.status='submitted' ORDER BY b.created_at`).all()).results;
  const month = pkt().month;
  const income: any = await c.env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status='paid' AND substr(created_at,1,7)=? THEN amount END),0) AS collected,
     COALESCE(SUM(CASE WHEN status='open' THEN amount END),0) AS expected FROM invoices`).bind(month).first();
  const plans = (await c.env.DB.prepare('SELECT * FROM plans ORDER BY sort').all()).results;
  const today = pkt().date;
  return c.json({ schools, slips, storageRequests, income, plans,
    byStatus: schools.reduce((a: any, s) => ((a[s.status] = (a[s.status] || 0) + 1), a), {}),
    renewalsThisWeek: schools.filter((s) => s.renews_at >= today && s.renews_at <= addDays(today, 7)),
    trialsEnding: schools.filter((s) => s.status === 'trial' && s.renews_at <= addDays(today, 7)) });
});
owner.post('/storage-requests/:id/approve', async (c) => {
  const id = c.req.param('id');
  const r: any = await c.env.DB.prepare("SELECT * FROM storage_requests WHERE id=? AND status='pending'").bind(id).first();
  if (!r) fail(404, 'Pending storage request not found');
  const results = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE schools SET extra_storage_gb=extra_storage_gb+? WHERE id=? AND EXISTS (SELECT 1 FROM storage_requests WHERE id=? AND status='pending')").bind(r.blocks * 5, r.school_id, id),
    c.env.DB.prepare("UPDATE storage_requests SET status='approved', decided_at=?, decision_note='Approved by platform owner' WHERE id=? AND status='pending'").bind(now(), id),
  ]);
  if (Number(results[0]?.meta?.changes || 0) !== 1) fail(409, 'This request has already been handled');
  const ctx = await systemCtx(c.env, r.school_id);
  await callSchoolJson(c.env, ctx, '/internal/notify-admins', { title: 'Extra storage approved', body: `Your request was approved. An additional ${r.blocks * 5} GB is now available.`, mainOnly: true }).catch(() => {});
  return c.json({ ok: true, added_gb: r.blocks * 5 });
});
owner.post('/storage-requests/:id/reject', async (c) => {
  const id = c.req.param('id');
  const { reason } = await c.req.json<any>();
  const note = String(reason || '').trim().slice(0, 500);
  if (!note) fail(400, 'Provide a reason for declining the request');
  const r: any = await c.env.DB.prepare("SELECT * FROM storage_requests WHERE id=? AND status='pending'").bind(id).first();
  if (!r) fail(404, 'Pending storage request not found');
  await c.env.DB.prepare("UPDATE storage_requests SET status='rejected', decided_at=?, decision_note=? WHERE id=? AND status='pending'").bind(now(), note, id).run();
  const ctx = await systemCtx(c.env, r.school_id);
  await callSchoolJson(c.env, ctx, '/internal/notify-admins', { title: 'Extra storage request update', body: `Your request was not approved: ${note}`, mainOnly: true }).catch(() => {});
  return c.json({ ok: true });
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
  if (!b.name || !b.admin_name || !b.admin_email) fail(400, 'Institution name, administrator name and email are required');
  const kinds = new Set(['school', 'college', 'university', 'academy', 'training_institute', 'other']);
  const kind = String(b.kind || 'school');
  if (!kinds.has(kind)) fail(400, 'Choose a supported institution category');
  const id = await createSchool(c.env, { name: String(b.name).trim(), kind, admin: { name: String(b.admin_name).trim(), email: normId(b.admin_email), phone: normId(b.admin_phone) } });
  return c.json({ id });
});
owner.post('/schools/:id', async (c) => {
  const b = await c.req.json<any>();
  const id = c.req.param('id');
  const existing = await c.env.DB.prepare('SELECT id FROM schools WHERE id=?').bind(id).first();
  if (!existing) fail(404, 'Institution not found');
  const allowed = ['name', 'kind', 'tier', 'price_override', 'extra_storage_gb', 'grace_days', 'status', 'renews_at', 'cycle', 'launch_price_until'];
  const kinds = new Set(['school', 'college', 'university', 'academy', 'training_institute', 'other']);
  if ('kind' in b && !kinds.has(String(b.kind))) fail(400, 'Choose a supported institution category');
  if ('extra_storage_gb' in b) {
    const gb = Number(b.extra_storage_gb);
    if (!Number.isFinite(gb) || gb < 0 || gb > 500 || gb % 5 !== 0) fail(400, 'Extra storage must be allocated in 5 GB blocks (maximum 500 GB).');
  }
  if ('tier' in b && !await c.env.DB.prepare('SELECT 1 FROM plans WHERE tier=?').bind(b.tier).first()) fail(400, 'Unknown plan');
  for (const k of allowed) if (k in b) {
    const value = b[k] === '' ? null : (k === 'name' ? String(b[k]).trim() : b[k]);
    await c.env.DB.prepare(`UPDATE schools SET ${k}=? WHERE id=?`).bind(value, id).run();
  }
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
  return c.json({ signedIn: true, schoolId: s.school_id, institutionType: ctx.institutionType, ...(await r.json<any>()), schoolStatus: ctx.schoolStatus });
});

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runBilling(env));
  },
} satisfies ExportedHandler<Env>;
