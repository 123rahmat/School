import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const read = (path) => readFile(new URL('../' + path, import.meta.url), 'utf8');
const [wrangler, util, worker, app, sw, school] = await Promise.all([
  read('wrangler.toml'),
  read('src/util.ts'),
  read('src/index.ts'),
  read('public/app.js'),
  read('public/sw.js'),
  read('src/school.ts'),
]);

assert.match(wrangler, /^name = "school"$/m, 'Wrangler deploy target must match the Cloudflare Worker named school');
assert.match(wrangler, /^GOOGLE_CLIENT_ID = ".+apps\.googleusercontent\.com"$/m, 'Google Web Client ID must be configured');
assert.match(wrangler, /^binding = "DB"$/m, 'D1 binding must exist');
assert.match(wrangler, /^binding = "FILES"$/m, 'R2 binding must exist');
assert.match(wrangler, /^invocation_logs = true$/m, 'Wrangler observability config must be present');

assert.match(util, /GOOGLE_CLIENT_ID\?: string/, 'Worker Env must define the Google client ID');
assert.match(util, /PUBLIC_CONTACT_EMAIL\?: string/, 'Worker Env must define optional public contact email');
assert.match(worker, /app\.post\('\/api\/auth\/google'/, 'Google sign-in endpoint must exist');
assert.match(worker, /app\.post\('\/api\/signup\/google'/, 'Google-based institution signup endpoint must exist');
assert.match(worker, /app\.post\('\/api\/auth\/logout'/, 'Server-side session revocation endpoint must exist');
assert.doesNotMatch(worker, /app\.post\('\/api\/(?:auth|signup)\/(?:start|verify)'/, 'Legacy email/phone OTP auth routes must not exist');
assert.match(worker, /claims\.aud !== env\.GOOGLE_CLIENT_ID/, 'Google ID token audience must be checked');
assert.match(worker, /String\(claims\.email_verified\) !== 'true'/, 'Google verified-email claim must be checked');

assert.match(app, /function landingPage\(\)/, 'Public landing page must exist');
assert.match(app, /Use in browser/, 'Landing page must provide browser access');
assert.match(app, /Install app/, 'Landing page must provide install action');
assert.match(app, /route\('\/login'/, 'Google login page must exist');
assert.match(app, /route\('\/signup'/, 'Google signup page must exist');
assert.match(app, /data-login-role="main_admin"/, 'Main administrator sign-in choice must exist');
assert.match(app, /data-login-role="teacher"/, 'Teacher sign-in choice must exist');
assert.match(app, /data-login-role="parent"/, 'Parent sign-in choice must exist');
assert.match(app, /isInstalledApp\(\)/, 'Installed-app entry routing must be device aware');
assert.match(worker, /requestedRole === 'main_admin'/, 'Server must validate the selected sign-in role');
assert.match(school, /publicId: s!\.public_id/, 'Staff accounts must expose their assigned account ID');
assert.match(school, /publicId: g!\.public_id/, 'Parent accounts must expose their assigned account ID');
assert.match(school, /lower\(hex\(randomblob\(16\)\)\)/, 'Account IDs must be generated as opaque hexadecimal values');
assert.match(school, /userId: u\.public_id/, 'Administrator search must return account IDs for lookup');
assert.match(worker, /No main administrator profile is registered/, 'Unregistered main-admin accounts must be directed to institution registration');
assert.match(app, /Teachers and parents do not create their own accounts/, 'Teacher and parent profiles must be provisioned by the institution');
assert.match(app, /att-outbox-v2:/, 'Offline attendance queue must be identity-scoped');
assert.match(app, /credentials: 'same-origin'/, 'API requests must use same-origin session cookies');
assert.match(app, /cache: 'no-store'/, 'API requests must not be served from a browser cache');
assert.match(app, /attendance drafts and submissions are saved on the device/i, 'Offline capability must be described accurately');

assert.match(sw, /const VERSION = 'v8'/, 'PWA shell/cache version must be updated');
assert.match(sw, /self\.skipWaiting\(\)/, 'Updated service worker must activate promptly');
assert.ok(sw.includes("if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return;"), 'Service worker must never cache private API responses or private files');

assert.match(school, /day\.submitted_by === a\.key/, 'Attendance submit retry must be idempotent for the same submitter');

console.log('School platform sanity checks passed: Google role validation, institution-only registration, account IDs, session routing, private API cache protections and offline attendance safeguards.');
