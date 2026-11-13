const escXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function renderSeoPage(origin: string): string {
  const canonical = new URL('/about', origin).toString();
  const image = new URL('/icon.svg', origin).toString();
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Institution Manager',
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web browser; Android; iOS; Windows; macOS',
    description: 'School and education institution management software for student records, staff, classes, attendance, fees, parent communication, results and reports.',
    url: canonical,
    image,
    featureList: [
      'Student records and admissions',
      'Staff roles and class assignments',
      'Class and subject management',
      'Attendance registers and reports',
      'Fee plans, vouchers, payments and receipts',
      'Parent communication and notices',
      'Examination results and protected documents',
      'Institution dashboards, audit history and backups',
      'Installable web app for phones, tablets and computers'
    ]
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>School Management Software for Schools &amp; Academies | Institution Manager</title>
<meta name="description" content="Manage student records, classes, attendance, school fees, staff, parent communication and results in one secure school management workspace.">
<meta name="keywords" content="school management software, school management system, student management system, school attendance software, school fee management, parent portal, academy management">
<meta name="robots" content="index,follow,max-image-preview:large">
<meta name="theme-color" content="#0B1426">
<link rel="canonical" href="${canonical}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Institution Manager">
<meta property="og:title" content="School Management Software | Institution Manager">
<meta property="og:description" content="One organised workspace for student records, attendance, fees, staff, family communication and results.">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${image}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="School Management Software | Institution Manager">
<meta name="twitter:description" content="Manage everyday school operations in one organised institution workspace.">
<script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>
</head>
<body>
<div class="landing-shell">
<header class="landing-nav">
  <a class="landing-brand" href="/about"><img src="/icon.svg" alt=""><span>Institution Manager</span></a>
  <nav aria-label="Main navigation"><a href="#features">Features</a><a href="#roles">Who it serves</a><a href="#privacy">Privacy</a></nav>
  <div class="landing-nav-actions"><a class="btn" href="/login">Log in</a><a class="btn primary" href="/signup">Create institution</a></div>
</header>
<main>
<section class="landing-hero">
  <div class="landing-hero-copy">
    <div class="landing-eyebrow"><span></span> SCHOOL AND EDUCATION OPERATIONS</div>
    <h1>School management software for the work behind every school day.</h1>
    <p class="landing-lead">Bring student records, classes, staff, attendance, school fees, parent communication, examination results and reports into one organised workspace.</p>
    <div class="landing-actions"><a class="btn primary" href="/signup">Create an institution workspace</a><a class="btn" href="/login">Log in</a></div>
    <p class="landing-note">Designed for schools, colleges, academies and other education providers. Start with a 14-day trial for up to 50 learners.</p>
  </div>
  <div class="landing-preview" aria-label="Illustration of the institution management workspace">
    <div class="preview-top"><span class="preview-mark">IM</span><div><b>Institution overview</b><small>Daily operations at a glance</small></div><span class="preview-live">WORKSPACE</span></div>
    <div class="preview-stats"><div><small>Students</small><b>Records</b><span>Admissions and profiles</span></div><div><small>Attendance</small><b>Daily</b><span>Class registers</span></div><div><small>Finance</small><b>Fees</b><span>Vouchers and receipts</span></div></div>
    <div class="preview-panel"><div class="preview-panel-head"><b>Keep the day organised</b><span>OVERVIEW</span></div><div class="preview-row"><span><i class="preview-dot blue"></i>Classes and sections</span><b>Organised</b></div><div class="preview-row"><span><i class="preview-dot green"></i>Attendance records</span><b>Trackable</b></div><div class="preview-row"><span><i class="preview-dot violet"></i>Parent communication</span><b>Connected</b></div><div class="preview-progress"><span></span></div><small>One workspace for everyday institution operations</small></div>
    <div class="preview-footer"><span>Students</span><span>Attendance</span><span>Fees</span><span>Results</span></div>
  </div>
</section>
<section class="landing-ribbon" aria-label="Platform features"><span>Separate institution workspaces</span><span>Role-based access</span><span>Browser and installable app</span><span>Supported offline forms</span></section>
<section class="landing-section" id="roles">
  <div class="landing-section-heading"><div class="landing-eyebrow">WHO IT SERVES</div><h2>One workspace, with access for each role.</h2><p>Each institution manages its own records and gives people the permissions needed for their responsibilities.</p></div>
  <div class="landing-card-grid three">
    <article class="landing-card"><div class="landing-card-icon">01</div><h3>School administrators</h3><p>Manage admissions, staff, classes, fee structures, reports, notices and institution settings.</p></article>
    <article class="landing-card"><div class="landing-card-icon">02</div><h3>Teachers and office teams</h3><p>Work with assigned classes, student information, attendance and the administrative tasks permitted by their role.</p></article>
    <article class="landing-card"><div class="landing-card-icon">03</div><h3>Parents and guardians</h3><p>Access linked children, attendance, fee information, published results, notices and school messages.</p></article>
  </div>
</section>
<section class="landing-section landing-features" id="features">
  <div class="landing-section-heading"><div class="landing-eyebrow">SCHOOL MANAGEMENT FEATURES</div><h2>The essential operations, connected.</h2><p>Reduce repeated manual work and keep everyday school information in one organised system.</p></div>
  <div class="landing-card-grid">
    <article class="landing-card"><div class="landing-card-icon">A</div><h3>Student admission and records</h3><p>Create profiles, generate registration numbers, import spreadsheets, link guardians and retain a history of changes.</p></article>
    <article class="landing-card"><div class="landing-card-icon">B</div><h3>Staff and permissions</h3><p>Manage teachers, administrators and office teams with role-based permissions and controlled account access.</p></article>
    <article class="landing-card"><div class="landing-card-icon">C</div><h3>Classes and subjects</h3><p>Create flexible class groups and connect class teachers and subject responsibilities.</p></article>
    <article class="landing-card"><div class="landing-card-icon">D</div><h3>Attendance management</h3><p>Record, review and submit daily attendance, manage corrections and view monthly registers and summaries.</p></article>
    <article class="landing-card"><div class="landing-card-icon">E</div><h3>School fee management</h3><p>Configure fee heads and class plans, generate monthly vouchers, manage discounts and track arrears.</p></article>
    <article class="landing-card"><div class="landing-card-icon">F</div><h3>Payments and receipts</h3><p>Review payment submissions, issue numbered receipts, track cash handovers and report outstanding balances.</p></article>
    <article class="landing-card"><div class="landing-card-icon">G</div><h3>Parent communication</h3><p>Share targeted notices, manage student-related message threads and track notification reads.</p></article>
    <article class="landing-card"><div class="landing-card-icon">H</div><h3>Examination results</h3><p>Upload result documents, control publication and keep student files permission-protected.</p></article>
    <article class="landing-card"><div class="landing-card-icon">I</div><h3>Reports and audit history</h3><p>Review dashboards, trace important changes, monitor file storage and export school records for backup.</p></article>
    <article class="landing-card"><div class="landing-card-icon">J</div><h3>Offline-ready forms</h3><p>Save supported forms on the device while offline and sync them when a connection returns. The app distinguishes local pending work from server-confirmed submissions.</p></article>
  </div>
</section>
<section class="landing-section landing-security" id="privacy">
  <div><div class="landing-eyebrow">DATA SEPARATION AND ACCESS</div><h2>Institution records stay within their own workspace.</h2><p>Each institution has a separate database. Backend permissions determine which records teachers, guardians and administrators can access. Private file downloads are checked against the user's permissions.</p><p class="small muted">Sign-in uses verified Google accounts. Password, email-code and phone-based login are not enabled.</p></div>
  <div class="security-points"><div><b>Google account sign-in</b><span>Verified account identity</span></div><div><b>Separate institution data</b><span>Independent school workspaces</span></div><div><b>Role-based permissions</b><span>Backend access checks</span></div><div><b>Protected files</b><span>Permission-checked downloads</span></div></div>
</section>
<section class="landing-cta">
  <div><div class="landing-eyebrow">GET STARTED</div><h2>Bring your institution's daily work together.</h2><p>Create a private workspace and follow the guided setup for staff, classes, learners and fees.</p></div>
  <div class="landing-actions"><a class="btn primary" href="/signup">Create institution</a><a class="btn" href="/login">Log in</a></div>
</section>
</main>
<footer class="landing-footer"><div><a class="landing-brand" href="/about"><img src="/icon.svg" alt=""><span>Institution Manager</span></a><p class="small muted">A workspace for student records, staff, attendance, fees, communication and results.</p></div><div><b>Explore</b><a href="#features">Features</a><a href="#roles">Who it serves</a><a href="#privacy">Privacy</a></div><div><b>Account</b><a href="/signup">Create institution</a><a href="/login">Log in</a></div><div class="landing-copyright">© Institution Manager. All rights reserved.</div></footer>
</div>
</body>
</html>`;
}

export function renderRobots(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /about',
    'Disallow: /api/',
    'Disallow: /files/',
    'Disallow: /login',
    'Disallow: /signup',
    'Disallow: /admin',
    `Sitemap: ${new URL('/sitemap.xml', origin).toString()}`,
    ''
  ].join('\n');
}

export function renderSitemap(origin: string): string {
  const location = escXml(new URL('/about', origin).toString());
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${location}</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>
</urlset>`;
}
