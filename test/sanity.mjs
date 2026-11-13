import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [wrangler, util, worker, platform, app, sw, school, schema, css, html, seo] = await Promise.all([
  read('wrangler.toml'),
  read('src/util.ts'),
  read('src/index.ts'),
  read('src/platform.ts'),
  read('public/app.js'),
  read('public/sw.js'),
  read('src/school.ts'),
  read('src/schema.ts'),
  read('public/app.css'),
  read('public/index.html'),
  read('src/seo.ts'),
]);

assert.match(wrangler, /^name = "school"$/m, 'Wrangler deploy target must match the Cloudflare Worker named school');
assert.match(wrangler, /^GOOGLE_CLIENT_ID = ".+apps\.googleusercontent\.com"$/m, 'Google Web Client ID must be configured');
assert.match(wrangler, /^name = "PLATFORM"$/m, 'Platform SQLite Durable Object binding must exist');
assert.doesNotMatch(wrangler, /d1_databases|binding = "DB"/, 'D1 must be removed');
assert.match(wrangler, /new_sqlite_classes = \["PlatformDO"\]/, 'Platform SQLite migration must exist');
assert.match(util, /PLATFORM: DurableObjectNamespace/, 'Platform registry must use a Durable Object namespace');
assert.match(platform, /export class PlatformDO extends DurableObject/, 'Platform registry must be a Durable Object');
assert.match(platform, /state\.storage\.sql/, 'Platform registry must use its own SQLite storage');
assert.match(platform, /idFromName\('platform-registry'\)/, 'Platform registry must use a stable singleton identity');
assert.match(worker, /idFromName\(id\)/, 'Each school must resolve to its own stable Durable Object identity');
assert.match(wrangler, /^binding = "FILES"$/m, 'R2 binding must exist');
assert.match(wrangler, /^invocation_logs = true$/m, 'Wrangler observability config must be present');

assert.match(util, /GOOGLE_CLIENT_ID\?: string/, 'Worker Env must define the Google client ID');
assert.match(util, /PUBLIC_CONTACT_EMAIL\?: string/, 'Worker Env must define optional public contact email');
assert.match(worker, /app\.post\('\/api\/auth\/google'/, 'Google sign-in endpoint must exist');
assert.match(worker, /app\.post\('\/api\/signup\/google'/, 'Google-based institution signup endpoint must exist');
assert.match(worker, /app\.post\('\/api\/auth\/logout'/, 'Server-side session revocation endpoint must exist');
assert.match(worker, /Billing cycle must be monthly or yearly/, 'Platform owner cannot set one-time or unsupported subscription cycles');
assert.match(worker, /The invoice amount is authoritative; never accept a client-supplied amount/, 'Subscription slips must not trust client-supplied payment amounts');
assert.match(worker, /status='submitted'.*status='open'/s, 'Subscription payment confirmation must use conditional state transitions');
assert.match(worker, /submitted amount does not match the invoice/, 'Subscription payment confirmation must reject amount mismatches');
assert.match(worker, /WHERE NOT EXISTS \(SELECT 1 FROM invoices WHERE school_id=\? AND status='open'\)/, 'Invoice generation must avoid duplicate open invoices');
assert.ok(worker.includes("safeType = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']"), 'Owner billing uploads must use a safe inline content-type allowlist');
assert.ok(school.includes("safeType = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']"), 'School file downloads must use a safe inline content-type allowlist');
assert.match(school, /Payment exceeds the remaining voucher balance/, 'Fee verification must prevent overpayment');
assert.ok(school.includes("UPDATE payments SET verified_by=? WHERE id=? AND status='submitted'"), 'Payment verification must atomically claim a submitted slip');
assert.ok(school.includes("UPDATE payments SET status='rejected', reason=?, verified_by=?, verified_at=? WHERE id=? AND status='submitted'"), 'Payment rejection must be a conditional one-time transition');
assert.ok(school.includes("UPDATE payments SET status='cancelled', reason=? WHERE id=? AND status='verified'"), 'Receipt cancellation must be a conditional one-time transition');
assert.ok(school.includes("SELECT changes() AS n"), 'Financial transitions must check whether their conditional update won the race');
assert.ok(school.includes('Only a former student can be restored'), 'Student restoration must reject already active students');
assert.ok(school.includes('activeCount >= ctx.studentCap'), 'Student restoration must enforce the institution student limit');
assert.ok(school.includes('SELECT id, name FROM classes WHERE id=? AND active=1'), 'Student restoration must target an active class');
assert.ok(school.includes("outcome='left'") && school.includes('Leaving date cannot be before the current class enrollment'), 'Leaving a student must close their enrollment history with a valid date');
assert.ok(app.includes('restoreStudentForm') && app.includes('Choose the active class for this student'), 'The restore workflow must let the admin select an active destination class');
assert.ok(school.includes("const voucherKey = 'vouchers:' + t.month") && school.includes('markRun(voucherKey)'), 'Monthly voucher automation must record completion after successful generation');
assert.ok(school.includes('markRun(feesKey)'), 'Daily fee automation must record completion after its work succeeds');
assert.ok(!worker.includes("app.post('/api/billing/support-access'"), 'Do not advertise a support-access grant without a real audited support session');
assert.ok(app.includes('there is currently no remote support-access feature'), 'The UI must clearly disclose that remote support access is not available');
assert.match(wrangler, /^PAYMENT_ACCOUNTS = ""$/m, 'Deployment defaults must not publish placeholder payment numbers');
assert.match(school, /This voucher has been carried into a newer one/, 'Stale carried vouchers must not accept verified payments');
assert.match(school, /'x-content-type-options': 'nosniff'/, 'Private school file responses must prevent MIME sniffing');

assert.doesNotMatch(worker, /app\.post\('\/api\/(?:auth|signup)\/(?:start|verify)'/, 'Legacy email/phone OTP auth routes must not exist');
assert.match(worker, /RSASSA-PKCS1-v1_5/, "Google ID token signature must be verified using Google's RSA signing key");
assert.match(worker, /oauth2\/v3\/certs/, 'Google signing keys must come from the official JWKS endpoint');
assert.match(worker, /claims\.aud !== env\.GOOGLE_CLIENT_ID/, 'Google ID token audience must be checked');
assert.match(worker, /String\(claims\.email_verified\) !== 'true'/, 'Google verified-email claim must be checked');
assert.doesNotMatch(worker, /oauth2\.googleapis\.com\/tokeninfo/, 'Production Google sign-in must not call the tokeninfo debugging endpoint');
assert.match(worker, /resolved_role/, 'Normal account roles must be resolved from trusted school profiles');
assert.match(worker, /'platform_owner'/, 'Dedicated platform owner sign-in role must be supported');
assert.match(worker, /requestedRole === 'platform_owner'.*not authorized for platform administration/s, 'Non-owner Google accounts must be rejected from platform administration');
assert.match(worker, /identity\.email === normId\(c\.env\.OWNER_EMAIL\)/, 'Platform owner identity must match the configured owner email');
assert.match(worker, /if \(identity\.email === normId\(c\.env\.OWNER_EMAIL\)\) fail\(403, 'The platform owner account cannot register an institution\.'\)/, 'Platform owner must not register an institution');

assert.match(app, /function landingPage\(\)/, 'Public landing page must exist');
assert.match(app, /Use in browser/, 'Landing page must provide browser access');
assert.match(app, /Install app/, 'Landing page must provide install action');
assert.match(app, /route\('\/login'/, 'Google login page must exist');
assert.match(app, /route\('\/signup'/, 'Google signup page must exist');
assert.match(app, /route\('\/admin'/, 'Dedicated platform owner sign-in page must exist');
assert.match(app, /role: 'platform_owner'/, 'Platform admin page must request the restricted owner role');
assert.match(app, /href="\/admin"/, 'Platform admin sign-in must be discoverable from the public footer');
assert.doesNotMatch(app, /data-login-role=|selectedRole/, 'Google login must not require a manual role picker');
assert.match(app, /Choose the institution account you want to open/, 'Users with multiple accounts must choose their institution after identity verification');
assert.match(app, /isInstalledApp\(\)/, 'Installed-app entry routing must be device aware');
assert.match(app, /No internet connection\. Connect to the internet to verify your Google account/, 'Google sign-in must require an internet connection');
assert.match(app, /function connectionBannerHtml\(\)/, 'Global offline and restored connection banner must exist');
assert.match(app, /Connection restored/, 'The app must show a connection-restored banner');
assert.match(app, /Your unsent work stays on this device/, 'Offline banner must explain that unsent work remains local');
assert.ok(app.includes('submission(s) are waiting to reach the school server'), 'Offline banner must show pending submission count');
assert.match(app, /window\.addEventListener\('online', async/, 'Reconnect must revalidate the server session and sync queued attendance');
assert.match(app, /window\.addEventListener\('offline'/, 'The app must show offline state when connectivity is lost');
assert.match(worker, /requestedRole === 'platform_owner'/, 'Server must keep platform-owner access explicitly protected');
assert.ok(worker.includes("!/^[a-f0-9]{32}$/.test(me.userId)"), 'Server must validate the permanent hexadecimal profile ID before issuing a session');
assert.match(worker, /new main administrator profile was created without its secure account ID/, 'Institution signup must validate the new main administrator ID');
assert.match(school, /publicId: s!\.public_id/, 'Staff accounts must expose their assigned account ID');
assert.match(school, /That Google sign-in email is already assigned to another active staff account/, 'Staff email changes must prevent duplicate active sign-in identities');
assert.match(school, /UPDATE sessions SET revoked=1 WHERE school_id=\? AND kind=\? AND ref_id=\?/, 'Sign-in identity changes must revoke existing sessions');
assert.match(school, /publicId: g!\.public_id/, 'Parent accounts must expose their assigned account ID');
assert.match(school, /lower\(hex\(randomblob\(16\)\)\)/, 'Account IDs must be generated as opaque hexadecimal values');
assert.match(school, /userId: u\.public_id/, 'Administrator search must return account IDs for lookup');
assert.match(worker, /No main administrator profile is registered/, 'Unregistered main-admin accounts must be directed to institution registration');
assert.match(app, /Teachers and parents do not create their own accounts/, 'Teacher and parent profiles must be provisioned by the institution');
assert.match(app, /att-outbox-v2:/, 'Offline attendance queue must be identity-scoped');
assert.match(app, /credentials: 'same-origin'/, 'API requests must use same-origin session cookies');
assert.match(app, /cache: 'no-store'/, 'API requests must not be served from a browser cache');
assert.match(app, /school-offline-submissions/, 'All school forms must share a durable IndexedDB queue');
assert.ok(app.includes('flushOfflineSubmissions()'), 'Queued forms must retry after connectivity returns');
assert.ok(app.includes('Saved on this device. Not yet received by the school server'), 'Local queue state must not be confused with server receipt');
assert.ok(app.includes("route('/submissions'"), 'Users must have a submission history screen');
assert.match(school, /x-submission-id/, 'School API must use stable submission IDs for retry safety');
assert.ok(school.includes("app.get('/submissions'"), 'Server-confirmed submission history must be role-scoped');
assert.match(schema, /CREATE TABLE IF NOT EXISTS api_submissions/, 'School database must retain server submission receipts');

assert.match(sw, /const VERSION = 'v15'/, 'PWA shell/cache version must be updated');
assert.match(sw, /self\.skipWaiting\(\)/, 'Updated service worker must activate promptly');
assert.ok(sw.includes("if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return;"), 'Service worker must never cache private API responses or private files');

assert.match(school, /day\.submitted_by === a\.key/, 'Attendance submit retry must be idempotent for the same submitter');
assert.doesNotMatch(school, /this\.classOf\(a,\s*classId,\s*'(?:view|teacher)',\s*date\)/, 'Attendance access must not retain the removed dated-substitution argument');
assert.match(school, /async runCron\(ctx: Ctx\)/, 'Cron cleanup that awaits R2 deletions must be asynchronous');
assert.match(school, /app\.delete\('\/notices\/:id', async \(c\) => \{/, 'Notice deletion handler must be async before awaiting its confirmation body');
assert.match(school, /app\.post\('\/internal\/cron', async \(c\) => c\.json\(await this\.runCron/, 'The internal cron route must await asynchronous cleanup');

assert.ok(!app.includes("route('/timetable'") && !app.includes("route('/syllabus'") && !app.includes('substitution-bonuses'), 'Focused school UI must not expose removed teaching modules');
assert.ok(!school.includes("app.get('/timetable'") && !school.includes("app.post('/timetable'") && !school.includes("app.get('/syllabus'") && !school.includes("app.get('/substitutions'"), 'Focused school API must not expose removed teaching workflows');
assert.ok(!schema.includes('CREATE TABLE IF NOT EXISTS timetable_slots') && !schema.includes('CREATE TABLE IF NOT EXISTS class_substitutions') && !schema.includes('CREATE TABLE IF NOT EXISTS syllabus_documents'), 'New school databases must not create removed feature tables');
assert.ok(css.includes('@media (max-width: 860px)'), 'Workspace must adapt navigation for phone and tablet widths');
assert.ok(css.includes('@media (min-width: 601px) and (max-width: 860px)'), 'Tablet layout must use tablet-appropriate forms and cards');
assert.ok(css.includes('@media (max-width: 600px)'), 'Phone layout must use phone-appropriate spacing and form columns');
assert.ok(css.includes('minmax(0, 1fr)'), 'Workspace columns must shrink without forcing viewport overflow');
assert.match(html, /viewport-fit=cover/, 'Installed app must account for device safe areas');
const dollar = String.fromCharCode(36);
const collectionSelectors = [
  dollar + "('[data-deldisc]')", dollar + "('[data-cancel]')", dollar + "('#side nav a')", dollar + "('[data-rm]', m)",
  dollar + "('[data-v]')", dollar + "('[data-r]')", dollar + "('[data-deln]')", dollar + "('[data-pub]')", dollar + "('[data-del]')",
  dollar + "('[data-a]')", dollar + "('[data-d]')", dollar + "('[data-st]')", dollar + "('[data-storage-approve]', storageQueue)",
  dollar + "('[data-storage-reject]', storageQueue)", dollar + "('[data-ok]')",
];
for (const selector of collectionSelectors) {
  const needle = selector + '.forEach';
  let position = app.indexOf(needle);
  while (position !== -1) {
    assert.notEqual(app[position - 2], dollar,
      `Collection event binding must use $$(), not $(): ${selector}`);
    position = app.indexOf(needle, position + needle.length);
  }
}
assert.match(app, /layout\.classList\.toggle\('nav-collapsed'/, 'Desktop navigation must be collapsible like a ChatGPT-style sidebar');
assert.match(app, /function workspaceToolsHtml\(\)/, 'A role-aware right-side workspace tools panel must exist');
assert.match(app, /id="tools-panel"/, 'The workspace tools panel must be present in the authenticated layout');
assert.match(app, /id="tools-toggle"/, 'The right-side panel must have a visible accessible toggle');
assert.match(app, /institution\.workspace-tools-open/, 'The right-side panel preference must persist on the current device');
assert.ok(app.includes("$('#side nav a').forEach") && app.includes("$('#tools-panel nav a').forEach"), 'Navigation link handlers must iterate collections, not single-element querySelector results');
assert.match(app, /if \(mobileNav\(\)\) setNavOpen\(false\)/, 'Desktop navigation must stay open when a page link is selected');
assert.match(css, /\.tools-panel\.open\s*\{\s*transform: translateX\(0\)/, 'The right tools panel must slide into view on compact screens');
assert.match(css, /@media \(min-width: 1351px\)/, 'The full three-column workspace must be reserved for wide screens');
assert.match(css, /@media \(max-width: 860px\)/, 'The workspace must have a mobile drawer layout');
assert.match(sw, /const VERSION = 'v15'/, 'The service worker shell cache must be refreshed for this UI release');
assert.match(app, /\$\$\('#side nav a'\)/, 'Navigation link binding must safely select all sidebar links');

assert.match(worker, /const \{ cycle, tier \} = await c\.req\.json/, 'Subscription checkout must accept the plan explicitly selected by the main administrator');
assert.match(worker, /Choose a paid plan/, 'Subscription checkout must reject missing or trial-only plan selections');
assert.match(worker, /selected\.max_students/, 'Subscription checkout must validate selected plan capacity against active students');
assert.match(worker, /UPDATE schools SET status='active', tier=\?, cycle=\?, renews_at=\?/, 'The selected plan must become active only after payment verification');
assert.match(app, /id="plan-tier"/, 'Billing must provide an actual subscription tier selector');
assert.match(app, /body: \{ tier, cycle: \$\('#cy'\)\.value \}/, 'The selected plan and billing cycle must be submitted to the server');
assert.match(sw, /const VERSION = 'v15'/, 'The service worker cache must refresh for the subscription checkout change');

assert.match(platform, /CREATE TABLE IF NOT EXISTS platform_settings/, 'Platform payment settings must persist in the platform database');
assert.match(worker, /owner\.post\('\/settings\/payment-instructions'/, 'Only the authenticated platform owner may configure official payment instructions');
assert.match(worker, /paymentSetting\?\.setting_value/, 'School billing must receive the platform owner configured payment instructions');
assert.match(app, /id="platform-payment-instructions"/, 'The platform owner must have a UI to configure real payment instructions');
assert.match(app, /api\('\/api\/owner\/settings\/payment-instructions'/, 'The owner payment settings form must save through the protected API');

assert.match(html, /class="boot-screen"/, 'The initial HTML must show the animated sign-in check, not the public landing page');
assert.doesNotMatch(html, /class="landing-shell boot-landing"/, 'The public landing page must not flash during app startup');
assert.match(app, /try \{ await refreshMe\(\); \}/, 'Startup must verify the server session before rendering a destination');
assert.match(app, /if \(!ME && path === '\/'\)[\s\S]*?history\.replaceState\(null, '', '\/login'\)/, 'Signed-out visits to the root must route to login, not the public landing page');
assert.match(app, /if \(ME && authRoutes\.includes\(path\)\)[\s\S]*?history\.replaceState/, 'Signed-in users must be redirected away from login and signup');
assert.match(css, /\.boot-screen\{/, 'The secure session check must have a dedicated loading screen');
assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.boot-logo/, 'The boot animation must respect reduced-motion accessibility preferences');
const billingInvoiceRoute = worker.slice(worker.indexOf("app.post('/api/billing/invoice'"), worker.indexOf("app.post('/api/billing/slip'"));
assert.doesNotMatch(billingInvoiceRoute, /UPDATE schools SET tier=/, 'Creating an invoice must not grant the paid tier before payment verification');
assert.match(billingInvoiceRoute, /status='submitted'/, 'A pending payment slip must prevent replacing its invoice');
assert.match(worker, /async function makeInvoice\(env: Env, schoolId: string, selection\?/, 'Invoice generation must support an explicitly selected tier and billing cycle');
assert.match(app, /const selectedTier = open\?\.tier \|\| b\.tier/, 'Billing must retain the selected plan when showing its open invoice');
assert.match(app, /selected-plan-summary/, 'Billing must explain the selected plan capacity, storage and admin allowance');
assert.match(sw, /const VERSION = 'v15'/, 'The installed app cache must refresh for authenticated startup');

assert.doesNotMatch(util, /subAdminCap/, 'Subscription tiers must not carry a Mini Admin seat quota');
assert.doesNotMatch(school, /subAdminCap|plan allows .*Mini Admin account/, 'Creating, promoting or reactivating Mini Admins must not be blocked by plan tier');
assert.match(platform, /UPDATE plans SET sub_admins=1000000/, 'Existing platform plans must be upgraded to unlimited Mini Admin seats');
assert.match(platform, /\['starter',0,500,1000,10000,5,1000000,1\]/, 'New Starter plan records must have unlimited Mini Admin seats');
assert.match(app, /Unlimited Mini Admins, teachers and parents/, 'The billing page must explain that staff roles are unlimited across tiers');
assert.doesNotMatch(app.slice(app.indexOf("// ---------- billing (main admin) ----------"), app.indexOf("// ---------- owner panel ----------")), /sub_admins|Sub-admins/, 'The billing comparison must not imply different staff limits by tier');
assert.match(app, /async function loadBillingStatus\(\)/, 'Billing banners must load separately from the critical sign-in check');
assert.doesNotMatch(app.slice(app.indexOf('async function refreshMe()'), app.indexOf('// ---------- sign in / sign up ----------')), /\/api\/billing/, 'Session discovery must not wait for the billing API');
assert.match(app, /authPage\([\s\S]*?\{ minimal: true \}/, 'The login route must use the minimal sign-in layout');
assert.doesNotMatch(app.slice(app.indexOf("route('/login'"), app.indexOf("route('/signup'")), /Welcome back|Secure sign-in|auth-description/, 'The login form must not show unnecessary welcome or security copy');
assert.match(html, /class="boot-screen"/, 'The initial shell must show only the branded loading experience');
assert.doesNotMatch(html, /Checking your secure sign-in|boot-landing|landing-shell/, 'The public landing page and long security copy must not flash on app startup');
assert.match(worker, /renderSeoPage/, 'The Worker must serve a dedicated public SEO page');
assert.match(worker, /renderSitemap/, 'The Worker must expose a sitemap endpoint');
assert.match(seo, /name="description"/, 'The public SEO page must include a unique description');
assert.match(seo, /application\/ld\+json/, 'The public SEO page must include structured application metadata');
assert.match(seo, /function renderRobots/, 'The SEO module must publish crawler access rules');
assert.match(seo, /function renderSitemap/, 'The SEO module must provide an XML sitemap');
assert.match(wrangler, /"\/about", "\/robots\.txt", "\/sitemap\.xml"/, 'SEO routes must be handled by the Worker rather than the SPA fallback');
assert.match(sw, /const VERSION = 'v15'/, 'PWA cache must refresh for the new login startup and SEO release');

console.log('School platform sanity checks passed: Google role validation, institution-only registration, account IDs, session routing, private API cache protections and offline attendance safeguards.');
