// School Manager — installable web app. Every screen reads data through /api; the server enforces all permissions.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => 'Rs ' + Math.round(Number(n) || 0).toLocaleString('en-PK');
const pktNow = () => new Date(Date.now() + 5 * 3600e3);
const today = () => pktNow().toISOString().slice(0, 10);
const thisMonth = () => today().slice(0, 7);
const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d) / 1000;
  const exact = d.toLocaleString('en-PK', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
  let rel = exact;
  if (diff < 60) rel = 'just now'; else if (diff < 3600) rel = Math.floor(diff / 60) + ' min ago'; else if (diff < 86400) rel = Math.floor(diff / 3600) + ' h ago';
  return `<span title="${esc(exact)}">${esc(rel)}</span>`;
};
const fmtDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-PK', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATUS = { P: 'Present', A: 'Absent', L: 'Late', V: 'Leave' };
const PAY_STATUS = { submitted: 'warn', verified: 'ok', rejected: 'bad', cancelled: 'bad' };
const VOUCHER_STATUS = { paid: 'ok', partial: 'warn', unpaid: 'bad', carried: 'info', settled: 'ok' };
const badge = (text, kind = '') => `<span class="badge ${kind}">${esc(text)}</span>`;

let ME = null;
let BILL = null;

// Payment accounts the admin has added (any company: Easypaisa, JazzCash, any bank…)
let ACCOUNTS = null;
async function loadAccounts(force) { if (!ACCOUNTS || force) ACCOUNTS = await S('/payment-accounts').catch(() => []); return ACCOUNTS; }
const accountsHtml = (list) => list && list.length
  ? `<div class="stack">${list.map((a) => `<div class="card" style="margin:0;padding:10px 12px"><b>${esc(a.company)}</b><div>Account name: ${esc(a.title || '–')}</div><div>Number: <b style="user-select:all">${esc(a.number)}</b>${a.branch ? `<div class="small muted">${esc(a.branch)}</div>` : ''}</div></div>`).join('')}</div>`
  : '<p class="small muted">The school has not added payment accounts yet. Please ask the school office.</p>';

// ---------- API ----------
async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
  if (opts.form) init.body = opts.form;
  else if (opts.body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
  const r = await fetch(path, init);
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (r.status === 401 && !path.startsWith('/api/auth') && !path.startsWith('/api/signup')) { ME = null; if (!opts.quiet) go('/login'); throw new Error('Please sign in'); }
  if (!r.ok) {
    const err = new Error((data && data.error) || (data && data.message) || 'Request failed');
    err.status = r.status; err.data = data; throw err;
  }
  return data;
}
const S = (p, o) => api('/api/s' + p, o);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 3200);
}
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) {
    if (e.data && e.data.needsConfirm) return { needsConfirm: true, message: e.data.message };
    toast(e.message); throw e;
  }
}

function modal(html, onMount) {
  $('#modal-box').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $$('[data-close]', $('#modal-box')).forEach((b) => b.onclick = closeModal);
  onMount && onMount($('#modal-box'));
}
function closeModal() { $('#modal').classList.add('hidden'); $('#modal-box').innerHTML = ''; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
function formData(form) { return Object.fromEntries(new FormData(form).entries()); }

function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const csv = (rows) => rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

// ---------- routing ----------
const routes = [];
const route = (pattern, fn) => routes.push([new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn]);
function go(path) { location.hash = '#' + path; }
function currentPath() { return (location.hash.slice(1) || '/').split('?')[0]; }
function query() { return Object.fromEntries(new URLSearchParams((location.hash.split('?')[1]) || '')); }

async function render() {
  const path = currentPath();
  if (!ME && !['/', '/login', '/signup'].includes(path)) {
    try { const w = await api('/api/whoami', { quiet: true }); if (w.signedIn) ME = w; } catch {}
    if (!ME) return go('/');
  }
  if (ME && ['/login', '/signup'].includes(path)) return go('/');
  if (ME && ME.kind === 'owner' && !path.startsWith('/owner') && path !== '/login') return go('/owner');
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      try { await fn(m.groups || {}); }
      catch (e) { if (e.message !== 'Please sign in') view(`<div class="banner bad">${esc(e.message)}</div>`); }
      return;
    }
  }
  view('<div class="center muted">Page not found</div>');
}
window.addEventListener('hashchange', render);

// ---------- layout ----------
function nav() {
  if (!ME) return '';
  const p = currentPath();
  const link = (href, label, extra = '') => `<a href="#${href}" class="${(href === '/' ? p === '/' : p.startsWith(href)) ? 'active' : ''}">${label}${extra}</a>`;
  const items = [];
  if (ME.kind === 'owner') items.push(link('/owner', 'Owner panel'));
  else if (ME.kind === 'guardian') {
    items.push(link('/', 'My children'), link('/notices', 'Notices'), link('/threads', 'Messages'));
  } else {
    items.push(link('/', ME.isAdmin ? 'Dashboard' : 'Today'));
    items.push(`<div class="group">People</div>`, link('/students', 'Students'));
    if (ME.isAdmin) items.push(link('/staff', 'Teachers & staff'));
    items.push(link('/classes', 'Classes'));
    items.push(`<div class="group">Daily work</div>`, link('/attendance', 'Attendance'));
    if (ME.canFees || ME.classTeacherOf.length) items.push(link('/fees', 'Fees'));
    items.push(link('/cash', 'Cash held'));
    items.push(link('/notices', 'Notices'));
    if (ME.subrole !== 'accountant' && ME.role !== 'subadmin') items.push(link('/threads', 'Messages'));
    if (ME.role === 'admin' || ME.subrole === 'office') items.push(link('/outbox', 'WhatsApp / SMS', ME.outbox ? ` <span class="badge warn">${ME.outbox}</span>` : ''));
    items.push(link('/results', 'Results'), link('/requests', 'Change requests'));
    if (ME.isAdmin) { items.push(`<div class="group">School</div>`, link('/settings', 'Settings')); }
    if (ME.isMainAdmin) items.push(link('/billing', 'Billing'));
  }
  items.push(`<div class="group">Me</div>`, link('/notifications', 'Notifications', ME.unread ? ` <span class="badge bad">${ME.unread}</span>` : ''), `<a href="#" id="logout">Sign out</a>`);
  return items.join('');
}

function view(html) {
  const owner = ME && ME.kind === 'owner';
  $('#app').innerHTML = `
  <div class="layout">
    <aside class="side" id="side">
      <div class="brand"><img src="/icon.svg" alt=""><span>${esc(owner ? 'Platform owner' : ME?.schoolName || 'School')}</span></div>
      <nav>${nav()}</nav>
      <div class="muted small" style="padding:12px 10px">${esc(ME?.name || '')}${ME?.role && ME.role !== 'parent' ? ' · ' + esc(ME.subrole || ME.role) : ''}</div>
    </aside>
    <div class="main">
      <div class="top">
        <button class="btn menu" id="menu" aria-label="Menu">☰</button>
        ${ME && ME.kind === 'staff' ? `<div class="search"><input id="q" type="search" placeholder="Search students or teachers — name, reg no, class, last 4 digits of phone" autocomplete="off"><div class="results hidden" id="qr"></div></div>` : '<div style="flex:1"></div>'}
        <button class="btn small hidden" id="install">Install app</button>
      </div>
      <div class="content">${billingBanner()}${html}</div>
    </div>
  </div>`;
  $('#menu').onclick = () => $('#side').classList.toggle('open');
  $$('#side nav a').forEach((a) => a.addEventListener('click', () => $('#side').classList.remove('open')));
  const lo = $('#logout'); if (lo) lo.onclick = async (e) => { e.preventDefault(); await api('/api/auth/logout', { body: {} }).catch(() => {}); ME = null; go('/login'); };
  setupSearch();
  setupInstall();
}

function billingBanner() {
  if (!ME || ME.kind === 'owner') return '';
  const st = ME.schoolStatus;
  if (st === 'paused') return `<div class="banner bad">The school is paused for non-payment. You can view and export data, but cannot add or change anything.${ME.isMainAdmin ? ' <a href="#/billing">Upload payment slip</a>' : ''}</div>`;
  if (!ME.isMainAdmin || !BILL) return '';
  if (st === 'grace') return `<div class="banner bad">Payment overdue. The school will pause on ${fmtDate(BILL.grace_until)}. <a href="#/billing">Pay now</a></div>`;
  const days = Math.round((new Date(BILL.renews_at) - new Date(today())) / 864e5);
  if (st === 'trial') return `<div class="banner info">Free trial: ${Math.max(0, days)} day(s) left (up to 50 students). <a href="#/billing">Choose a plan</a></div>`;
  if (days <= 5) return `<div class="banner warn">Your plan renews on ${fmtDate(BILL.renews_at)}. <a href="#/billing">Upload payment slip</a></div>`;
  return '';
}

function setupSearch() {
  const q = $('#q'); if (!q) return;
  const box = $('#qr'); let t;
  const recent = () => { try { return JSON.parse(localStorage.getItem('recent') || '[]'); } catch { return []; } };
  const showRecent = () => {
    const r = recent(); if (!r.length) return box.classList.add('hidden');
    box.innerHTML = '<div class="muted small" style="padding:6px 12px">Recently opened</div>' + r.map((x) => `<a href="#${esc(x.href)}">${esc(x.label)}</a>`).join('');
    box.classList.remove('hidden');
  };
  q.onfocus = () => { if (!q.value) showRecent(); };
  q.oninput = () => {
    clearTimeout(t);
    if (q.value.trim().length < 2) return showRecent();
    t = setTimeout(async () => {
      const r = await S('/search?q=' + encodeURIComponent(q.value.trim())).catch(() => ({ students: [], staff: [] }));
      box.innerHTML = r.students.map((s) => `<a href="#/student/${s.id}" data-label="${esc(s.name)} (${esc(s.reg_no)})"><b>${esc(s.name)}</b> s/o ${esc(s.father_name)} <span class="muted small">· ${esc(s.class_name)} · ${esc(s.reg_no)}${s.status !== 'active' ? ' · ' + esc(s.status) : ''}</span></a>`).join('')
        + r.staff.map((s) => `<a href="#/staff/${s.id}" data-label="${esc(s.name)} (teacher)"><b>${esc(s.name)}</b> <span class="muted small">· teacher${s.subjects ? ' · ' + esc(s.subjects) : ''}${s.active ? '' : ' · former'}</span></a>`).join('')
        || '<div class="muted" style="padding:10px 12px">No matches</div>';
      box.classList.remove('hidden');
      $$('a', box).forEach((a) => a.onclick = () => {
        const r2 = recent().filter((x) => x.href !== a.getAttribute('href').slice(1));
        r2.unshift({ href: a.getAttribute('href').slice(1), label: a.dataset.label });
        try { localStorage.setItem('recent', JSON.stringify(r2.slice(0, 8))); } catch {}
        box.classList.add('hidden'); q.value = '';
      });
    }, 200);
  };
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.classList.add('hidden'); });
}

let installEvt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; setupInstall(); setupLandingInstall(); });
function setupInstall() {
  const b = $('#install'); if (!b) return;
  b.classList.remove('hidden');
  b.onclick = async () => {
    if (!installEvt) return showInstallHelp();
    const prompt = installEvt;
    installEvt = null;
    try { await prompt.prompt(); await prompt.userChoice; } catch { showInstallHelp(); }
    setupInstall();
  };
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

async function refreshMe() {
  const w = await api('/api/whoami', { quiet: true });
  ME = w.signedIn ? w : null;
  if (ME && ME.isMainAdmin) BILL = await api('/api/billing').catch(() => null);
}

// ---------- sign in / sign up ----------
function authPage(inner) {
  $('#app').innerHTML = `<div class="auth"><a class="auth-home" href="#/" aria-label="Back to home">← School Manager</a><img class="logo" src="/icon.svg" alt=""><div class="card">${inner}</div></div>`;
}
function showAuthError(error, mode = 'login') {
  const message = $('#authmsg');
  const next = $('#authnext');
  const raw = String(error?.message || 'Google sign-in failed. Please try again.');
  if (message) message.textContent = raw;
  if (!next) return;
  next.innerHTML = '';
  if (mode === 'login' && /not registered|not linked|not found/i.test(raw)) {
    next.innerHTML = `<div class="auth-help"><b>This Google account is not linked to an institution yet.</b><p>Starting a new school or academy? Create an institution account with this Google account.</p><a class="btn primary" href="#/signup">Create an institution account</a><p class="small muted">Already belong to a school or academy? Ask its administrator to add this exact Google email to your staff or guardian profile.</p></div>`;
  } else if (/not configured/i.test(raw)) {
    next.innerHTML = '<div class="auth-help"><b>Google sign-in needs configuration.</b><p>The platform administrator must set GOOGLE_CLIENT_ID in the Cloudflare Worker production settings and redeploy.</p></div>';
  } else if (mode === 'signup') {
    next.innerHTML = '<div class="auth-help"><p>Already have an institution account? <a href="#/login">Sign in instead</a>.</p></div>';
  } else {
    next.innerHTML = '<div class="auth-help"><p>Use the Google account email your institution has registered. If the problem continues, ask the institution administrator to check your account email.</p></div>';
  }
}
async function mountGoogleButton(target, onCredential, buttonText = 'signin_with', mode = 'login') {
  const cfg = await api('/api/config').catch(() => ({}));
  if (!cfg.googleClientId) {
    showAuthError(new Error('Google sign-in is not configured yet.'), mode);
    target.innerHTML = '<p class="small muted">Google sign-in is temporarily unavailable.</p>';
    return;
  }
  try {
    if (!window.google?.accounts?.id) {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-google-identity]');
        if (existing) {
          if (window.google?.accounts?.id) return resolve();
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', reject, { once: true });
          return;
        }
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.googleIdentity = '1';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Google sign-in could not load. Check your connection, browser content blockers and Google OAuth origin settings.'));
        document.head.appendChild(script);
      });
    }
    if (!window.google?.accounts?.id) throw new Error('Google Identity Services loaded without its sign-in interface.');
    google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      callback: ({ credential }) => Promise.resolve(onCredential(credential)).catch((error) => showAuthError(error, mode)),
    });
    google.accounts.id.renderButton(target, { theme: 'outline', size: 'large', text: buttonText, shape: 'rectangular', width: 320 });
  } catch (error) {
    showAuthError(error, mode);
  }
}

function showInstallHelp() {
  const isApple = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isAndroid = /android/i.test(navigator.userAgent);
  const steps = isApple
    ? 'Open this page in Safari, tap Share, then choose Add to Home Screen.'
    : isAndroid
      ? 'Open your browser menu and choose Install app or Add to Home screen.'
      : 'In Chrome or Edge, use the install icon in the address bar or the browser menu and choose Install School Manager.';
  modal(`<h2>Install School Manager</h2><p class="muted">You can use School Manager in your browser without installing anything.</p><div class="card"><b>To install on this device</b><p>${esc(steps)}</p></div><div class="row"><a class="btn primary" href="#/login" data-close>Use in browser</a><button class="btn" data-close>Close</button></div>`);
}
function setupLandingInstall() {
  const b = $('#landing-install');
  if (!b) return;
  b.onclick = async () => {
    if (!installEvt) return showInstallHelp();
    const prompt = installEvt;
    installEvt = null;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } catch { showInstallHelp(); }
    setupLandingInstall();
  };
}
async function loadLandingContact() {
  const target = $('#landing-contact-email');
  if (!target) return;
  const cfg = await api('/api/config').catch(() => ({}));
  if (cfg.contactEmail) {
    target.innerHTML = `<a href="mailto:${esc(cfg.contactEmail)}">${esc(cfg.contactEmail)}</a>`;
  } else {
    target.textContent = 'Public support email is not configured yet. You can still create an account or sign in above.';
  }
}
function landingPage() {
  document.title = 'School Manager | Education management in one workspace';
  $('#app').innerHTML = `
  <div class="landing-shell">
    <header class="landing-nav">
      <a class="landing-brand" href="#/" aria-label="School Manager home"><img src="/icon.svg" alt=""><span>School Manager</span></a>
      <nav aria-label="Main navigation">
        <a href="#features">Features</a><a href="#institutions">Who it serves</a><a href="#how-it-works">How it works</a><a href="#contact">Contact</a>
      </nav>
      <div class="landing-nav-actions"><a class="btn" href="#/login">Sign in</a><a class="btn primary" href="#/signup">Create account</a></div>
    </header>
    <main>
      <section class="landing-hero">
        <div class="landing-hero-copy">
          <div class="landing-eyebrow"><span></span> EDUCATION OPERATIONS, ONE WORKSPACE</div>
          <h1>Spend less time chasing records. Spend more time supporting learning.</h1>
          <p class="landing-lead">School Manager brings everyday institution operations into one organised workspace: student records, staff, classes, attendance, fees, parent communication, results and reports.</p>
          <div class="landing-actions"><a class="btn primary" href="#/signup">Create an institution account</a><a class="btn" href="#/login">Sign in</a></div>
          <div class="landing-secondary-actions"><button class="btn" id="landing-install" type="button">Install app</button><a href="#/login">Prefer the browser? Use in browser</a></div>
          <p class="landing-note">Start with a 14-day trial for up to 50 students. No password, email code or phone login is used.</p>
        </div>
        <div class="landing-preview" aria-label="Illustration of an education management dashboard">
          <div class="preview-top"><span class="preview-mark">SM</span><div><b>Institution overview</b><small>Daily operations at a glance</small></div><span class="preview-live">WORKSPACE</span></div>
          <div class="preview-stats"><div><small>Students</small><b>Records</b><span>Admissions and profiles</span></div><div><small>Attendance</small><b>Daily</b><span>Class-by-class tracking</span></div><div><small>Finance</small><b>Fees</b><span>Vouchers and receipts</span></div></div>
          <div class="preview-panel"><div class="preview-panel-head"><b>Keep the day organised</b><span>OVERVIEW</span></div><div class="preview-row"><span><i class="preview-dot blue"></i>Classes and sections</span><b>Organised</b></div><div class="preview-row"><span><i class="preview-dot green"></i>Attendance records</span><b>Trackable</b></div><div class="preview-row"><span><i class="preview-dot violet"></i>Parent communication</span><b>Connected</b></div><div class="preview-progress"><span></span></div><small>One workspace for your institution's routine work</small></div>
          <div class="preview-footer"><span>Student records</span><span>Fees</span><span>Results</span><span>Notices</span></div>
        </div>
      </section>
      <section class="landing-ribbon" aria-label="Platform benefits"><span>One institution workspace</span><span>Role-based access</span><span>Works in the browser</span><span>Installable on supported devices</span></section>
      <section class="landing-section" id="institutions">
        <div class="landing-section-heading"><div class="landing-eyebrow">WHO IT SERVES</div><h2>Made for the people who keep an education institution moving.</h2><p>Give each institution its own workspace, then give each person the tools and access appropriate to their role.</p></div>
        <div class="landing-card-grid three">
          <article class="landing-card"><div class="landing-card-icon">01</div><h3>School and academy administrators</h3><p>Manage admissions, staff, classes, fee plans, reports, notices and day-to-day operations from one place.</p></article>
          <article class="landing-card"><div class="landing-card-icon">02</div><h3>Teachers and office teams</h3><p>Work with assigned classes, student information, attendance, notices and the tasks permitted by your role.</p></article>
          <article class="landing-card"><div class="landing-card-icon">03</div><h3>Parents and guardians</h3><p>See linked children, attendance, fee information, published results, notices and school messages.</p></article>
        </div>
      </section>
      <section class="landing-section landing-features" id="features">
        <div class="landing-section-heading"><div class="landing-eyebrow">WHAT THE SYSTEM DOES</div><h2>The essential work, connected.</h2><p>Keep records in one place and reduce repeated manual work across the institution.</p></div>
        <div class="landing-card-grid">
          <article class="landing-card"><div class="landing-card-icon">A</div><h3>Student admissions and profiles</h3><p>Create student records, assign registration numbers, import spreadsheets, manage guardians and keep a record of changes.</p></article>
          <article class="landing-card"><div class="landing-card-icon">B</div><h3>Staff and responsibilities</h3><p>Add teachers and office staff, assign roles, manage class teachers and subject responsibilities, and revoke access when needed.</p></article>
          <article class="landing-card"><div class="landing-card-icon">C</div><h3>Classes, sections and subjects</h3><p>Organise learning groups, assign class teachers and connect subjects with the teachers who teach them.</p></article>
          <article class="landing-card"><div class="landing-card-icon">D</div><h3>Attendance and registers</h3><p>Record daily attendance, review and submit registers, manage corrections and view monthly attendance summaries.</p></article>
          <article class="landing-card"><div class="landing-card-icon">E</div><h3>Fees and payment records</h3><p>Set fee heads and class plans, generate vouchers, record discounts, track arrears and manage submitted payment slips.</p></article>
          <article class="landing-card"><div class="landing-card-icon">F</div><h3>Receipts and collection reports</h3><p>Verify payments, issue numbered receipts, track cash handovers and review collection and outstanding-fee reports.</p></article>
          <article class="landing-card"><div class="landing-card-icon">G</div><h3>Notices and parent communication</h3><p>Share notices with the right audience, keep student-related message threads and track notification reads.</p></article>
          <article class="landing-card"><div class="landing-card-icon">H</div><h3>Results and documents</h3><p>Upload result documents for individual students or groups, control publication and keep files access-protected.</p></article>
          <article class="landing-card"><div class="landing-card-icon">I</div><h3>Reports, history and backups</h3><p>Review dashboards, audit important actions, monitor storage and export institution data for backup.</p></article>
        </div>
      </section>
      <section class="landing-section landing-workflow" id="how-it-works">
        <div class="landing-section-heading"><div class="landing-eyebrow">GET STARTED</div><h2>A clear path from registration to daily use.</h2></div>
        <div class="landing-steps">
          <article><span>01</span><div><h3>Create the institution workspace</h3><p>Register the institution and create its main administrator profile using a verified Google account.</p></div></article>
          <article><span>02</span><div><h3>Set up classes and staff</h3><p>Add teachers, create classes and sections, and assign class teachers and subjects.</p></div></article>
          <article><span>03</span><div><h3>Add students and guardians</h3><p>Enter records individually or import a spreadsheet. Add the Google email each staff member or guardian will use.</p></div></article>
          <article><span>04</span><div><h3>Run everyday operations</h3><p>Record attendance, manage fees, communicate with families, publish results and review reports.</p></div></article>
        </div>
      </section>
      <section class="landing-section landing-security" id="security">
        <div><div class="landing-eyebrow">ACCESS AND PRIVACY</div><h2>People see the information their role allows.</h2><p>Each institution has its own data space. Teachers work with assigned classes, guardians see only linked children, and administrative access is controlled by roles. Files are delivered through permission-checked routes.</p><p class="small muted">Sign-in uses verified Google accounts. Password login, email OTP and phone-based login are not enabled.</p></div>
        <div class="security-points"><div><b>Google account sign-in</b><span>Verified email identity</span></div><div><b>Institution data separation</b><span>Independent institution workspaces</span></div><div><b>Role-based permissions</b><span>Access checked by the backend</span></div><div><b>Private file access</b><span>Downloads checked against user permissions</span></div></div>
      </section>
      <section class="landing-cta">
        <div><div class="landing-eyebrow">READY TO GET ORGANISED?</div><h2>Start with your institution's workspace.</h2><p>Create your account and complete the guided setup. You can also sign in to an existing account.</p></div>
        <div class="landing-actions"><a class="btn primary" href="#/signup">Create account</a><a class="btn" href="#/login">Sign in</a><button class="btn" id="landing-install-bottom" type="button">Install app</button></div>
      </section>
    </main>
    <footer class="landing-footer" id="contact">
      <div><a class="landing-brand" href="#/"><img src="/icon.svg" alt=""><span>School Manager</span></a><p class="small muted">A practical workspace for student records, staff, attendance, fees and communication.</p></div>
      <div><b>Explore</b><a href="#features">Features</a><a href="#institutions">Who it serves</a><a href="#how-it-works">How it works</a></div>
      <div><b>Account</b><a href="#/signup">Create account</a><a href="#/login">Sign in</a><button id="landing-install-footer" class="landing-footer-link" type="button">Install app</button></div>
      <div><b>Contact us</b><p class="small muted">For product enquiries, onboarding and support:</p><p id="landing-contact-email" class="small muted">Loading contact details…</p><p class="small muted">Contact details are published by the platform team.</p></div>
      <div class="landing-copyright">© <span id="landing-year"></span> School Manager. All rights reserved. <span>Use in browser · Install when supported</span></div>
    </footer>
  </div>`;
  const year = $('#landing-year');
  if (year) year.textContent = String(new Date().getFullYear());
  ['landing-install','landing-install-bottom','landing-install-footer'].forEach((id) => {
    const b = $('#' + id);
    if (b) b.onclick = () => {
      const original = $('#landing-install');
      if (original) original.click();
      else showInstallHelp();
    };
  });
  setupLandingInstall();
  loadLandingContact();
}

route('/login', async () => {
  authPage(`
    <h1>Welcome back</h1>
    <p class="muted small">Sign in with the Google account email registered by your school or academy. No passwords, email codes or phone sign-in.</p>
    <div id="gbtn" class="google-button-slot"></div>
    <p id="authmsg" class="small muted" role="status" aria-live="polite"></p>
    <div id="authnext"></div>
    <p class="small muted auth-switch">New here? <a href="#/signup">Create an institution account</a></p>`);
  await mountGoogleButton($('#gbtn'), async (credential) => {
    const r = await api('/api/auth/google', { body: { credential } });
    if (r.choose) {
      $('#gbtn').classList.add('hidden');
      $('#authmsg').textContent = 'Choose which institution you want to open:';
      const choose = document.createElement('div');
      choose.className = 'auth-school-choices';
      choose.innerHTML = r.choose.map((item) => `<button class="btn" data-pick="${item.pick}">${esc(item.label)}</button>`).join('');
      $('#authnext').replaceChildren(choose);
      $('button[data-pick]', choose).forEach((button) => button.onclick = async () => {
        button.disabled = true;
        try {
          await api('/api/auth/google', { body: { credential, pick: Number(button.dataset.pick) } });
          await refreshMe();
          if (!ME) throw new Error('Your session could not be created. Please retry sign-in.');
          go('/');
        } catch (error) { button.disabled = false; showAuthError(error, 'login'); }
      });
      return;
    }
    await refreshMe();
    if (!ME) throw new Error('Google verified your account, but the School session was not created. Please retry.');
    go('/');
  }, 'signin_with', 'login');
});

route('/signup', async () => {
  authPage(`
    <h1>Create your institution account</h1>
    <p class="muted small">Register your school or academy. Your verified Google account becomes the main administrator sign-in.</p>
    <form id="signupForm" class="stack">
      <label for="signup-school">Institution name</label>
      <input id="signup-school" name="school_name" placeholder="e.g. Green Valley School" autocomplete="organization" required maxlength="120">
      <label for="signup-kind">Institution type</label>
      <select id="signup-kind" name="kind" required><option value="school">School</option><option value="academy">Academy</option></select>
      <label for="signup-admin">Your name</label>
      <input id="signup-admin" name="admin_name" placeholder="Administrator name" autocomplete="name" required maxlength="120">
      <label for="signup-phone">Contact phone (optional)</label>
      <input id="signup-phone" name="phone" placeholder="03xx xxxxxxx" autocomplete="tel" inputmode="tel">
    </form>
    <div id="gbtn" class="google-button-slot"></div>
    <p id="authmsg" class="small muted" role="status" aria-live="polite"></p>
    <div id="authnext"></div>
    <p class="small muted auth-switch">Already registered? <a href="#/login">Sign in instead</a></p>`);
  await mountGoogleButton($('#gbtn'), async (credential) => {
    const form = $('#signupForm');
    if (!form.reportValidity()) return;
    const details = formData(form);
    const r = await api('/api/signup/google', { body: { ...details, credential } });
    await refreshMe();
    if (!ME) throw new Error('Your institution was created, but the sign-in session was not established. Please sign in with the same Google account.');
    go('/setup');
  }, 'signup_with', 'signup');
});

route('/setup', async () => {
  view(`<h1>Welcome! Let's set up your school</h1>
  <div class="card stack">
    <p>Do these in order — each takes a minute:</p>
    <ol class="stack">
      <li><a href="#/staff">Add your teachers</a> (they sign in with their email or phone).</li>
      <li><a href="#/classes">Create classes</a> and pick a class teacher for each.</li>
      <li><a href="#/students">Add students</a> one by one, or import a CSV file from Excel.</li>
      <li><a href="#/fees/setup">Set the fee for each class</a>.</li>
      <li><a href="#/settings?tab=payments">Add your payment accounts</a> (Easypaisa, JazzCash, bank…) so parents know where to pay.</li>
      <li><a href="#/settings">Check settings</a>: fee due date, late fine, attendance deadline.</li>
    </ol>
    <a class="btn primary" href="#/">Go to dashboard</a>
  </div>`);
});

// ---------- home ----------
route('/', async () => {
  if (!ME) return landingPage();
  if (ME.kind === 'guardian') return parentHome();
  if (!ME.isAdmin) return teacherHome();
  const d = await S('/dashboard');
  view(`
  <div class="row between"><h1>Today, ${fmtDate(d.date)}</h1><a class="btn" href="#/setup">Setup guide</a></div>
  <div class="grid">
    <a class="stat" href="#/attendance"><div class="n">${d.attendance.percent}%</div><div class="l">Attendance (${d.attendance.submitted}/${d.attendance.classes} classes submitted)</div></a>
    <a class="stat" href="#/fees/report"><div class="n">${money(d.fees.collectedToday)}</div><div class="l">Fees collected today</div></a>
    <a class="stat" href="#/fees/slips"><div class="n">${d.fees.slipsWaiting}</div><div class="l">Slips waiting to verify</div></a>
    <a class="stat" href="#/cash"><div class="n">${money(d.fees.cashWithTeachers)}</div><div class="l">Cash with teachers</div></a>
    <a class="stat" href="#/fees/unpaid"><div class="n">${d.fees.defaulters}</div><div class="l">Students overdue</div></a>
    <a class="stat" href="#/students"><div class="n">${d.students.active}</div><div class="l">Active students${d.students.pending ? ` · <b>${d.students.pending} awaiting confirmation</b>` : ''}</div></a>
    <a class="stat" href="#/requests"><div class="n">${d.changeRequests}</div><div class="l">Open change requests</div></a>
  </div>
  <h2>Attendance by class</h2>
  ${d.attendance.notSubmitted.length ? `<div class="banner warn">Not yet submitted: ${esc(d.attendance.notSubmitted.join(', '))}</div>` : ''}
  <div class="table-wrap"><table><thead><tr><th>Class</th><th>Status</th><th class="num">Present</th><th class="num">Total</th></tr></thead><tbody>
  ${d.attendance.perClass.map((c) => `<tr><td><a href="#/attendance/${c.id}">${esc(c.name)}</a></td><td>${badge(c.status, c.status === 'submitted' ? 'ok' : c.status === 'draft' ? 'warn' : '')}</td><td class="num">${c.present}</td><td class="num">${c.total}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No classes yet. <a href="#/classes">Create classes</a></td></tr>'}
  </tbody></table></div>
  <h2>Latest notices</h2>
  <div class="card">${d.notices.map((n) => `<div class="list-item"><b>${esc(n.title)}</b> <span class="muted small">· ${esc(n.poster_name)} · ${fmtTime(n.created_at)}</span></div>`).join('') || '<span class="muted">No notices yet</span>'}</div>`);
});

async function teacherHome() {
  const classes = await S('/classes');
  view(`<h1>Assalam-o-Alaikum, ${esc(ME.name)}</h1>
  <h2>My classes</h2>
  <div class="grid">${classes.map((c) => `<div class="stat"><div class="n" style="font-size:1.2rem">${esc(c.name)}</div>
    <div class="l">${c.students} students${ME.classTeacherOf.includes(c.id) ? ' · <b>class teacher</b>' : ''}</div>
    <div class="row" style="margin-top:8px">${ME.classTeacherOf.includes(c.id) ? `<a class="btn small primary" href="#/attendance/${c.id}">Mark attendance</a>` : ''}<a class="btn small" href="#/class/${c.id}">Open</a></div></div>`).join('') || '<p class="muted">You have no classes assigned yet.</p>'}</div>`);
}

async function parentHome() {
  const kids = ME.children;
  const profiles = await Promise.all(kids.map((k) => S('/students/' + k.id)));
  view(`<h1>My children</h1>
  <div class="grid">${profiles.map((p) => {
    const v = (p.vouchers || []).find((x) => x.status !== 'carried');
    return `<a class="stat" href="#/student/${p.student.id}"><div class="n" style="font-size:1.2rem">${esc(p.student.name)}</div>
      <div class="l">${esc(p.student.class_name)} · ${esc(p.student.reg_no)}</div>
      <div style="margin-top:8px">Attendance this month: <b>${p.attendance.percent ?? '–'}%</b></div>
      <div>${v ? (v.balance > 0 ? `Fee due: <b>${money(v.balance)}</b> by ${fmtDate(v.due_date)}` : badge('Fees paid', 'ok')) : '<span class="muted">No voucher yet</span>'}</div></a>`;
  }).join('')}</div>`);
}

// ---------- students ----------
route('/students', async () => {
  const qy = query();
  const status = qy.status || 'active';
  const params = new URLSearchParams({ status });
  if (qy.class_id) params.set('class_id', qy.class_id);
  if (qy.unpaid) params.set('unpaid', '1');
  if (qy.below) params.set('below', qy.below);
  if (qy.added) params.set('added', 'month');
  const [rows, classes] = await Promise.all([S('/students?' + params), S('/classes')]);
  const canAdd = ME.canManageStudents || (ME.settings.teacher_add_students === '1' && ME.classTeacherOf.length);
  view(`
  <div class="row between"><h1>Students</h1><div class="row">
    ${canAdd ? '<button class="btn primary" id="add">Add student</button>' : ''}
    ${ME.canManageStudents ? '<button class="btn" id="imp">Import CSV</button>' : ''}
    <button class="btn" id="exp">Download CSV</button></div></div>
  <form class="row card" id="filters">
    <select name="status">${['active', 'pending', 'left', 'all'].map((s) => `<option ${s === status ? 'selected' : ''} value="${s}">${s === 'left' ? 'Former students' : s === 'pending' ? 'Awaiting confirmation' : s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select>
    <select name="class_id"><option value="">All classes</option>${classes.map((c) => `<option value="${c.id}" ${qy.class_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <label class="row" style="margin:0"><input type="checkbox" name="unpaid" value="1" ${qy.unpaid ? 'checked' : ''}> Unpaid fees</label>
    <label class="row" style="margin:0"><input type="checkbox" name="added" value="1" ${qy.added ? 'checked' : ''}> Added this month</label>
    <input name="below" type="number" min="0" max="100" placeholder="Attendance below %" value="${esc(qy.below || '')}" style="width:170px">
    <button class="btn">Filter</button>
  </form>
  <div class="table-wrap"><table><thead><tr><th>Reg no</th><th>Name</th><th>Father's name</th><th>Class</th><th class="hide-sm">Parent phone</th><th>Status</th></tr></thead><tbody>
  ${rows.map((s) => `<tr><td>${esc(s.reg_no)}</td><td><a href="#/student/${s.id}">${esc(s.name)}</a></td><td>${esc(s.father_name)}</td><td>${esc(s.class_name)}</td><td class="hide-sm">${esc(s.parent_phone)}</td>
    <td>${badge(s.status, s.status === 'active' ? 'ok' : s.status === 'pending' ? 'warn' : '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No students match</td></tr>'}
  </tbody></table></div><p class="muted small">${rows.length} student(s)</p>`);
  $('#filters').onsubmit = (e) => { e.preventDefault(); const b = formData(e.target); const p = new URLSearchParams(); for (const [k, v] of Object.entries(b)) if (v) p.set(k, v); go('/students?' + p); };
  $('#exp').onclick = () => download('students.csv', csv([['reg_no', 'name', 'father_name', 'class', 'parent_phone', 'status'], ...rows.map((s) => [s.reg_no, s.name, s.father_name, s.class_name, s.parent_phone, s.status])]));
  if ($('#add')) $('#add').onclick = () => studentForm(classes);
  if ($('#imp')) $('#imp').onclick = () => importDialog();
});

function studentForm(classes, s = null) {
  const own = ME.canManageStudents ? classes : classes.filter((c) => ME.classTeacherOf.includes(c.id));
  modal(`<h2>${s ? 'Edit student' : 'Add student'}</h2>
  <form id="sf" class="form">
    <div><label>Student name *</label><input name="name" required value="${esc(s?.name)}"></div>
    <div><label>Father's name *</label><input name="father_name" required value="${esc(s?.father_name)}"></div>
    <div><label>Registration number</label><input name="reg_no" placeholder="Created automatically" value="${esc(s?.reg_no)}"></div>
    <div><label>Class *</label><select name="class_id" required>${own.map((c) => `<option value="${c.id}" ${s?.class_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div><label>Parent Google email * (sign-in)</label><input name="parent_email" type="email" required placeholder="parent@gmail.com" value="${esc(s?.parent_email)}"></div>
    <div><label>Parent phone (optional contact)</label><input name="parent_phone" placeholder="03001234567" value="${esc(s?.parent_phone)}"></div>
    <div><label>Date of birth</label><input name="dob" type="date" value="${esc(s?.dob)}"></div>
    <div><label>Gender</label><select name="gender"><option value=""></option>${['Male', 'Female'].map((g) => `<option ${s?.gender === g ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
    <div><label>Admission date</label><input name="admission_date" type="date" value="${esc(s?.admission_date || today())}"></div>
    <div class="full"><label>Address</label><input name="address" value="${esc(s?.address)}"></div>
    ${s ? '<div class="full"><label>Reason for change</label><input name="reason" placeholder="Kept in the change history"></div>' : ''}
    <div class="full row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div>
  </form>`, (m) => {
    $('#sf', m).onsubmit = async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      if (s) { await act(() => S('/students/' + s.id, { method: 'PATCH', body: b }), 'Saved'); closeModal(); return render(); }
      let r = await act(() => S('/students', { body: b }));
      if (r.needsConfirm) { if (!confirm(r.message + '\n\nAdd anyway?')) return; r = await act(() => S('/students', { body: { ...b, allow_duplicate: true } })); }
      toast(r.status === 'pending' ? 'Added — awaiting admin confirmation' : `Added (${r.reg_no})`);
      closeModal(); render();
    };
  });
}

function importDialog() {
  modal(`<h2>Import students</h2>
  <p class="small">Save your Excel sheet as <b>CSV</b> with these columns in the first row:<br><code>name, father_name, class, parent_email, parent_phone, reg_no, dob, gender, address</code><br>
  Class must match a class name exactly, e.g. <code>7-B</code>. Registration number is created automatically if empty.</p>
  <button class="btn small" id="tpl">Download template</button>
  <p><input type="file" id="file" accept=".csv,text/csv"></p>
  <div id="prev"></div>
  <div class="row"><button class="btn primary" id="go" disabled>Import</button><button class="btn" data-close>Close</button></div>`, (m) => {
    let rows = [];
    $('#tpl', m).onclick = () => download('students-template.csv', 'name,father_name,class,parent_phone,parent_email,reg_no,dob,gender,address\nAhmed Ali,Ali Raza,7-B,03001234567,,,,Male,\n');
    $('#file', m).onchange = async (e) => {
      const data = parseCSV(await e.target.files[0].text());
      const head = data.shift().map((h) => h.trim().toLowerCase().replace(/\s+/g, '_').replace("father's_name", 'father_name'));
      rows = data.map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
      $('#prev', m).innerHTML = `<p>${rows.length} row(s) found. First: ${esc(rows[0]?.name)} / ${esc(rows[0]?.class)}</p>`;
      $('#go', m).disabled = !rows.length;
    };
    $('#go', m).onclick = async () => {
      const r = await act(() => S('/students/import', { body: { rows } }));
      const bad = r.results.filter((x) => !x.ok);
      $('#prev', m).innerHTML = `<p><b>${r.added} added.</b> ${bad.length ? bad.length + ' problem row(s):' : ''}</p>` + bad.map((x) => `<div class="small">Row ${x.row}: ${esc(x.error)}</div>`).join('');
      $('#go', m).disabled = true;
    };
  });
}

route('/student/:id', async ({ id }) => {
  const tab = query().tab || 'overview';
  const month = query().month || thisMonth();
  const p = await S(`/students/${id}?month=${month}`);
  const s = p.student;
  const isParent = ME.kind === 'guardian';
  const tabs = [['overview', 'Details'], ['attendance', 'Attendance'], ...(p.vouchers ? [['fees', 'Fees']] : []), ['results', 'Results'], ['notices', 'Notices'],
    ...(ME.subrole === 'accountant' || ME.role === 'subadmin' ? [] : [['messages', 'Messages']]), ...(ME.isAdmin ? [['history', 'Change history']] : [])];
  let body = '';
  if (tab === 'overview') body = `
    <div class="card form">
      ${[['Registration no', s.reg_no], ['Class', s.class_name], ["Father's name", s.father_name], ['Parent phone', s.parent_phone], ['Parent email', s.parent_email], ['Date of birth', fmtDate(s.dob)],
        ['Gender', s.gender], ['Admission date', fmtDate(s.admission_date)], ['Address', s.address], ['Added', new Date(s.created_at).toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })]]
        .filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => `<div><label>${k}</label>${esc(v || '–')}</div>`).join('')}
      ${s.status === 'left' ? `<div class="full banner warn">Left on ${fmtDate(s.left_date)} — ${esc(s.left_reason)}</div>` : ''}
    </div>
    <h3>Class history</h3>
    <div class="table-wrap"><table><tbody>${p.classHistory.map((e) => `<tr><td>${esc(e.session_name)}</td><td>${esc(e.class_name)}</td><td>from ${fmtDate(e.from_date)}</td><td>${esc(e.outcome || '')}</td></tr>`).join('')}</tbody></table></div>`;
  if (tab === 'attendance') body = attendanceCalendar(p, month, id);
  if (tab === 'fees') body = feesTab(p, s);
  if (tab === 'results') body = p.resultsHeld ? '<div class="banner warn">Results are held until fees are cleared.</div>' : `<div class="card">${p.results.map((r) => `<div class="list-item row between"><div><b>${esc(r.title)}</b> <span class="muted small">· ${esc(r.session)}</span> ${r.published_at ? badge('published', 'ok') : badge('hidden', 'warn')}</div><a class="btn small" target="_blank" href="/api/s/result-file/${r.id}">Open PDF</a></div>`).join('') || '<span class="muted">No results yet</span>'}</div>`;
  if (tab === 'notices') body = `<div class="card">${p.notices.map((n) => noticeItem(n)).join('') || '<span class="muted">No notices</span>'}</div>`;
  if (tab === 'messages') { go('/thread/' + id); return; }
  if (tab === 'history') body = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${p.history.map((h) => `<tr><td>${fmtTime(h.created_at)}</td><td>${esc(h.user_name)}</td><td>${esc(h.action)}</td><td class="small">${esc(h.detail || '')}</td></tr>`).join('')}</tbody></table></div>`;
  view(`
  <div class="row between"><div><h1 style="margin:0">${esc(s.name)} ${s.status !== 'active' ? badge(s.status, 'warn') : ''}</h1><div class="muted">s/o ${esc(s.father_name)} · ${esc(s.class_name)} · ${esc(s.reg_no)}</div></div>
  <div class="row">${studentActions(s)}</div></div>
  <div class="tabs" style="margin-top:14px">${tabs.map(([k, l]) => `<a href="#/student/${id}?tab=${k}" class="${tab === k ? 'active' : ''}">${l}</a>`).join('')}</div>
  ${body}`);
  bindStudentActions(s, p);
});

function studentActions(s) {
  const out = [];
  if (ME.canManageStudents) {
    out.push('<button class="btn" id="edit">Edit</button>');
    if (s.status === 'pending') out.push('<button class="btn primary" id="confirm">Confirm</button>');
    if (s.status === 'active') out.push('<button class="btn" id="left">Mark as left</button>');
    if (s.status === 'left') out.push('<button class="btn" id="restore">Restore</button>', '<button class="btn" id="cert">Leaving certificate</button>');
    if (ME.isMainAdmin) out.push('<button class="btn danger" id="del">Delete</button>');
  } else if (ME.kind === 'staff') out.push('<button class="btn" id="req">Request a change</button>');
  return out.join('');
}
function bindStudentActions(s, p) {
  const on = (id, fn) => { const b = $('#' + id); if (b) b.onclick = fn; };
  on('edit', async () => studentForm(await S('/classes'), s));
  on('confirm', async () => { await act(() => S(`/students/${s.id}/confirm`, { body: {} }), 'Confirmed; parent invited'); render(); });
  on('left', () => modal(`<h2>Mark ${esc(s.name)} as left</h2><form class="form" id="lf">
    <div><label>Leaving date</label><input type="date" name="date" value="${today()}"></div>
    <div><label>Reason</label><select name="reason">${['transferred', 'left without notice', 'expelled', 'passed out', 'other'].map((r) => `<option>${r}</option>`).join('')}</select></div>
    <div class="full"><label>Note</label><input name="note"></div>
    <p class="full small muted">All attendance, fees and receipts stay on the profile. Unpaid balance stays on the Left with dues list.</p>
    <div class="full row"><button class="btn primary">Mark as left</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#lf', m).onsubmit = async (e) => { e.preventDefault(); await act(() => S(`/students/${s.id}/left`, { body: formData(e.target) }), 'Marked as left'); closeModal(); render(); };
  }));
  on('restore', async () => { await act(() => S(`/students/${s.id}/restore`, { body: {} }), 'Restored'); render(); });
  on('del', async () => { if (!confirm('Delete permanently? Only for records added by mistake.')) return; await act(() => S(`/students/${s.id}`, { method: 'DELETE' }), 'Deleted'); go('/students'); });
  on('cert', () => {
    const w = window.open('', '_blank');
    w.document.write(`<title>Leaving certificate</title><body style="font-family:serif;max-width:700px;margin:40px auto;line-height:1.8"><h1 style="text-align:center">${esc(ME.schoolName)}</h1><h2 style="text-align:center">School Leaving Certificate</h2>
    <p>This is to certify that <b>${esc(s.name)}</b>, son/daughter of <b>${esc(s.father_name)}</b>, registration number <b>${esc(s.reg_no)}</b>, was a student of this school in class <b>${esc(s.class_name)}</b>.
    Admitted on ${fmtDate(s.admission_date)}, left on ${fmtDate(s.left_date)}. Reason: ${esc(s.left_reason)}.</p><p>Date of birth: ${fmtDate(s.dob) || '—'}</p><br><br><p>Principal: ____________________ &nbsp;&nbsp; Date: ${fmtDate(today())}</p><script>print()<\/script>`);
  });
  on('req', () => modal(`<h2>Request a change</h2><form id="rf" class="form">
    <div class="full"><label>What should change and why?</label><textarea name="reason" required></textarea></div>
    <div class="full row"><button class="btn primary">Send to admin</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#rf', m).onsubmit = async (e) => { e.preventDefault(); await act(() => S('/change-requests', { body: { kind: 'student', student_id: s.id, reason: formData(e.target).reason } }), 'Request sent'); closeModal(); };
  }));
  bindFees(s, p);
  bindCalendar(s);
}

function attendanceCalendar(p, month, id) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const recs = Object.fromEntries(p.attendance.records.map((r) => [r.date, r.status]));
  const hol = Object.fromEntries(p.attendance.holidays.map((h) => [h.date, h.name]));
  const cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="h">${d}</div>`);
  for (let i = 0; i < first; i++) cells.push('<div class="h"></div>');
  for (let d = 1; d <= days; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const st = recs[date];
    cells.push(`<div class="${st || (hol[date] ? 'hol' : '')}" title="${esc(st ? STATUS[st] : hol[date] || '')}" ${ME.isAdmin && st ? `data-fix="${date}"` : ''}>${d}</div>`);
  }
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7), next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  const counts = Object.values(recs).reduce((a, s) => ((a[s] = (a[s] || 0) + 1), a), {});
  return `<div class="card">
    <div class="row between"><div class="row"><a class="btn small" href="#/student/${id}?tab=attendance&month=${prev}">‹</a><b>${new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</b><a class="btn small" href="#/student/${id}?tab=attendance&month=${next}">›</a></div>
    <div class="row"><button class="btn small" id="att-csv">CSV</button><button class="btn small" id="att-print">PDF / Print</button></div></div>
    <p>Attendance: <b>${p.attendance.percent ?? '–'}%</b> · ${Object.entries(counts).map(([k, v]) => `${STATUS[k]} ${v}`).join(' · ')}</p>
    <div class="cal">${cells.join('')}</div>
    ${ME.isAdmin ? '<p class="small muted">Admins: tap a marked day to correct it.</p>' : ''}
  </div>`;
}
function bindCalendar(s) {
  const c = $('#att-csv'); if (!c) return;
  c.onclick = async () => {
    const month = query().month || thisMonth();
    const p = await S(`/students/${s.id}?month=${month}`);
    download(`attendance-${s.reg_no}-${month}.csv`, csv([['date', 'status'], ...p.attendance.records.map((r) => [r.date, STATUS[r.status]])]));
  };
  $('#att-print').onclick = () => print();
  $$('[data-fix]').forEach((d) => d.onclick = () => modal(`<h2>Correct ${esc(d.dataset.fix)}</h2><form id="cf" class="form">
    <div><label>New status</label><select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
    <div class="full"><label>Reason (the parent is told)</label><input name="reason" required></div>
    <div class="full row"><button class="btn primary">Save correction</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#cf', m).onsubmit = async (e) => { e.preventDefault(); await act(() => S('/attendance/correct', { body: { ...formData(e.target), student_id: s.id, date: d.dataset.fix } }), 'Corrected'); closeModal(); render(); };
  }));
}

function feesTab(p, s) {
  const isParent = ME.kind === 'guardian';
  const current = p.vouchers.find((v) => v.status !== 'carried' && v.status !== 'settled');
  const unpaidMonths = p.vouchers.filter((v) => ['unpaid', 'partial', 'carried'].includes(v.status)).length;
  const canOwnFee = ME.role === 'admin' || (ME.settings.teacher_set_fees === '1' && ME.classTeacherOf.includes(s.class_id));
  return `
  ${current ? `<div class="grid" style="margin-bottom:12px"><div class="stat"><div class="l">Total due now</div><div class="n">${money(Math.max(0, current.balance))}</div></div>
    <div class="stat"><div class="l">Months unpaid</div><div class="n" style="color:${unpaidMonths >= 2 ? 'var(--bad)' : 'inherit'}">${unpaidMonths}</div></div>
    <div class="stat"><div class="l">Late fine on latest voucher</div><div class="n">${money(current.fine)}</div></div></div>` : ''}
  ${unpaidMonths >= 2 ? `<div class="banner bad">Fee for ${unpaidMonths} months is pending. Older months are added to the latest voucher automatically, so one payment clears everything.</div>` : ''}
  ${p.reminderPause ? `<div class="banner info">Fee reminders paused: ${esc(p.reminderPause.reason)}</div>` : ''}
  <div class="row" style="margin-bottom:12px">
    ${current && current.balance > 0 && isParent ? `<button class="btn primary" id="pay-slip" data-v="${current.id}" data-b="${current.balance}">Upload payment slip</button>` : ''}
    ${current && current.balance > 0 && !isParent && (ME.classTeacherOf.includes(s.class_id) || ME.canFees) ? `<button class="btn primary" id="pay-cash" data-v="${current.id}" data-b="${current.balance}">Fee received (cash)</button>` : ''}
    ${current && current.balance > 0 && ME.canFees ? `<button class="btn" id="pay-office" data-v="${current.id}" data-b="${current.balance}">Record office payment</button>` : ''}
    ${ME.canFees ? '<button class="btn" id="disc">Add discount</button>' : ''}
    ${canOwnFee ? '<button class="btn" id="ownfee">Set this student\'s fee</button>' : ''}
    ${!isParent ? `<button class="btn" id="pause">${p.reminderPause ? 'Resume reminders' : 'Pause reminders'}</button>` : ''}
  </div>
  ${p.discounts && p.discounts.length ? `<p class="small">Discounts: ${p.discounts.map((d) => `${esc(d.kind)} ${money(d.amount)}/month ${ME.canFees ? `<a href="#" data-deldisc="${d.id}">remove</a>` : ''}`).join(' · ')}</p>` : ''}
  <h3>Vouchers</h3>
  <div class="table-wrap"><table><thead><tr><th>Month</th><th>No.</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Fine</th><th class="num">Balance</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>
  ${p.vouchers.map((v) => `<tr><td>${esc(v.month)}</td><td>${v.number}</td><td class="num">${money(v.total)}</td><td class="num">${money(v.paid)}</td>
    <td class="num">${money(v.fine)}${ME.canFees && ['unpaid', 'partial'].includes(v.status) ? ` <a href="#" data-fine="${v.id}" class="small">change</a>` : ''}</td>
    <td class="num">${v.status === 'carried' ? '→ next' : v.status === 'settled' ? '–' : money(v.balance)}</td><td>${fmtDate(v.due_date)}</td><td>${badge(v.status, VOUCHER_STATUS[v.status])}</td><td><a href="#/voucher/${v.id}">Print</a></td></tr>`).join('') || '<tr><td colspan="9" class="muted">No vouchers yet</td></tr>'}
  </tbody></table></div>
  <h3>Payments</h3>
  <div class="table-wrap"><table><thead><tr><th>When</th><th>Method</th><th class="num">Amount</th><th>Txn ID</th><th>Status</th><th></th></tr></thead><tbody>
  ${p.payments.map((x) => `<tr><td>${fmtTime(x.created_at)}</td><td>${esc(x.method.replace('_', ' '))}</td><td class="num">${money(x.amount)}</td><td>${esc(x.txn_id || '')}</td><td>${badge(x.status, PAY_STATUS[x.status])}${x.reason ? `<div class="small muted">${esc(x.reason)}</div>` : ''}</td>
  <td class="row">${x.receipt_no && x.status === 'verified' ? `<a href="#/receipt/${x.id}">Receipt #${x.receipt_no}</a>` : ''}${x.slip_key ? ` <a target="_blank" href="/files/${esc(x.slip_key.split('/').slice(1).join('/'))}">Slip</a>` : ''}${ME.isMainAdmin && x.status === 'verified' ? ` <a href="#" data-cancel="${x.id}">Cancel</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No payments yet</td></tr>'}
  </tbody></table></div>`;
}

function bindFees(s, p) {
  const payDialog = (method, v, bal) => {
    const parent = method === 'slip', office = method === 'office';
    modal(`<h2>${parent ? 'Upload payment slip' : office ? 'Record office payment' : 'Fee received in cash'}</h2>
    ${parent ? `<p class="small">Pay to one of the school's accounts below, then upload the transaction ID and slip.</p>${accountsHtml(ACCOUNTS)}` : ''}
    <form id="pf" class="form">
      ${parent ? `<div><label>Paid by</label><select name="method"><option value="easypaisa">Easypaisa</option><option value="jazzcash">JazzCash</option><option value="bank">Bank / other</option></select></div>` : ''}
      ${office ? `<div><label>Method</label><select name="method"><option value="office_cash">Cash at office</option><option value="bank">Bank deposit</option><option value="easypaisa">Easypaisa</option><option value="jazzcash">JazzCash</option></select></div>` : ''}
      <div><label>Amount</label><input name="amount" type="number" min="1" value="${bal}" required></div>
      ${parent || office ? `<div><label>Transaction ID${parent ? ' *' : ''}</label><input name="txn_id" ${parent ? 'required' : ''}></div>` : ''}
      ${parent ? '<div class="full"><label>Slip (photo or PDF) *</label><input type="file" name="slip" accept="image/*,application/pdf" required></div>' : ''}
      <div class="full row"><button class="btn primary">Submit</button><button type="button" class="btn" data-close>Cancel</button></div>
    </form>`, (m) => {
      $('#pf', m).onsubmit = async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target); fd.set('voucher_id', v);
        if (!parent && !office) fd.set('method', 'cash_teacher');
        const file = fd.get('slip');
        if (file && file.size && file.type.startsWith('image/')) fd.set('slip', await compressImage(file), file.name.replace(/\.\w+$/, '.jpg'));
        const r = await act(() => S('/payments', { form: fd }));
        toast(r.receipt ? `Receipt #${r.receipt} issued` : 'Submitted for verification');
        closeModal(); render();
      };
    });
  };
  const b = (id, m) => { const el = $('#' + id); if (el) el.onclick = async () => { await loadAccounts(); payDialog(m, el.dataset.v, el.dataset.b); }; };
  b('pay-slip', 'slip'); b('pay-cash', 'cash'); b('pay-office', 'office');
  loadAccounts();
  // Student's own fee (replaces the class amount for this student)
  const ownFee = $('#ownfee'); if (ownFee) ownFee.onclick = async () => {
    const f = await S(`/students/${s.id}/fee`);
    modal(`<h2>Fee for ${esc(s.name)}</h2><p class="small muted">Leave a box empty to use the class fee. Enter 0 to remove that fee for this student. This month's unpaid voucher is updated at once.</p>
    <form id="of" class="stack"><div class="table-wrap"><table><thead><tr><th>Fee</th><th class="num">Class amount</th><th class="num">This student</th></tr></thead><tbody>
    ${f.heads.map((h) => `<tr><td>${esc(h.name)}</td><td class="num">${money(h.class_amount)}</td><td class="num"><input type="number" min="0" style="width:120px" data-h="${h.head_id}" value="${h.student_amount ?? ''}" placeholder="class fee"></td></tr>`).join('')}
    </tbody></table></div><p>Monthly fee now: <b>${money(f.monthly)}</b></p>
    <div class="row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
      $('#of', m).onsubmit = async (e) => {
        e.preventDefault();
        const heads = $$('input[data-h]', m).map((i) => ({ head_id: i.dataset.h, amount: i.value === '' ? null : Number(i.value) }));
        await act(() => S(`/students/${s.id}/fee`, { body: { heads } }), 'Student fee saved'); closeModal(); render();
      };
    });
  };
  // Add, change or waive the late fine on one voucher
  $$('[data-fine]').forEach((a) => a.onclick = (e) => {
    e.preventDefault();
    const v = p.vouchers.find((x) => x.id === a.dataset.fine);
    modal(`<h2>Late fine — ${esc(v.month)}</h2><p>Current fine: <b>${money(v.fine)}</b>${v.fine_locked ? ' (set by hand)' : ''}</p>
    <form id="ff" class="form"><div><label>Fine amount (0 = waive)</label><input type="number" min="0" name="amount" value="${v.fine}" required></div>
    <div><label>Reason (parent is told)</label><input name="reason" required></div>
    <div class="full row"><button class="btn primary">Save fine</button>${v.fine_locked ? '<button type="button" class="btn" id="auto">Back to automatic fine</button>' : ''}<button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
      $('#ff', m).onsubmit = async (ev) => { ev.preventDefault(); await act(() => S(`/vouchers/${v.id}/fine`, { body: formData(ev.target) }), 'Fine updated'); closeModal(); render(); };
      const au = $('#auto', m); if (au) au.onclick = async () => { await act(() => S(`/vouchers/${v.id}/fine`, { body: { auto: true } }), 'Automatic fine restored'); closeModal(); render(); };
    });
  });
  const d = $('#disc'); if (d) d.onclick = () => modal(`<h2>Add discount</h2><form id="df" class="form">
    <div><label>Kind</label><select name="kind"><option>sibling</option><option>scholarship</option><option>staff child</option><option>custom</option></select></div>
    <div><label>Amount per month</label><input type="number" name="amount" min="1" required></div><div class="full"><label>Note</label><input name="note"></div>
    <div class="full row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#df', m).onsubmit = async (e) => { e.preventDefault(); await act(() => S(`/students/${s.id}/discounts`, { body: formData(e.target) }), 'Discount added — applies from the next voucher'); closeModal(); render(); };
  });
  $$('[data-deldisc]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); await act(() => S(`/students/${s.id}/discounts/${a.dataset.deldisc}`, { method: 'DELETE' }), 'Removed'); render(); });
  $$('[data-cancel]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); const reason = prompt('Reason for cancelling this receipt?'); if (!reason) return; await act(() => S(`/payments/${a.dataset.cancel}/cancel`, { body: { reason } }), 'Receipt cancelled'); render(); });
  const pz = $('#pause'); if (pz) pz.onclick = async () => {
    if (p.reminderPause) { await act(() => S(`/students/${s.id}/reminder-pause`, { body: { off: true } }), 'Reminders resumed'); return render(); }
    const reason = prompt('Why pause fee reminders for this student? (e.g. agreed late payment)'); if (!reason) return;
    await act(() => S(`/students/${s.id}/reminder-pause`, { body: { reason } }), 'Reminders paused'); render();
  };
}

/** Photos are compressed before upload to save storage. */
async function compressImage(file, max = 1600, quality = 0.75) {
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = img.width * scale; c.height = img.height * scale;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
    return blob && blob.size < file.size ? blob : file;
  } catch { return file; }
}

route('/voucher/:id', async ({ id }) => {
  const d = await S('/vouchers/' + id);
  const copy = (label) => `<div class="voucher-copy card"><div class="row between"><b>${esc(d.school)}</b><span>${label}</span></div>
    <div class="row between small"><span>Voucher #${d.voucher.number}</span><span>Month ${esc(d.voucher.month)}</span><span>Due ${fmtDate(d.voucher.due_date)}</span></div>
    <p>${esc(d.student.name)} s/o ${esc(d.student.father_name)} · ${esc(d.student.class_name)} · ${esc(d.student.reg_no)}</p>
    <table><tbody>${d.lines.map((l) => `<tr><td>${esc(l.label)}</td><td class="num">${money(l.amount)}</td></tr>`).join('')}
    ${d.voucher.fine ? `<tr><td>Late fine</td><td class="num">${money(d.voucher.fine)}</td></tr>` : ''}
    <tr><td><b>Total</b></td><td class="num"><b>${money(d.voucher.total)}</b></td></tr>
    ${d.voucher.paid ? `<tr><td>Paid</td><td class="num">${money(d.voucher.paid)}</td></tr><tr><td><b>Balance</b></td><td class="num"><b>${money(d.voucher.balance)}</b></td></tr>` : ''}</tbody></table></div>`;
  view(`<div class="row no-print"><button class="btn primary" onclick="print()">Print (3 copies)</button><button class="btn" onclick="history.back()">Back</button></div>
  ${copy('Parent copy')}${copy('School copy')}${copy('Bank copy')}
  ${d.accounts && d.accounts.length ? `<div class="card"><b>Pay to:</b> ${d.accounts.map((a) => `${esc(a.company)} — ${esc(a.title)} — <b>${esc(a.number)}</b>`).join(' · ')}</div>` : ''}`);
});

route('/receipt/:id', async ({ id }) => {
  const d = await S('/payments/' + id);
  view(`<div class="row no-print"><button class="btn primary" onclick="print()">Print</button><button class="btn" onclick="history.back()">Back</button></div>
  <div class="card" style="max-width:520px"><h2 style="margin-top:0">${esc(d.school)} — Fee receipt</h2>
  ${d.payment.status === 'cancelled' ? `<div class="banner bad">CANCELLED: ${esc(d.payment.reason)}</div>` : ''}
  <table><tbody>
  <tr><td>Receipt no.</td><td><b>#${d.payment.receipt_no}</b></td></tr>
  <tr><td>Student</td><td>${esc(d.student.name)} s/o ${esc(d.student.father_name)}</td></tr>
  <tr><td>Class / Reg no</td><td>${esc(d.student.class_name)} / ${esc(d.student.reg_no)}</td></tr>
  <tr><td>Voucher</td><td>#${d.voucher.number} (${esc(d.voucher.month)})</td></tr>
  <tr><td>Amount paid</td><td><b>${money(d.payment.amount)}</b></td></tr>
  <tr><td>Method</td><td>${esc(d.payment.method.replace('_', ' '))}${d.payment.txn_id ? ' · ' + esc(d.payment.txn_id) : ''}</td></tr>
  <tr><td>Date and time</td><td>${new Date(d.payment.verified_at || d.payment.created_at).toLocaleString('en-PK', { timeZone: 'Asia/Karachi', hour12: true })}</td></tr>
  <tr><td>Verified by</td><td>${esc(d.verified_by_name || '')}</td></tr>
  <tr><td>Balance on voucher</td><td>${money(d.voucher.balance)}</td></tr></tbody></table></div>`);
});

// ---------- staff ----------
route('/staff', async () => {
  const showFormer = query().former === '1';
  const rows = await S('/staff?active=' + (showFormer ? '0' : '1'));
  view(`<div class="row between"><h1>${showFormer ? 'Former staff' : 'Teachers & staff'}</h1><div class="row">
    <a class="btn" href="#/staff${showFormer ? '' : '?former=1'}">${showFormer ? 'Active staff' : 'Former staff'}</a>
    ${ME.role === 'admin' ? '<button class="btn primary" id="add">Add teacher or staff</button>' : ''}</div></div>
  <div class="table-wrap"><table><thead><tr><th>Name</th><th>Role</th><th>Class teacher of</th><th>Subjects</th><th class="hide-sm">Phone</th><th class="hide-sm">Email</th></tr></thead><tbody>
  ${rows.map((t) => `<tr><td><a href="#/staff/${t.id}">${esc(t.name)}</a></td><td>${t.is_main ? badge('main admin', 'info') : badge(t.subrole || t.role)}</td><td>${esc(t.classes.join(', '))}</td>
   <td class="small">${esc(t.subject_classes.map((x) => `${x.subject} (${x.name})`).join(', ') || t.subjects || '')}</td><td class="hide-sm">${esc(t.phone || '')}</td><td class="hide-sm">${esc(t.email || '')}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">None</td></tr>'}
  </tbody></table></div>`);
  if ($('#add')) $('#add').onclick = () => staffForm();
});

function staffForm(t = null) {
  modal(`<h2>${t ? 'Edit' : 'Add'} staff</h2><form id="tf" class="form">
    <div><label>Name *</label><input name="name" required value="${esc(t?.name)}"></div>
    <div><label>Google email * (sign-in)</label><input name="email" type="email" required value="${esc(t?.email)}"></div>
    <div><label>Phone (optional contact)</label><input name="phone" value="${esc(t?.phone)}"></div>
    <div><label>Subjects</label><input name="subjects" placeholder="Maths, Physics" value="${esc(t?.subjects)}"></div>
    ${ME.isMainAdmin && !t?.is_main ? `<div><label>Role</label><select name="role" id="role"><option value="teacher">Teacher</option><option value="subadmin" ${t?.role === 'subadmin' ? 'selected' : ''}>Sub-admin</option><option value="admin" ${t?.role === 'admin' ? 'selected' : ''}>Admin</option></select></div>
    <div><label>Sub-admin area</label><select name="subrole"><option value="office">Office</option><option value="accountant" ${t?.subrole === 'accountant' ? 'selected' : ''}>Accountant</option><option value="coordinator" ${t?.subrole === 'coordinator' ? 'selected' : ''}>Coordinator</option></select></div>` : ''}
    <p class="full small muted">They sign in only with this verified Google email. Phone is optional contact information and cannot be used to sign in.</p>
    <div class="full row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#tf', m).onsubmit = async (e) => {
      e.preventDefault();
      const b = formData(e.target);
      if (t) await act(() => S('/staff/' + t.id, { method: 'PATCH', body: b }), 'Saved');
      else await act(() => S('/staff', { body: b }), 'Added');
      closeModal(); render();
    };
  });
}

route('/staff/:id', async ({ id }) => {
  const d = await S('/staff/' + id);
  const t = d.staff;
  const cash = d.cashHeld.reduce((s, x) => s + x.amount, 0);
  view(`<div class="row between"><div><h1 style="margin:0">${esc(t.name)} ${t.active ? '' : badge('former', 'warn')}</h1><div class="muted">${esc(t.subrole || t.role)}${t.subjects ? ' · ' + esc(t.subjects) : ''}</div></div>
  <div class="row">${ME.role === 'admin' && (!t.is_main || ME.isMainAdmin) ? `<button class="btn" id="edit">Edit</button>${t.is_main ? '' : t.active ? '<button class="btn danger" id="deact">Deactivate</button>' : '<button class="btn" id="react">Reactivate</button>'}` : ''}</div></div>
  <div class="grid" style="margin-top:14px">
    <div class="stat"><div class="l">Phone</div>${esc(t.phone || '–')}</div><div class="stat"><div class="l">Email</div>${esc(t.email || '–')}</div>
    <div class="stat"><div class="l">Class teacher of</div>${esc(d.classTeacherOf.map((c) => c.name).join(', ') || '–')}</div>
    <div class="stat"><div class="l">Cash held</div><b>${money(cash)}</b></div>
  </div>
  ${t.left_at ? `<div class="banner warn">Left on ${fmtDate(t.left_at)} — ${esc(t.left_reason || '')}</div>` : ''}
  <h2>Subjects</h2><div class="card">${d.subjects.map((s) => `${esc(s.subject)} — <a href="#/class/${s.class_id}">${esc(s.class_name)}</a>`).join('<br>') || '<span class="muted">None</span>'}</div>
  <h2>Attendance submissions</h2><div class="table-wrap"><table><tbody>${d.submissions.map((s) => `<tr><td>${fmtDate(s.date)}</td><td>${esc(s.class_name)}</td><td>${fmtTime(s.submitted_at)}</td></tr>`).join('') || '<tr><td class="muted">None</td></tr>'}</tbody></table></div>
  <h2>Notices posted</h2><div class="card">${d.notices.map((n) => `<div>${esc(n.title)} <span class="muted small">${fmtTime(n.created_at)}</span></div>`).join('') || '<span class="muted">None</span>'}</div>
  ${d.history.length ? `<h2>Change history</h2><div class="table-wrap"><table><tbody>${d.history.map((h) => `<tr><td>${fmtTime(h.created_at)}</td><td>${esc(h.user_name)}</td><td>${esc(h.action)}</td><td class="small">${esc(h.detail || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`);
  const on = (i, f) => { const b = $('#' + i); if (b) b.onclick = f; };
  on('edit', () => staffForm(t));
  on('react', async () => { await act(() => S(`/staff/${id}/reactivate`, { body: {} }), 'Reactivated'); render(); });
  on('deact', () => modal(`<h2>Deactivate ${esc(t.name)}</h2><p class="small">They are signed out of all devices at once. Their history stays. Hand their classes to another teacher from the class page.</p>
    <form id="df" class="form"><div><label>Leaving date</label><input type="date" name="date" value="${today()}"></div><div><label>Reason</label><input name="reason"></div>
    <div class="full row"><button class="btn danger">Deactivate</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#df', m).onsubmit = async (e) => {
      e.preventDefault(); const b = formData(e.target);
      let r = await act(() => S(`/staff/${id}/deactivate`, { body: b }));
      if (r.needsConfirm) { if (!confirm(r.message)) return; r = await act(() => S(`/staff/${id}/deactivate`, { body: { ...b, confirm_cash: true } })); }
      toast('Deactivated'); closeModal(); render();
    };
  }));
});

// ---------- classes ----------
route('/classes', async () => {
  const [rows, staff] = await Promise.all([S('/classes'), ME.isAdmin ? S('/staff') : []]);
  view(`<div class="row between"><h1>Classes</h1>${ME.role === 'admin' ? '<button class="btn primary" id="add">Add class</button>' : ''}</div>
  <div class="table-wrap"><table><thead><tr><th>Class</th><th>Class teacher</th><th>Subject teachers</th><th class="num">Students</th><th></th></tr></thead><tbody>
  ${rows.map((c) => `<tr><td><a href="#/class/${c.id}">${esc(c.name)}</a></td><td>${esc(c.class_teacher_name || '–')}</td><td class="small">${esc(c.subjects.map((s) => `${s.subject}: ${s.teacher_name || '–'}`).join(', '))}</td><td class="num">${c.students}</td>
   <td>${ME.role === 'admin' ? `<button class="btn small" data-edit="${c.id}">Edit</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No classes yet</td></tr>'}
  </tbody></table></div>`);
  const form = (c) => modal(`<h2>${c ? 'Edit class' : 'Add class'}</h2><form id="cf" class="form">
    <div><label>Name *</label><input name="name" required placeholder="7-B" value="${esc(c?.name)}"></div>
    <div><label>Grade (number, for promotion order)</label><input name="grade" type="number" value="${esc(c?.grade ?? '')}"></div>
    <div><label>Room</label><input name="room" value="${esc(c?.room)}"></div>
    <div><label>Class teacher</label><select name="class_teacher_id"><option value="">—</option>${staff.map((t) => `<option value="${t.id}" ${c?.class_teacher_id === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></div>
    ${c ? `<div class="full"><h3>Subject teachers</h3>${c.subjects.map((s) => `<div class="row">${esc(s.subject)}: ${esc(s.teacher_name || '–')} <a href="#" data-rm="${s.id}">remove</a></div>`).join('')}
      <div class="row" style="margin-top:8px"><input id="subj" placeholder="Subject"><select id="subt">${staff.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select><button type="button" class="btn small" id="addsub">Add</button></div></div>` : ''}
    <div class="full row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#cf', m).onsubmit = async (e) => {
      e.preventDefault(); const b = formData(e.target);
      if (c) await act(() => S('/classes/' + c.id, { method: 'PATCH', body: b }), 'Saved'); else await act(() => S('/classes', { body: b }), 'Class added');
      closeModal(); render();
    };
    if (c) {
      $('#addsub', m).onclick = async () => { await act(() => S(`/classes/${c.id}/subjects`, { body: { subject: $('#subj', m).value, teacher_id: $('#subt', m).value } }), 'Subject added'); closeModal(); render(); };
      $$('[data-rm]', m).forEach((a) => a.onclick = async (e) => { e.preventDefault(); await act(() => S(`/classes/${c.id}/subjects/${a.dataset.rm}`, { method: 'DELETE' }), 'Removed'); closeModal(); render(); });
    }
  });
  if ($('#add')) $('#add').onclick = () => form(null);
  $$('[data-edit]').forEach((b) => b.onclick = () => form(rows.find((c) => c.id === b.dataset.edit)));
});

route('/class/:id', async ({ id }) => {
  const d = await S('/classes/' + id);
  const staff = ME.role === 'admin' ? await S('/staff') : [];
  view(`<div class="row between"><div><h1 style="margin:0">Class ${esc(d.class.name)}</h1><div class="muted">Class teacher: ${esc(d.class.class_teacher_name || '–')}${d.class.room ? ' · Room ' + esc(d.class.room) : ''}</div></div>
  <div class="row"><a class="btn" href="#/attendance/${id}">Attendance</a><a class="btn" href="#/register/${id}/${thisMonth()}">Monthly register</a>${ME.role === 'admin' ? '<button class="btn" id="rep">Replace teacher</button>' : ''}</div></div>
  <h2>Subject teachers</h2><div class="card">${d.subjects.map((s) => `${esc(s.subject)}: ${esc(s.teacher_name || '–')}`).join(' · ') || '<span class="muted">None</span>'}</div>
  <h2>Today: ${badge(d.today.status, d.today.status === 'submitted' ? 'ok' : 'warn')}</h2>
  <div class="table-wrap"><table><thead><tr><th>Reg</th><th>Student</th><th>Today</th>${d.fees ? '<th class="num">Fee this month</th><th>Status</th>' : ''}</tr></thead><tbody>
  ${d.students.map((s) => { const t = d.today.students.find((x) => x.id === s.id); const f = d.fees?.find((x) => x.student_name === s.name);
    return `<tr><td>${esc(s.reg_no)}</td><td><a href="#/student/${s.id}">${esc(s.name)}</a> ${s.status === 'pending' ? badge('pending', 'warn') : ''}</td><td>${d.today.status === 'new' ? '–' : STATUS[t?.status] || '–'}</td>
    ${d.fees ? `<td class="num">${f ? money(f.total) : '–'}</td><td>${f ? badge(f.status, VOUCHER_STATUS[f.status]) : ''}</td>` : ''}</tr>`; }).join('')}
  </tbody></table></div>
  <h2>Class teacher history</h2><div class="card small">${d.history.map((h) => `${esc(h.name)}: ${fmtDate(h.from_date)} – ${h.to_date ? fmtDate(h.to_date) : 'now'}`).join('<br>') || '–'}</div>`);
  const r = $('#rep'); if (r) r.onclick = () => modal(`<h2>Replace class teacher</h2><form id="rf" class="form">
    <div><label>New class teacher</label><select name="teacher_id">${staff.filter((t) => t.id !== d.class.class_teacher_id).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
    <div><label>From date</label><input type="date" name="from_date" value="${today()}"></div>
    <label class="full row"><input type="checkbox" name="subjects_too" value="1"> Also hand over the old teacher's subject periods in this class</label>
    <p class="full small muted">Past attendance and notices keep the old teacher's name.</p>
    <div class="full row"><button class="btn primary">Replace</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#rf', m).onsubmit = async (e) => { e.preventDefault(); const b = formData(e.target); await act(() => S(`/classes/${id}/replace-teacher`, { body: { ...b, subjects_too: !!b.subjects_too } }), 'Teacher replaced'); closeModal(); render(); };
  });
});

// ---------- attendance ----------
route('/attendance', async () => {
  const classes = await S('/classes');
  const mine = ME.isAdmin ? classes : classes.filter((c) => ME.classTeacherOf.includes(c.id));
  if (mine.length === 1 && !ME.isAdmin) return go('/attendance/' + mine[0].id);
  view(`<h1>Attendance</h1><div class="grid">${classes.map((c) => `<div class="stat"><div class="n" style="font-size:1.2rem">${esc(c.name)}</div><div class="l">${c.students} students</div>
  <div class="row" style="margin-top:8px">${ME.isAdmin || ME.classTeacherOf.includes(c.id) ? `<a class="btn small primary" href="#/attendance/${c.id}">Mark / view</a>` : ''}<a class="btn small" href="#/register/${c.id}/${thisMonth()}">Register</a></div></div>`).join('') || '<p class="muted">No classes</p>'}</div>
  ${ME.role === 'admin' ? '<h2>Holidays</h2><p><a href="#/settings?tab=holidays">Manage holiday calendar</a></p>' : ''}`);
});

const OUTBOX = 'att-outbox';
const outbox = () => { try { return JSON.parse(localStorage.getItem(OUTBOX) || '[]'); } catch { return []; } };
async function flushOutbox() {
  const items = outbox(); if (!items.length || !navigator.onLine) return;
  const left = [];
  for (const it of items) {
    try { await S(`/attendance/${it.classId}/${it.date}${it.submit ? '/submit' : ''}`, { method: it.submit ? 'POST' : 'PUT', body: { records: it.records } }); toast('Offline attendance synced'); }
    catch (e) { if (!e.status || e.status >= 500) left.push(it); else toast('Could not sync attendance: ' + e.message); }
  }
  try { localStorage.setItem(OUTBOX, JSON.stringify(left)); } catch {}
}
window.addEventListener('online', flushOutbox);
setInterval(flushOutbox, 60000);

route('/attendance/:id', async ({ id }) => {
  const date = query().date || today();
  const d = await S(`/attendance/${id}/${date}`);
  const canMark = ME.isAdmin || ME.classTeacherOf.includes(id);
  const locked = d.status === 'submitted' && !ME.isAdmin;
  const recs = Object.fromEntries(d.students.map((s) => [s.id, s.status]));
  const draftKey = `att-draft:${id}:${date}`;
  if (d.status !== 'submitted') { try { Object.assign(recs, JSON.parse(localStorage.getItem(draftKey) || '{}')); } catch {} }
  view(`<div class="row between"><div><h1 style="margin:0">Attendance — ${esc(d.class.name)}</h1>
  <div class="muted">${d.status === 'submitted' ? `Submitted ${fmtTime(d.submitted_at)}` : d.status === 'draft' ? 'Draft saved' : 'Everyone is present by default — tap only the exceptions.'}</div></div>
  <div class="row"><input type="date" id="dt" value="${date}" max="${today()}"><a class="btn" href="#/register/${id}/${date.slice(0, 7)}">Register</a></div></div>
  ${d.holiday ? `<div class="banner info" style="margin-top:12px">Holiday: ${esc(d.holiday)}</div>` : ''}
  ${locked ? '<div class="banner info" style="margin-top:12px">Submitted and final. To fix a mistake, tap a student to send a change request.</div>' : ''}
  ${d.status === 'submitted' && ME.isAdmin ? '<div class="banner info" style="margin-top:12px">Submitted. As admin, tap a status to correct it — a reason is recorded and the parent is told.</div>' : ''}
  <div class="att-list" style="margin-top:14px">${d.students.map((s) => `<div class="att-row"><div class="who"><b>${esc(s.name)}</b><div class="muted small">${esc(s.reg_no)} · s/o ${esc(s.father_name)}</div></div>
    <div class="att-btns" data-s="${s.id}">${Object.keys(STATUS).map((k) => `<button title="${STATUS[k]}" data-k="${k}" class="${k} ${recs[s.id] === k ? 'on' : ''}" ${!canMark || d.holiday ? 'disabled' : ''}>${k}</button>`).join('')}</div></div>`).join('') || '<p class="muted">No students in this class</p>'}</div>
  ${canMark && !d.holiday && d.status !== 'submitted' && d.students.length ? `<div class="row" style="margin-top:14px;position:sticky;bottom:10px"><button class="btn" id="save">Save draft</button><button class="btn primary" id="sub">Review & submit</button></div>` : ''}`);
  $('#dt').onchange = (e) => go(`/attendance/${id}?date=${e.target.value}`);
  const saveLocal = () => { try { localStorage.setItem(draftKey, JSON.stringify(recs)); } catch {} };
  $$('.att-btns').forEach((g) => g.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const sid = g.dataset.s, k = b.dataset.k;
    if (d.status === 'submitted') {
      if (ME.isAdmin) {
        const reason = prompt(`Change to ${STATUS[k]}. Reason?`); if (!reason) return;
        await act(() => S('/attendance/correct', { body: { student_id: sid, date, status: k, reason } }), 'Corrected; parent told'); return render();
      }
      const reason = prompt(`Request change to ${STATUS[k]}. Reason?`); if (!reason) return;
      await act(() => S('/change-requests', { body: { kind: 'attendance', student_id: sid, date, status: k, reason } }), 'Request sent to admin'); return;
    }
    recs[sid] = k; saveLocal();
    $$('button', g).forEach((x) => x.classList.toggle('on', x.dataset.k === k));
  });
  const send = async (submit) => {
    try {
      await S(`/attendance/${id}/${date}${submit ? '/submit' : ''}`, { method: submit ? 'POST' : 'PUT', body: { records: recs } });
      try { localStorage.removeItem(draftKey); } catch {}
      toast(submit ? 'Submitted — parents of absent and late students are being told' : 'Draft saved');
    } catch (e) {
      if (!e.status || e.status === 503) {
        const ob = outbox().filter((x) => !(x.classId === id && x.date === date)); ob.push({ classId: id, date, records: recs, submit });
        try { localStorage.setItem(OUTBOX, JSON.stringify(ob)); } catch {}
        toast('You are offline. Saved on this device; it will sync automatically.');
      } else toast(e.message);
    }
    render();
  };
  const sv = $('#save'); if (sv) sv.onclick = () => send(false);
  const sb = $('#sub'); if (sb) sb.onclick = () => {
    const c = { P: 0, A: 0, L: 0, V: 0 }; for (const s of d.students) c[recs[s.id] || 'P']++;
    const list = (k) => d.students.filter((s) => recs[s.id] === k).map((s) => esc(s.name)).join(', ');
    modal(`<h2>Confirm attendance</h2><p>${d.class.name} · ${fmtDate(date)}</p>
    <div class="grid"><div class="stat"><div class="n">${c.P}</div><div class="l">Present</div></div><div class="stat"><div class="n">${c.A}</div><div class="l">Absent</div></div>
    <div class="stat"><div class="n">${c.L}</div><div class="l">Late</div></div><div class="stat"><div class="n">${c.V}</div><div class="l">Leave</div></div></div>
    ${c.A ? `<p class="small"><b>Absent:</b> ${list('A')}</p>` : ''}${c.L ? `<p class="small"><b>Late:</b> ${list('L')}</p>` : ''}
    <p class="small muted">After submitting, it is final for you. Parents of absent and late students are told at once.</p>
    <div class="row"><button class="btn primary" id="ok">Confirm and submit</button><button class="btn" data-close>Back</button></div>`, (m) => { $('#ok', m).onclick = () => { closeModal(); send(true); }; });
  };
});

route('/register/:id/:month', async ({ id, month }) => {
  const d = await S(`/register/${id}/${month}`);
  const [y, m] = month.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7), next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  view(`<div class="row between"><h1>Register — ${esc(d.class.name)} — ${esc(month)}</h1><div class="row no-print">
  <a class="btn small" href="#/register/${id}/${prev}">‹ Prev</a><a class="btn small" href="#/register/${id}/${next}">Next ›</a><button class="btn small" id="csv">CSV / Excel</button><button class="btn small" onclick="print()">PDF / Print</button></div></div>
  <div class="table-wrap"><table><thead><tr><th>Student</th>${d.dates.map((x) => `<th>${Number(x.slice(8))}</th>`).join('')}<th class="num">%</th><th>Warning</th></tr></thead><tbody>
  ${d.rows.map((r) => `<tr><td><a href="#/student/${r.id}">${esc(r.name)}</a></td>${d.dates.map((x) => `<td>${r.days[x] || ''}</td>`).join('')}<td class="num">${r.percent ?? '–'}</td><td>${r.warning ? badge(r.warning, 'bad') : ''}</td></tr>`).join('')}
  </tbody></table></div><p class="small muted">P present · A absent · L late · V leave</p>`);
  $('#csv').onclick = () => download(`register-${d.class.name}-${month}.csv`, csv([['reg_no', 'name', ...d.dates, 'percent'], ...d.rows.map((r) => [r.reg_no, r.name, ...d.dates.map((x) => r.days[x] || ''), r.percent ?? ''])]));
});

// ---------- fees ----------
const feeTabs = (active) => `<div class="tabs">${[['/fees', 'Overview'], ['/fees/unpaid', 'Unpaid list'], ['/fees/slips', 'Slips waiting'], ...(ME.canFees ? [['/fees/defaulters', 'Long-term defaulters'], ['/fees/report', 'Reports']] : []), ...(ME.canFees || ME.settings.teacher_set_fees === '1' ? [['/fees/setup', 'Fee setup']] : [])]
  .map(([h, l]) => `<a href="#${h}" class="${active === h ? 'active' : ''}">${l}</a>`).join('')}</div>`;

route('/fees', async () => {
  const [unpaid, slips] = await Promise.all([S('/fees/unpaid'), S('/payments?status=submitted')]);
  const rep = ME.canFees ? await S('/fees/report') : null;
  view(`<h1>Fees</h1>${feeTabs('/fees')}
  <div class="grid">
    ${rep ? `<div class="stat"><div class="n">${money(rep.collected)}</div><div class="l">Collected in ${esc(rep.month)}</div></div><div class="stat"><div class="n">${money(rep.expected)}</div><div class="l">Expected this month</div></div>` : ''}
    <a class="stat" href="#/fees/unpaid"><div class="n">${unpaid.length}</div><div class="l">Unpaid vouchers this month</div></a>
    <a class="stat" href="#/fees/slips"><div class="n">${slips.filter((s) => s.method !== 'cash_teacher').length}</div><div class="l">Slips waiting</div></a>
  </div>
  ${ME.canFees ? `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Generate vouchers</h3><p class="small muted">Vouchers are created automatically on day ${esc(ME.settings.voucher_day)} of each month. You can also create them now; students who already have one are skipped.</p>
  <div class="row"><input type="month" id="gm" value="${thisMonth()}"><button class="btn primary" id="gen">Generate</button></div></div>` : ''}`);
  const g = $('#gen'); if (g) g.onclick = async () => { const r = await act(() => S('/fees/generate', { body: { month: $('#gm').value } })); toast(`${r.created} voucher(s) created`); render(); };
});

route('/fees/unpaid', async () => {
  const month = query().month || thisMonth();
  const classes = await S('/classes');
  const cls = query().class_id || '';
  const rows = await S(`/fees/unpaid?month=${month}${cls ? '&class_id=' + cls : ''}`);
  view(`<h1>Unpaid list</h1>${feeTabs('/fees/unpaid')}
  <div class="row card"><input type="month" id="m" value="${month}"><select id="c"><option value="">All classes</option>${classes.map((c) => `<option value="${c.id}" ${cls === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
  <button class="btn" id="csv">Download CSV</button><button class="btn" onclick="print()">PDF / Print</button><button class="btn primary" id="remall">Remind everyone on this list</button></div>
  <div class="table-wrap"><table><thead><tr><th>Student</th><th>Reg</th><th>Class</th><th class="hide-sm">Parent phone</th><th class="num">Due</th><th class="num">Paid</th><th class="num">Balance</th><th class="num">Days late</th><th>Last reminder</th><th></th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td><a href="#/student/${r.student_id}?tab=fees">${esc(r.name)}</a> ${r.student_status === 'left' ? badge('left with dues', 'warn') : ''}</td><td>${esc(r.reg_no)}</td><td>${esc(r.class_name)}</td><td class="hide-sm">${esc(r.parent_phone)}</td>
  <td class="num">${money(r.due)}</td><td class="num">${money(r.paid)}</td><td class="num"><b>${r.status === 'carried' ? 'carried' : money(r.balance)}</b></td><td class="num">${r.days_overdue}</td><td>${fmtTime(r.last_reminder) || '–'}</td>
  <td><button class="btn small" data-rem="${r.id}">Remind</button></td></tr>`).join('') || '<tr><td colspan="10" class="muted">Nothing unpaid 🎉</td></tr>'}
  </tbody></table></div><p class="small muted">Total balance: <b>${money(rows.filter((r) => r.status !== 'carried').reduce((t, r) => t + r.balance, 0))}</b></p>`);
  const reload = () => go(`/fees/unpaid?month=${$('#m').value}&class_id=${$('#c').value}`);
  $('#m').onchange = reload; $('#c').onchange = reload;
  $('#csv').onclick = () => download(`unpaid-${month}.csv`, csv([['name', 'reg_no', 'class', 'parent_phone', 'month', 'due', 'paid', 'balance', 'days_overdue'], ...rows.map((r) => [r.name, r.reg_no, r.class_name, r.parent_phone, r.month, r.due, r.paid, r.balance, r.days_overdue])]));
  $$('[data-rem]').forEach((b) => b.onclick = async () => { await act(() => S('/fees/remind', { body: { voucher_ids: [b.dataset.rem] } }), 'Reminder sent'); });
  $('#remall').onclick = async () => { if (!confirm(`Send a reminder to ${rows.length} parent(s)?`)) return; const r = await act(() => S('/fees/remind', { body: { voucher_ids: rows.filter((x) => x.status !== 'carried').map((x) => x.id) } })); toast(`${r.sent} reminder(s) sent`); };
});

route('/fees/slips', async () => {
  const status = query().status || 'submitted';
  const rows = (await S('/payments?status=' + status)).filter((r) => status !== 'submitted' || r.method !== 'cash_teacher');
  view(`<h1>Payment slips</h1>${feeTabs('/fees/slips')}
  <div class="row" style="margin-bottom:10px">${['submitted', 'verified', 'rejected', 'cancelled'].map((s) => `<a class="btn small ${s === status ? 'primary' : ''}" href="#/fees/slips?status=${s}">${s}</a>`).join('')}</div>
  <div class="table-wrap"><table><thead><tr><th>When</th><th>Student</th><th>Class</th><th>Method</th><th class="num">Amount</th><th>Txn ID</th><th>Slip</th><th></th></tr></thead><tbody>
  ${rows.map((p) => `<tr><td>${fmtTime(p.created_at)}</td><td><a href="#/student/${p.student_id}?tab=fees">${esc(p.student_name)}</a></td><td>${esc(p.class_name)}</td><td>${esc(p.method.replace('_', ' '))}</td><td class="num">${money(p.amount)}</td>
  <td>${esc(p.txn_id || '')}</td><td>${p.slip_key ? `<a target="_blank" href="/files/${esc(p.slip_key.split('/').slice(1).join('/'))}">View</a>` : ''}</td>
  <td class="row">${p.status === 'submitted' && p.can_verify ? `<button class="btn small primary" data-v="${p.id}">Verify</button><button class="btn small danger" data-r="${p.id}">Reject</button>` : p.receipt_no ? `<a href="#/receipt/${p.id}">#${p.receipt_no}</a>` : esc(p.reason || '')}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">Nothing here</td></tr>'}
  </tbody></table></div><p class="small muted">Check each slip against the school's Easypaisa/JazzCash account before verifying. Duplicate transaction IDs are blocked automatically.</p>`);
  $$('[data-v]').forEach((b) => b.onclick = async () => { const r = await act(() => S(`/payments/${b.dataset.v}/verify`, { body: {} })); toast(`Verified — receipt #${r.receipt}`); render(); });
  $$('[data-r]').forEach((b) => b.onclick = async () => { const reason = prompt('Why is this slip rejected? The parent will see this.'); if (!reason) return; await act(() => S(`/payments/${b.dataset.r}/reject`, { body: { reason } }), 'Rejected'); render(); });
});

route('/fees/defaulters', async () => {
  const rows = await S('/fees/defaulters');
  view(`<h1>Long-term defaulters</h1>${feeTabs('/fees/defaulters')}<p class="muted">Students unpaid for 2 months or more.</p>
  <div class="table-wrap"><table><thead><tr><th>Student</th><th>Reg</th><th>Class</th><th class="num">Months unpaid</th><th class="num">Balance</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td><a href="#/student/${r.id}?tab=fees">${esc(r.name)}</a> ${r.status === 'left' ? badge('left', 'warn') : ''}</td><td>${esc(r.reg_no)}</td><td>${esc(r.class_name)}</td><td class="num">${r.months}</td><td class="num">${money(r.balance)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None</td></tr>'}
  </tbody></table></div>`);
});

route('/fees/report', async () => {
  const month = query().month || thisMonth();
  const r = await S('/fees/report?month=' + month);
  const days = {}; for (const x of r.daily) days[x.day] = (days[x.day] || 0) + x.amount;
  view(`<h1>Fee report</h1>${feeTabs('/fees/report')}
  <div class="row card"><input type="month" id="m" value="${month}"><button class="btn" onclick="print()">Print</button><button class="btn" id="csv">CSV</button></div>
  <div class="grid"><div class="stat"><div class="n">${money(r.collected)}</div><div class="l">Collected</div></div><div class="stat"><div class="n">${money(r.expected)}</div><div class="l">Expected (this month's fees)</div></div>
  <div class="stat"><div class="n">${r.expected ? Math.round((100 * r.collected) / r.expected) : 0}%</div><div class="l">Collected vs expected</div></div><div class="stat"><div class="n">${r.paid}/${r.vouchers}</div><div class="l">Vouchers fully paid</div></div></div>
  <h2>Daily collection</h2><div class="table-wrap"><table><thead><tr><th>Day</th><th>Method</th><th class="num">Payments</th><th class="num">Amount</th></tr></thead><tbody>
  ${r.daily.map((x) => `<tr><td>${fmtDate(x.day)}</td><td>${esc(x.method.replace('_', ' '))}</td><td class="num">${x.n}</td><td class="num">${money(x.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No payments yet</td></tr>'}
  </tbody></table></div>`);
  $('#m').onchange = (e) => go('/fees/report?month=' + e.target.value);
  $('#csv').onclick = () => download(`collection-${month}.csv`, csv([['day', 'method', 'payments', 'amount'], ...r.daily.map((x) => [x.day, x.method, x.n, x.amount])]));
});

route('/fees/setup', async () => {
  const d = await S('/fees/setup');
  const amount = (c, h) => d.plans.find((p) => p.class_id === c && p.head_id === h)?.amount ?? '';
  view(`<h1>Fee setup</h1>${feeTabs('/fees/setup')}
  <p class="muted">Set each class's monthly fee. Saving also updates this month's vouchers that are not paid yet. For one student's own amount, open the student → Fees → <i>Set this student's fee</i>.</p>
  <div class="table-wrap"><table><thead><tr><th>Class</th>${d.heads.map((h) => `<th class="num">${esc(h.name)}${h.monthly ? '' : ' <span class="muted small">(one-off)</span>'}</th>`).join('')}</tr></thead><tbody>
  ${d.classes.map((c) => `<tr><td>${esc(c.name)}</td>${d.heads.map((h) => `<td class="num"><input type="number" min="0" style="width:110px" data-c="${c.id}" data-h="${h.id}" value="${amount(c.id, h.id)}" ${d.editable.includes(c.id) ? '' : 'disabled'}></td>`).join('')}</tr>`).join('') || '<tr><td class="muted">Create classes first</td></tr>'}
  </tbody></table></div>
  ${d.editable.length ? '<div class="row" style="margin-top:12px"><button class="btn primary" id="save">Save fee plan</button></div>' : ''}
  ${ME.role === 'admin' ? `<div class="card" style="margin-top:16px"><h3 style="margin-top:0">Add a fee head</h3><div class="row"><input id="hn" placeholder="e.g. Computer lab"><label class="row" style="margin:0"><input type="checkbox" id="hm" checked> Monthly</label><button class="btn" id="addh">Add</button></div></div>` : ''}`);
  const s = $('#save'); if (s) s.onclick = async () => {
    const plans = $$('input[data-c]').filter((i) => i.value !== '' && !i.disabled).map((i) => ({ class_id: i.dataset.c, head_id: i.dataset.h, amount: Number(i.value) }));
    await act(() => S('/fees/plans', { body: { plans } }), 'Fee plan saved');
  };
  const ah = $('#addh'); if (ah) ah.onclick = async () => { await act(() => S('/fees/heads', { body: { name: $('#hn').value, monthly: $('#hm').checked } }), 'Added'); render(); };
});

route('/cash', async () => {
  const d = await S('/cash');
  view(`<h1>Cash held by teachers</h1>
  ${d.teachers.map((t) => `<div class="card"><div class="row between"><h3 style="margin:0">${esc(t.name)} — ${money(t.total)}</h3>${ME.canFees ? `<button class="btn primary" data-t="${t.teacher_id}" data-a="${t.total}">Confirm handover</button>` : ''}</div>
  <div class="table-wrap" style="margin-top:10px"><table><tbody>${t.items.map((i) => `<tr><td>${fmtTime(i.created_at)}</td><td>${esc(i.student_name)}</td><td>${esc(i.class_name)}</td><td class="num">${money(i.amount)}</td></tr>`).join('')}</tbody></table></div></div>`).join('') || '<div class="card muted">No cash is being held.</div>'}
  <h2>Recent handovers</h2><div class="table-wrap"><table><tbody>${d.handovers.map((h) => `<tr><td>${fmtTime(h.created_at)}</td><td>${esc(h.name)}</td><td class="num">${money(h.amount)}</td></tr>`).join('') || '<tr><td class="muted">None</td></tr>'}</tbody></table></div>`);
  $$('[data-t]').forEach((b) => b.onclick = async () => {
    if (!confirm(`Confirm you received ${money(b.dataset.a)} from this teacher?`)) return;
    await act(() => S('/cash/handover', { body: { teacher_id: b.dataset.t, amount: Number(b.dataset.a) } }), 'Handover confirmed; receipts issued'); render();
  });
});

// ---------- notices ----------
function noticeItem(n) {
  const aud = { school: 'Whole school', class: 'Class ' + (n.target_name || ''), student: 'Parents of ' + (n.target_name || ''), teachers: 'All teachers', admins: 'Admins' }[n.audience];
  return `<div class="list-item"><div class="row between"><b>${esc(n.title)}</b>${ME.role === 'admin' ? `<a href="#" data-deln="${n.id}" class="small">remove</a>` : ''}</div>
  <div style="white-space:pre-wrap">${esc(n.body)}</div><div class="muted small">${esc(aud)} · ${esc(n.poster_name || '')} · ${fmtTime(n.created_at)}${n.read_count !== undefined ? ` · read by ${n.read_count}` : ''}</div></div>`;
}
route('/notices', async () => {
  const [rows, classes] = await Promise.all([S('/notices'), ME.kind === 'staff' ? S('/classes') : []]);
  view(`<div class="row between"><h1>Notices</h1>${ME.kind === 'staff' ? '<button class="btn primary" id="new">New notice</button>' : ''}</div>
  <div class="card">${rows.map(noticeItem).join('') || '<span class="muted">No notices yet</span>'}</div>`);
  for (const n of rows) S(`/notices/${n.id}/read`, { body: {} }).catch(() => {});
  $$('[data-deln]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); if (!confirm('Remove this notice?')) return; await act(() => S('/notices/' + a.dataset.deln, { method: 'DELETE' }), 'Removed'); render(); });
  const nb = $('#new'); if (nb) nb.onclick = () => modal(`<h2>New notice</h2><form id="nf" class="form">
    <div><label>Send to</label><select name="audience" id="aud">
      ${ME.role === 'admin' || ME.subrole === 'office' ? '<option value="school">Whole school (all parents and staff)</option>' : ''}
      <option value="class">One class</option><option value="student">One student's parents</option>
      ${ME.role === 'admin' || ME.subrole === 'coordinator' ? '<option value="teachers">All teachers</option>' : ''}${ME.isMainAdmin ? '<option value="admins">Admins only</option>' : ''}</select></div>
    <div id="tc"><label>Class</label><select name="target_class">${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div id="ts" class="hidden"><label>Student (reg no or name)</label><input id="sq" placeholder="Type to search"><input type="hidden" name="target_student" id="sid"><div id="sres" class="small"></div></div>
    <div class="full"><label>Title</label><input name="title" required></div>
    <div class="full"><label>Message (English or Urdu)</label><textarea name="body" required dir="auto"></textarea></div>
    <p class="full small muted">Sent as an app notification. WhatsApp/SMS is a paid add-on.</p>
    <div class="full row"><button class="btn primary">Send</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    const sync = () => { const a = $('#aud', m).value; $('#tc', m).classList.toggle('hidden', a !== 'class'); $('#ts', m).classList.toggle('hidden', a !== 'student'); };
    $('#aud', m).onchange = sync; sync();
    $('#sq', m).oninput = async (e) => {
      const r = await S('/search?q=' + encodeURIComponent(e.target.value)).catch(() => ({ students: [] }));
      $('#sres', m).innerHTML = r.students.slice(0, 6).map((s) => `<a href="#" data-id="${s.id}">${esc(s.name)} (${esc(s.class_name)})</a>`).join(' · ');
      $$('a', $('#sres', m)).forEach((a) => a.onclick = (ev) => { ev.preventDefault(); $('#sid', m).value = a.dataset.id; $('#sq', m).value = a.textContent; $('#sres', m).innerHTML = ''; });
    };
    $('#nf', m).onsubmit = async (e) => {
      e.preventDefault(); const b = formData(e.target);
      const target_id = b.audience === 'class' ? b.target_class : b.audience === 'student' ? b.target_student : null;
      const r = await act(() => S('/notices', { body: { audience: b.audience, target_id, title: b.title, body: b.body } }));
      toast(`Sent to ${r.recipients} people`); closeModal(); render();
    };
  });
});

// ---------- messages ----------
route('/threads', async () => {
  const rows = await S('/threads');
  const kids = ME.kind === 'guardian' ? ME.children : [];
  view(`<h1>Messages</h1><p class="muted small">One conversation per student between the parent and the student's teachers. The school admin can read all of them. Phone numbers stay private.</p>
  ${kids.length ? `<div class="row" style="margin-bottom:12px">${kids.map((k) => `<a class="btn" href="#/thread/${k.id}">Message ${esc(k.name)}'s teachers</a>`).join('')}</div>` : ''}
  <div class="card">${rows.map((r) => `<a class="list-item" style="display:block;color:inherit" href="#/thread/${r.student_id}"><b>${esc(r.name)}</b> <span class="muted small">· ${esc(r.class_name)} · ${fmtTime(r.created_at)}</span><div class="muted small">${esc(r.sender_name)}: ${esc(r.body.slice(0, 120))}</div></a>`).join('') || '<span class="muted">No conversations yet. Open a student and choose Messages to start one.</span>'}</div>`);
});
route('/thread/:id', async ({ id }) => {
  const d = await S('/threads/' + id);
  const myKey = (ME.kind === 'guardian' ? 'g:' : 's:') + ME.id;
  view(`<div class="row between"><h1>Messages about ${esc(d.student.name)}</h1>${ME.kind === 'staff' ? `<a class="btn" href="#/student/${id}">Profile</a>` : ''}</div>
  <div class="card"><div class="msgs" id="msgs">${d.messages.map((m) => `<div class="msg ${m.sender_key === myKey ? 'me' : ''}"><div class="who">${esc(m.sender_name)} · ${fmtTime(m.created_at)}</div><div style="white-space:pre-wrap" dir="auto">${esc(m.body)}</div></div>`).join('') || '<p class="muted">No messages yet.</p>'}</div>
  <form id="mf" class="row" style="margin-top:12px"><textarea name="body" required placeholder="Write a message" style="flex:1;min-height:48px" dir="auto"></textarea><button class="btn primary">Send</button></form></div>`);
  const box = $('#msgs'); box.scrollTop = box.scrollHeight;
  $('#mf').onsubmit = async (e) => { e.preventDefault(); await act(() => S('/threads/' + id, { body: formData(e.target) })); render(); };
});

// ---------- results ----------
route('/results', async () => {
  const [rows, classes] = await Promise.all([S('/results'), S('/classes')]);
  const groups = {};
  for (const r of rows) { const k = `${r.class_id || 'none'}|${r.title}`; (groups[k] ||= { class_id: r.class_id, class_name: r.class_name || 'Unmatched', title: r.title, items: [] }).items.push(r); }
  const canUpload = ME.isAdmin || (ME.settings.teacher_upload_results === '1' && ME.classTeacherOf.length);
  view(`<div class="row between"><h1>Results</h1>${canUpload ? '<button class="btn primary" id="up">Upload results</button>' : ''}</div>
  <p class="muted small">Upload one PDF per student. Files named by registration number (e.g. <code>2026-0142.pdf</code>) go to the right student automatically. Results stay hidden from parents until you press Publish.</p>
  ${Object.values(groups).map((g) => { const hidden = g.items.filter((x) => !x.published_at).length;
    return `<div class="card"><div class="row between"><h3 style="margin:0">${esc(g.class_name)} — ${esc(g.title)}</h3>
    ${ME.isAdmin && g.class_id && hidden ? `<button class="btn primary small" data-pub="${g.class_id}" data-title="${esc(g.title)}">Publish ${hidden} to parents</button>` : hidden ? '' : badge('published', 'ok')}</div>
    <div class="table-wrap" style="margin-top:10px"><table><tbody>${g.items.map((r) => `<tr><td>${r.student_id ? `<a href="#/student/${r.student_id}?tab=results">${esc(r.student_name)}</a> <span class="muted small">${esc(r.reg_no)}</span>` : `<b>${esc(r.file_name)}</b> ${ME.isAdmin ? `<button class="btn small" data-assign="${r.id}">Assign to student</button>` : ''}`}</td>
    <td>${r.published_at ? badge('published', 'ok') : badge('hidden', 'warn')}</td><td><a target="_blank" href="/api/s/result-file/${r.id}">Open</a></td><td>${ME.role === 'admin' || !r.published_at ? `<a href="#" data-del="${r.id}" class="small">delete</a>` : ''}</td></tr>`).join('')}</tbody></table></div></div>`; }).join('') || '<div class="card muted">No results uploaded yet.</div>'}`);
  const up = $('#up'); if (up) up.onclick = () => modal(`<h2>Upload results</h2><form id="uf" class="form">
    <div><label>Title</label><input name="title" placeholder="Mid-term 2026" required></div><div><label>Session</label><input name="session" placeholder="2026-2027"></div>
    <div class="full"><label>PDF files (one per student, named by registration number)</label><input type="file" name="files" multiple accept="application/pdf" required></div>
    <div class="full row"><button class="btn primary">Upload</button><button type="button" class="btn" data-close>Cancel</button></div><div class="full" id="out"></div></form>`, (m) => {
    $('#uf', m).onsubmit = async (e) => {
      e.preventDefault();
      const r = await act(() => S('/results', { form: new FormData(e.target) }));
      $('#out', m).innerHTML = r.results.map((x) => `<div class="small">${x.ok ? '✓' : '⚠'} ${esc(x.file)} ${x.ok ? '→ ' + esc(x.student) : '— ' + esc(x.error)}</div>`).join('') + '<button type="button" class="btn" data-close>Done</button>';
      $$('[data-close]', m).forEach((b) => b.onclick = () => { closeModal(); render(); });
    };
  });
  $$('[data-pub]').forEach((b) => b.onclick = async () => { const r = await act(() => S('/results/publish', { body: { class_id: b.dataset.pub, title: b.dataset.title } })); toast(`Published ${r.published}; parents notified`); render(); });
  $$('[data-del]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); if (!confirm('Delete this result? It goes to the recycle bin for 30 days.')) return; await act(() => S('/results/' + a.dataset.del, { method: 'DELETE' }), 'Deleted'); render(); });
  $$('[data-assign]').forEach((b) => b.onclick = async () => {
    const q = prompt('Registration number of the student?'); if (!q) return;
    const r = await S('/search?q=' + encodeURIComponent(q)); const s = r.students.find((x) => x.reg_no === q) || r.students[0];
    if (!s) return toast('No student found');
    if (!confirm(`Assign to ${s.name} (${s.reg_no}, ${s.class_name})?`)) return;
    await act(() => S(`/results/${b.dataset.assign}/assign`, { body: { student_id: s.id } }), 'Assigned'); render();
  });
});

// ---------- change requests ----------
route('/requests', async () => {
  const rows = await S('/change-requests');
  view(`<h1>Change requests</h1><div class="table-wrap"><table><thead><tr><th>When</th><th>From</th><th>Student</th><th>Request</th><th>Status</th><th></th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${fmtTime(r.created_at)}</td><td>${esc(r.requested_by_name || '')}</td><td><a href="#/student/${r.ref}">${esc(r.student_name || '')}</a></td>
  <td>${r.kind === 'attendance' ? `Attendance ${esc(r.detail.date)} → <b>${STATUS[r.detail.status]}</b><br>` : ''}<span class="small">${esc(r.reason)}</span></td>
  <td>${badge(r.status, r.status === 'approved' ? 'ok' : r.status === 'declined' ? 'bad' : 'warn')}</td>
  <td class="row">${ME.isAdmin && r.status === 'open' ? `<button class="btn small primary" data-a="${r.id}">Approve</button><button class="btn small" data-d="${r.id}">Decline</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No requests</td></tr>'}
  </tbody></table></div>${ME.isAdmin ? '<p class="small muted">Student detail requests: open the student and edit the record, then approve.</p>' : ''}`);
  $$('[data-a]').forEach((b) => b.onclick = async () => { await act(() => S(`/change-requests/${b.dataset.a}/decide`, { body: { approve: true } }), 'Approved'); render(); });
  $$('[data-d]').forEach((b) => b.onclick = async () => { await act(() => S(`/change-requests/${b.dataset.d}/decide`, { body: { approve: false } }), 'Declined'); render(); });
});

// ---------- WhatsApp / SMS from the admin's own phone ----------
const intlPhone = (p) => { const d = String(p).replace(/\D/g, ''); return d.startsWith('0') ? '92' + d.slice(1) : d; };
route('/outbox', async () => {
  const sentView = query().status === 'sent';
  const [rows, classes] = await Promise.all([S('/outbox' + (sentView ? '?status=sent' : '')), S('/classes')]);
  ME.outbox = sentView ? ME.outbox : rows.length;
  // Same text → one group, so SMS can go to many numbers at once.
  const groups = {};
  for (const r of rows) (groups[r.text] ||= []).push(r);
  view(`<div class="row between"><h1>WhatsApp / SMS</h1><div class="row">
    <a class="btn ${sentView ? '' : 'primary'}" href="#/outbox">To send (${sentView ? '…' : rows.length})</a><a class="btn ${sentView ? 'primary' : ''}" href="#/outbox?status=sent">Sent</a>
    <button class="btn" id="compose">New message</button></div></div>
  <p class="muted small">These go out from <b>your own phone number</b>, using WhatsApp or SMS on this device, so there's no extra cost. Tap <b>WhatsApp</b>: the chat opens with the text ready, you press send, and it's marked done. On a phone, <b>SMS to all</b> sends one text to the whole group.</p>
  ${sentView ? `<div class="table-wrap"><table><tbody>${rows.map((r) => `<tr><td>${fmtTime(r.sent_at)}</td><td>${esc(r.name)} <span class="muted small">${esc(r.kind)} · ${esc(r.phone)}</span></td><td>${badge(r.status === 'sent' ? r.channel || 'sent' : 'skipped', r.status === 'sent' ? 'ok' : '')}</td><td class="small" style="white-space:pre-wrap">${esc(r.text)}</td></tr>`).join('') || '<tr><td class="muted">Nothing yet</td></tr>'}</tbody></table></div>`
  : Object.entries(groups).map(([text, list], gi) => `<div class="card"><div class="row between"><div style="white-space:pre-wrap;flex:1" dir="auto">${esc(text)}</div>
    <div class="row">${list.length > 1 ? `<a class="btn small" data-smsall="${gi}" href="sms:${list.map((r) => r.phone).join(',')}?body=${encodeURIComponent(text)}">SMS to all ${list.length}</a>` : ''}<button class="btn small" data-skipall="${gi}">Skip all</button></div></div>
    <div class="table-wrap" style="margin-top:10px"><table><tbody>${list.map((r) => `<tr id="r_${r.id}"><td>${esc(r.name)} <span class="muted small">${esc(r.kind)}</span></td><td>${esc(r.phone)}</td>
    <td class="row"><a class="btn small primary" target="_blank" data-send="${r.id}" data-ch="whatsapp" href="https://wa.me/${intlPhone(r.phone)}?text=${encodeURIComponent(r.text)}">WhatsApp</a>
    <a class="btn small" data-send="${r.id}" data-ch="sms" href="sms:${esc(r.phone)}?body=${encodeURIComponent(r.text)}">SMS</a></td></tr>`).join('')}</tbody></table></div></div>`).join('') || '<div class="card muted">Nothing to send. Absence alerts, fee reminders, receipts and notices show up here automatically.</div>'}`);
  const glist = Object.values(groups);
  const mark = (ids, channel, status = 'sent') => S('/outbox/mark', { body: { ids, channel, status } }).catch(() => {});
  $$('[data-send]').forEach((a) => a.addEventListener('click', () => { mark([a.dataset.send], a.dataset.ch); const tr = $('#r_' + a.dataset.send); if (tr) tr.style.opacity = '.4'; }));
  $$('[data-smsall]').forEach((a) => a.addEventListener('click', () => { mark(glist[a.dataset.smsall].map((r) => r.id), 'sms'); setTimeout(render, 1500); }));
  $$('[data-skipall]').forEach((b) => b.onclick = async () => { await mark(glist[b.dataset.skipall].map((r) => r.id), null, 'skipped'); render(); });
  $('#compose').onclick = () => modal(`<h2>New WhatsApp / SMS</h2><form id="cf" class="form">
    <div><label>To</label><select name="to"><option value="parents">Parents</option><option value="teachers">Teachers</option><option value="all">Parents and teachers</option></select></div>
    <div><label>Class (parents only)</label><select name="class_id"><option value="">All classes</option>${classes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
    <div class="full"><label>Title</label><input name="title" required></div><div class="full"><label>Message (English or Urdu)</label><textarea name="text" required dir="auto"></textarea></div>
    <div class="full row"><button class="btn primary">Add to send list</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#cf', m).onsubmit = async (e) => { e.preventDefault(); const r = await act(() => S('/outbox/compose', { body: formData(e.target) })); toast(`${r.queued} message(s) ready to send`); closeModal(); render(); };
  });
});

// ---------- notifications ----------
route('/notifications', async () => {
  const rows = await S('/notifications');
  view(`<h1>Notifications</h1><div class="card">${rows.map((n) => `<div class="list-item">${n.read_at ? '' : '<span class="dot"></span> '}<b>${esc(n.title)}</b> <span class="muted small">· ${fmtTime(n.created_at)}</span>
  <div>${esc(n.body)}</div>${n.link ? `<a class="small" href="${esc(n.link)}">Open</a>` : ''}</div>`).join('') || '<span class="muted">Nothing yet</span>'}</div>`);
  await S('/notifications/read', { body: {} }).catch(() => {});
  ME.unread = 0;
});

// ---------- settings ----------
route('/settings', async () => {
  const tab = query().tab || 'general';
  const tabs = [['general', 'General'], ...(ME.role === 'admin' ? [['payments', 'Payment accounts']] : []), ['holidays', 'Holidays'], ...(ME.isMainAdmin ? [['devices', 'Signed-in devices'], ['promotion', 'Year-end promotion'], ['storage', 'Storage'], ['data', 'Backup & export']] : []), ['audit', 'Audit log']];
  let body = '';
  if (tab === 'general') {
    const { settings: s, schoolName } = await S('/settings');
    const f = (k, label, type = 'number', help = '') => `<div><label>${label}</label><input name="${k}" type="${type}" value="${esc(s[k])}">${help ? `<div class="small muted">${help}</div>` : ''}</div>`;
    const t = (k, label) => `<label class="row" style="margin:0"><input type="checkbox" name="${k}" value="1" ${s[k] === '1' ? 'checked' : ''}> ${label}</label>`;
    body = `<form id="sf" class="card form">
      <div class="full"><label>School name</label><input name="schoolName" value="${esc(schoolName)}"></div>
      ${f('voucher_day', 'Voucher day of month')}${f('due_day', 'Fee due day of month')}<div class="full"><h3 style="margin-bottom:4px">Late fee fine (optional)</h3><p class="small muted" style="margin:0">Off unless you turn it on. Added automatically after the due date, every month a voucher stays unpaid. You can also add, change or waive a fine on any single voucher from the student's Fees tab.</p></div>
      <div class="full">${t('fine_enabled', 'Charge a late fine automatically')}</div>
      ${f('fine_fixed', 'Fine once after due date (Rs)')}${f('fine_per_day', 'Fine per day late (Rs)')}${f('fine_per_month', 'Fine for each month late (Rs)')}${f('fine_max', 'Maximum fine per voucher (Rs, 0 = no limit)')}
      ${f('defaulter_months', 'Flag as long-term unpaid after (months)')}
      <div class="full"><h3 style="margin-bottom:0">Other</h3></div>
      ${f('reminder_days_before', 'Fee reminder: days before due date')}${f('attendance_deadline_hour', 'Attendance deadline (hour, 24h)', 'number', 'Class teachers are reminded after this hour')}
      ${f('cash_alert_days', 'Alert when cash held longer than (days)')}${f('low_attendance_percent', 'Low attendance warning below (%)')}
      ${f('reg_prefix', 'Registration number prefix', 'text', 'Empty = current year, e.g. 2026-0001')}
      <div class="full stack">${t('teacher_set_fees', 'Class teachers can set the fee for their own class and its students')}${t('teacher_add_students', 'Class teachers can add students to their own class (admin confirms)')}${t('teacher_verify_slips', 'Class teachers can verify payment slips for their class')}
      ${t('phone_messages', 'Queue WhatsApp/SMS for parents and teachers, sent from the admin\'s own phone')}${t('teacher_upload_results', 'Class teachers can upload results for their class')}${t('absence_alerts', 'Alert parents of absence and late arrival')}${t('result_fee_hold', 'Hide results until fees are cleared')}</div>
      ${ME.isMainAdmin ? '<div class="full"><button class="btn primary">Save settings</button></div>' : '<p class="full muted small">Only the main admin can change settings.</p>'}</form>`;
  }
  if (tab === 'holidays') {
    const rows = await S('/holidays');
    body = `${ME.role === 'admin' ? `<form id="hf" class="card row"><input type="date" name="date" required> to <input type="date" name="to"><input name="name" placeholder="Holiday name" required><button class="btn primary">Add</button></form>` : ''}
    <div class="table-wrap"><table><tbody>${rows.map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${esc(h.name)}</td><td>${ME.role === 'admin' ? `<a href="#" data-dh="${h.date}">remove</a>` : ''}</td></tr>`).join('') || '<tr><td class="muted">No holidays set. Sundays are skipped automatically.</td></tr>'}</tbody></table></div>`;
  }
  if (tab === 'devices') {
    const rows = await api('/api/devices');
    body = `<p class="muted small">Everyone currently signed in. Sign out a lost phone here.</p><div class="table-wrap"><table><thead><tr><th>Person</th><th>Type</th><th>Device</th><th>Signed in</th><th>Last seen</th><th></th></tr></thead><tbody>
    ${rows.map((d) => `<tr><td>${esc(d.label)}</td><td>${esc(d.kind === 'guardian' ? 'parent' : 'staff')}</td><td class="small">${esc(d.device)}</td><td>${fmtTime(d.created_at)}</td><td>${fmtTime(d.last_seen)}</td><td><button class="btn small danger" data-so="${d.id}">Sign out</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  if (tab === 'promotion') {
    const [classes, sessions] = await Promise.all([S('/classes'), S('/sessions')]);
    const cur = sessions.find((s) => s.current);
    const next = cur ? cur.name.replace(/(\d{4})-(\d{4})/, (_, a, b) => `${+a + 1}-${+b + 1}`) : '';
    const sorted = [...classes].sort((a, b) => a.grade - b.grade);
    body = `<div class="card stack"><p>Current session: <b>${esc(cur?.name)}</b>. Everyone is set to <b>Promote</b> into the class you choose below; change only the exceptions on the next step.</p>
    <form id="pf" class="stack"><div><label>New session name</label><input name="new_session" value="${esc(next)}" required></div>
    <div class="table-wrap"><table><thead><tr><th>From class</th><th>Students</th><th>Move to</th></tr></thead><tbody>
    ${sorted.map((c, i) => `<tr><td>${esc(c.name)}</td><td>${c.students}</td><td><select name="next_${c.id}">${sorted.map((x) => `<option value="${x.id}" ${sorted.find((y) => y.grade === c.grade + 1)?.id === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="passout" ${!sorted.some((y) => y.grade === c.grade + 1) ? 'selected' : ''}>Passed out (final class)</option></select></td></tr>`).join('')}
    </tbody></table></div><button type="button" class="btn" id="exc">Next: review exceptions</button></form><div id="exlist"></div></div>`;
  }
  if (tab === 'storage') {
    const st = await S('/storage');
    const pct = st.limit ? Math.round((100 * st.used) / st.limit) : 0;
    const mb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';
    body = `<div class="card"><p><b>${mb(st.used)}</b> of ${mb(st.limit)} used (${pct}%)</p><div style="background:var(--line);border-radius:6px;height:12px"><div style="width:${Math.min(100, pct)}%;background:${pct > 90 ? 'var(--bad)' : 'var(--brand)'};height:12px;border-radius:6px"></div></div>
    <h3>By type</h3>${st.byKind.map((k) => `<div>${esc(k.kind)}: ${mb(k.bytes)} (${k.n} files)</div>`).join('') || '<span class="muted">No files yet</span>'}
    <p class="small muted">Attendance and fee records do not count. When storage is full only new uploads stop. Buy more under <a href="#/billing">Billing</a>.</p></div>`;
  }
  if (tab === 'data') body = `<div class="card stack"><p>Download every record of your school as one file at any time. Your data is never deleted for non-payment.</p><a class="btn primary" href="/api/export">Download full backup (JSON)</a>
    <p class="small muted">To close your account permanently, download the backup first, then write to the platform owner from Billing.</p></div>`;
  if (tab === 'payments') {
    const list = await loadAccounts(true);
    const row = (a = {}) => `<div class="card form acct" style="margin-bottom:10px">
      <div><label>Company / service</label><input name="company" list="companies" placeholder="Easypaisa, JazzCash, Meezan Bank…" value="${esc(a.company)}"></div>
      <div><label>Account holder name</label><input name="title" value="${esc(a.title)}"></div>
      <div><label>Account / mobile number / IBAN</label><input name="number" value="${esc(a.number)}"></div>
      <div><label>Branch or note (optional)</label><input name="branch" value="${esc(a.branch)}"></div>
      <div class="full"><button type="button" class="btn small danger rm">Remove</button></div></div>`;
    body = `<p class="muted">Add every account parents can pay into. Parents see these when paying and on every printed voucher. You can change them any time.</p>
    <datalist id="companies"><option>Easypaisa</option><option>JazzCash</option><option>SadaPay</option><option>NayaPay</option><option>HBL</option><option>Meezan Bank</option><option>UBL</option><option>MCB</option><option>Allied Bank</option><option>Bank Alfalah</option><option>Bank Islami</option></datalist>
    <div id="accts">${(list.length ? list : [{}]).map(row).join('')}</div>
    <div class="row"><button class="btn" id="addacct">Add another account</button>${ME.role === 'admin' ? '<button class="btn primary" id="saveacct">Save accounts</button>' : ''}</div>`;
    setTimeout(() => {
      const bindRm = () => $$('.acct .rm').forEach((b) => b.onclick = () => b.closest('.acct').remove());
      bindRm();
      $('#addacct').onclick = () => { $('#accts').insertAdjacentHTML('beforeend', row()); bindRm(); };
      $('#saveacct').onclick = async () => {
        const accounts = $$('.acct').map((el) => Object.fromEntries($$('input', el).map((i) => [i.name, i.value.trim()]))).filter((a) => a.company && a.number);
        await act(() => S('/payment-accounts', { body: { accounts } }), 'Payment accounts saved'); await loadAccounts(true); render();
      };
    });
  }
  if (tab === 'audit') {
    const rows = await S('/audit').catch(() => []);
    body = `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>${rows.map((h) => `<tr><td>${fmtTime(h.created_at)}</td><td>${esc(h.user_name)}</td><td>${esc(h.action)}</td><td class="small" style="max-width:420px;overflow-wrap:anywhere">${esc(h.detail || '')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  view(`<h1>Settings</h1><div class="tabs">${tabs.map(([k, l]) => `<a href="#/settings?tab=${k}" class="${k === tab ? 'active' : ''}">${l}</a>`).join('')}</div>${body}`);
  const sf = $('#sf'); if (sf) sf.onsubmit = async (e) => {
    e.preventDefault(); const b = formData(e.target);
    const settings = {}; for (const k of Object.keys(ME.settings)) if (k !== 'payment_accounts') settings[k] = b[k] ?? '0';
    await act(() => S('/settings', { body: { settings, schoolName: b.schoolName } }), 'Saved'); await refreshMe(); render();
  };
  const hf = $('#hf'); if (hf) hf.onsubmit = async (e) => { e.preventDefault(); await act(() => S('/holidays', { body: formData(e.target) }), 'Added'); render(); };
  $$('[data-dh]').forEach((a) => a.onclick = async (e) => { e.preventDefault(); await act(() => S('/holidays/' + a.dataset.dh, { method: 'DELETE' }), 'Removed'); render(); });
  $$('[data-so]').forEach((b) => b.onclick = async () => { await act(() => api(`/api/devices/${b.dataset.so}/signout`, { body: {} }), 'Signed out'); render(); });
  const exc = $('#exc'); if (exc) exc.onclick = async () => {
    const b = formData($('#pf'));
    const nextClass = {}; for (const [k, v] of Object.entries(b)) if (k.startsWith('next_')) nextClass[k.slice(5)] = v;
    const students = await S('/students?status=active');
    const decisions = {};
    $('#exlist').innerHTML = `<h3>Exceptions</h3><p class="small muted">Change only students who are not promoted, leaving, or moving to a different section.</p>
    <div class="table-wrap"><table><tbody>${students.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.class_name)}</td><td><select data-st="${s.id}"><option value="promoted">Promote</option><option value="not promoted">Not promoted (repeat)</option><option value="left">Left school</option><option value="passed out">Passed out</option></select></td></tr>`).join('')}</tbody></table></div>
    <button class="btn primary" id="run" style="margin-top:12px">Promote everyone and start ${esc(b.new_session)}</button>`;
    $('#run').onclick = async () => {
      $$('[data-st]').forEach((sel) => { if (sel.value !== 'promoted') decisions[sel.dataset.st] = { outcome: sel.value }; });
      if (!confirm('Start the new session? The old session becomes read-only.')) return;
      const r = await act(() => S('/promotion', { body: { new_session: b.new_session, next_class: nextClass, decisions } }));
      toast('Done: ' + Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')); render();
    };
  };
});

// ---------- billing (main admin) ----------
route('/billing', async () => {
  const b = await api('/api/billing'); BILL = b;
  const open = (b.invoices || []).find((i) => i.status === 'open');
  const mb = (x) => (x / 1024 ** 3).toFixed(2) + ' GB';
  view(`<h1>Billing</h1>
  <div class="grid">
    <div class="stat"><div class="l">Status</div><div class="n" style="font-size:1.2rem">${badge(b.status, b.status === 'active' ? 'ok' : b.status === 'trial' ? 'info' : 'bad')}</div></div>
    <div class="stat"><div class="l">Plan</div><div class="n" style="font-size:1.2rem">${esc(b.tier)} · ${esc(b.cycle)}</div></div>
    <div class="stat"><div class="l">${b.status === 'trial' ? 'Trial ends' : 'Renews'}</div><div class="n" style="font-size:1.2rem">${fmtDate(b.renews_at)}</div></div>
    <div class="stat"><div class="l">Active students</div><div class="n" style="font-size:1.2rem">${b.students}</div></div>
    <div class="stat"><div class="l">Storage</div><div class="n" style="font-size:1.2rem">${mb(b.storage_bytes)} / ${mb(b.storage_limit_bytes)}</div></div>
  </div>
  ${(b.announcements || []).map((a) => `<div class="banner info" style="margin-top:12px"><b>${esc(a.title)}</b> ${esc(a.body)}</div>`).join('')}
  <h2>${open ? 'Invoice to pay' : 'Pay for your plan'}</h2>
  <div class="card stack">
    ${open ? `<p><b>${money(open.amount)}</b> for ${fmtDate(open.period_start)} – ${fmtDate(open.period_end)} (${esc(open.tier)}, ${esc(open.cycle)}). <span class="muted small">${esc(open.note || '')}</span></p>
      <p>Pay from any Easypaisa or JazzCash account to: <b>${esc(b.accounts)}</b>, then upload the transaction ID and slip below. Your plan is renewed as soon as it is confirmed.</p>
      <form id="bf" class="form"><input type="hidden" name="invoice_id" value="${open.id}"><div><label>Transaction ID</label><input name="txn_id" required></div><div><label>Amount paid</label><input name="amount" type="number" value="${open.amount}"></div>
      <div class="full"><label>Slip (image or PDF)</label><input type="file" name="file" accept="image/*,application/pdf"></div><div class="full"><button class="btn primary">Upload slip</button></div></form>`
    : '<p>No invoice is open. Create one to pay now:</p>'}
    <div class="row"><select id="cy"><option value="monthly" ${b.cycle === 'monthly' ? 'selected' : ''}>Monthly</option><option value="yearly" ${b.cycle === 'yearly' ? 'selected' : ''}>Yearly (10 months' price)</option></select><button class="btn" id="inv">${open ? 'Recreate invoice' : 'Create invoice'}</button></div>
  </div>
  <h2>Plans</h2><div class="table-wrap"><table><thead><tr><th>Tier</th><th>Active students</th><th class="num">Monthly</th><th class="num">Yearly</th><th class="num">Storage</th><th class="num">Sub-admins</th></tr></thead><tbody>
  ${(b.plans || []).filter((p) => p.tier !== 'custom').map((p) => `<tr ${p.tier === b.tier ? 'style="font-weight:700"' : ''}><td>${esc(p.tier)}</td><td>${p.min_students}–${p.max_students}</td><td class="num">${p.monthly ? money(p.monthly) : 'Free 14 days'}</td><td class="num">${p.yearly ? money(p.yearly) : ''}</td><td class="num">${p.storage_gb} GB</td><td class="num">${p.sub_admins}</td></tr>`).join('')}
  <tr><td>custom</td><td>2,000+</td><td colspan="4">Agreed with us</td></tr></tbody></table></div>
  <p class="small muted">Every paid plan includes every feature; tiers differ only by size. Teachers and parents are unlimited. Your tier is set by active students 7 days before renewal — students marked as left don't count.</p>
  <h2>Payment history</h2><div class="table-wrap"><table><tbody>${(b.slips || []).map((s) => `<tr><td>${fmtTime(s.created_at)}</td><td>${esc(s.txn_id)}</td><td class="num">${money(s.amount)}</td><td>${badge(s.status, s.status === 'verified' ? 'ok' : s.status === 'rejected' ? 'bad' : 'warn')} ${esc(s.reason || '')}</td></tr>`).join('') || '<tr><td class="muted">None yet</td></tr>'}</tbody></table></div>
  <h2>Support access</h2><div class="card"><p class="small">The platform owner cannot see your school's records. To let them help with a problem, grant temporary access; everything they do is logged.</p>
  <div class="row">${b.support ? `<span>Access granted until ${fmtTime(b.support.granted_until)}</span><button class="btn" id="rev">Revoke</button>` : `<select id="hrs"><option value="2">2 hours</option><option value="8">8 hours</option><option value="24">24 hours</option></select><button class="btn" id="grant">Grant access</button>`}</div></div>`);
  const bf = $('#bf'); if (bf) bf.onsubmit = async (e) => { e.preventDefault(); await act(() => api('/api/billing/slip', { form: new FormData(e.target) }), 'Slip uploaded — you will be told when it is confirmed'); render(); };
  $('#inv').onclick = async () => { await act(() => api('/api/billing/invoice', { body: { cycle: $('#cy').value } }), 'Invoice created'); render(); };
  const g = $('#grant'); if (g) g.onclick = async () => { await act(() => api('/api/billing/support-access', { body: { hours: Number($('#hrs').value) } }), 'Access granted'); render(); };
  const rv = $('#rev'); if (rv) rv.onclick = async () => { await act(() => api('/api/billing/support-access', { body: { hours: 0 } }), 'Access revoked'); render(); };
});

// ---------- owner panel ----------
route('/owner', async () => {
  if (ME.kind !== 'owner') return go('/');
  const d = await api('/api/owner/overview');
  view(`<h1>Owner panel</h1>
  <div class="grid">
    <div class="stat"><div class="n">${d.slips.length}</div><div class="l">Slips to confirm</div></div>
    <div class="stat"><div class="n">${money(d.income.collected)}</div><div class="l">Collected this month</div></div>
    <div class="stat"><div class="n">${money(d.income.expected)}</div><div class="l">Expected (open invoices)</div></div>
    <div class="stat"><div class="l">Schools by status</div>${Object.entries(d.byStatus).map(([k, v]) => `${esc(k)}: <b>${v}</b>`).join(' · ') || '–'}</div>
  </div>
  <h2>Today's to-do: slips to confirm</h2>
  <div class="table-wrap"><table><thead><tr><th>School</th><th>Invoice</th><th>Txn ID</th><th class="num">Paid</th><th>Slip</th><th></th></tr></thead><tbody>
  ${d.slips.map((s) => `<tr><td>${esc(s.school_name)}</td><td>${money(s.invoice_amount)} · ${esc(s.tier)} · ${fmtDate(s.period_start)}–${fmtDate(s.period_end)}</td><td>${esc(s.txn_id)}</td><td class="num">${money(s.amount)}</td>
  <td>${s.file_key ? `<a target="_blank" href="/api/owner/slips/${s.id}/file">View</a>` : '–'}</td><td class="row"><button class="btn small primary" data-ok="${s.id}">Confirm</button><button class="btn small danger" data-no="${s.id}">Reject</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">Nothing waiting</td></tr>'}
  </tbody></table></div>
  <h2>Renewals this week</h2><div class="card small">${d.renewalsThisWeek.map((s) => `${esc(s.name)} — ${fmtDate(s.renews_at)}${s.slips_waiting ? ' (slip uploaded)' : ''}`).join('<br>') || '–'}</div>
  <h2>Trials ending in 7 days</h2><div class="card small">${d.trialsEnding.map((s) => `${esc(s.name)} — ${fmtDate(s.renews_at)} · ${s.students} students`).join('<br>') || '–'}</div>
  <div class="row between"><h2>All schools</h2><div class="row"><button class="btn" id="ann">Announce</button><button class="btn" id="bill">Run billing now</button><button class="btn primary" id="new">Add school</button></div></div>
  <div class="table-wrap"><table><thead><tr><th>School</th><th>Status</th><th>Plan</th><th>Renews</th><th class="num">Students</th><th class="num">Storage</th><th>Support access</th><th></th></tr></thead><tbody>
  ${d.schools.map((s) => `<tr><td>${esc(s.name)}<div class="muted small">${esc(s.id)}</div></td><td>${badge(s.status, s.status === 'active' ? 'ok' : s.status === 'trial' ? 'info' : 'bad')}</td><td>${esc(s.tier)} · ${esc(s.cycle)}${s.price_override != null ? ` · ${money(s.price_override)} fixed` : ''}</td>
  <td>${fmtDate(s.renews_at)}</td><td class="num">${s.students}</td><td class="num">${(s.storage_bytes / 1024 ** 2).toFixed(1)} MB</td><td class="small">${s.support_until && s.support_until > new Date().toISOString() ? 'until ' + fmtTime(s.support_until) : '–'}</td>
  <td><button class="btn small" data-ed="${s.id}">Change</button></td></tr>`).join('')}
  </tbody></table></div><p class="small muted">You see billing and usage only — never a school's records.</p>`);
  $$('[data-ok]').forEach((b) => b.onclick = async () => { await act(() => api(`/api/owner/slips/${b.dataset.ok}/confirm`, { body: {} }), 'Confirmed; school renewed'); render(); });
  $$('[data-no]').forEach((b) => b.onclick = async () => { const reason = prompt('Reason for rejecting?'); if (!reason) return; await act(() => api(`/api/owner/slips/${b.dataset.no}/reject`, { body: { reason } }), 'Rejected'); render(); });
  $('#bill').onclick = async () => { await act(() => api('/api/owner/run-billing', { body: {} }), 'Billing run complete'); render(); };
  $('#new').onclick = () => modal(`<h2>Add school</h2><form id="nf" class="form"><div class="full"><label>School name</label><input name="name" required></div>
    <div><label>Main admin name</label><input name="admin_name" required></div><div><label>Admin email</label><input name="admin_email" type="email" required></div><div><label>Admin phone</label><input name="admin_phone"></div>
    <div class="full row"><button class="btn primary">Create (starts on trial)</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#nf', m).onsubmit = async (e) => { e.preventDefault(); await act(() => api('/api/owner/schools', { body: formData(e.target) }), 'School created'); closeModal(); render(); };
  });
  $('#ann').onclick = () => modal(`<h2>Announcement to main admins</h2><form id="af" class="form"><div class="full"><label>School</label><select name="school_id"><option value="">All schools</option>${d.schools.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
    <div class="full"><label>Title</label><input name="title" required></div><div class="full"><label>Message</label><textarea name="body"></textarea></div>
    <div class="full row"><button class="btn primary">Send</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
    $('#af', m).onsubmit = async (e) => { e.preventDefault(); await act(() => api('/api/owner/announce', { body: formData(e.target) }), 'Sent'); closeModal(); };
  });
  $$('[data-ed]').forEach((b) => b.onclick = () => {
    const s = d.schools.find((x) => x.id === b.dataset.ed);
    modal(`<h2>${esc(s.name)}</h2><form id="ef" class="form">
      <div><label>Tier</label><select name="tier">${d.plans.map((p) => `<option ${p.tier === s.tier ? 'selected' : ''}>${p.tier}</option>`).join('')}</select></div>
      <div><label>Billing</label><select name="cycle"><option ${s.cycle === 'monthly' ? 'selected' : ''}>monthly</option><option ${s.cycle === 'yearly' ? 'selected' : ''}>yearly</option></select></div>
      <div><label>Fixed price (keeps launch price; empty = tier price)</label><input name="price_override" type="number" value="${s.price_override ?? ''}"></div>
      <div><label>Extra storage (GB, in 5 GB blocks)</label><input name="extra_storage_gb" type="number" step="5" value="${s.extra_storage_gb}"></div>
      <div><label>Grace period (days)</label><input name="grace_days" type="number" value="${s.grace_days}"></div>
      <div><label>Renews on</label><input name="renews_at" type="date" value="${s.renews_at}"></div>
      <div><label>Status</label><select name="status">${['trial', 'active', 'grace', 'paused'].map((x) => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="full row"><button class="btn primary">Save</button><button type="button" class="btn" data-close>Cancel</button></div></form>`, (m) => {
      $('#ef', m).onsubmit = async (e) => {
        e.preventDefault(); const f = formData(e.target);
        f.price_override = f.price_override === '' ? '' : Number(f.price_override); f.extra_storage_gb = Number(f.extra_storage_gb) || 0; f.grace_days = Number(f.grace_days) || 4;
        await act(() => api('/api/owner/schools/' + s.id, { body: f }), 'Saved'); closeModal(); render();
      };
    });
  });
});

// ---------- start ----------
(async () => {
  try { await refreshMe(); } catch {}
  render();
  flushOutbox();
})();
