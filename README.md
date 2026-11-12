# School Manager

A school management system where each school gets its own isolated space to manage students, teachers,
attendance and fees, with parent alerts, fee reminders and receipts running automatically. It runs on
Cloudflare, installs on any phone or computer from the browser, and schools pay a monthly or yearly plan by size.

Built from the design plan (*School management system: design plan*, Nov 2026), core build steps 1–5.

## How it is built

| Need | Cloudflare piece | Where |
|---|---|---|
| App files (installable PWA) | Workers static assets | `public/` |
| Server logic, sign-in, billing, owner panel | Worker | `src/index.ts` |
| One private database per school | Durable Object with SQLite | `src/school.ts`, `src/schema.ts` |
| Platform records (schools, plans, invoices, sign-in lookup, sessions) | D1 | `migrations/0001_platform.sql` |
| Fee slips, result PDFs | R2 (private; every download is permission-checked) | |
| Daily automation (vouchers, reminders, fines, summaries, billing) | Cron trigger, hourly | `scheduled()` in `src/index.ts` |

**Isolation.** The Worker resolves the session to exactly one school and passes that identity to the school's
own Durable Object. The browser never chooses the school. Inside a school every request goes through one access
layer (`loadActor`, `studentScope`, `student()`, `classOf()` in `src/school.ts`), so parents see only their own
children, subject teachers only their classes and no fees, class teachers their class's fees, the accountant
fees but not message threads. The platform owner sees billing and usage only, never school records.

## What is included

1. **School spaces, sign-in, roles, installable app, owner panel** — password-less sign-in with a one-time code
   (email or phone), sessions tied to a device that the main admin can sign out, new-device alerts, free 14-day
   trial sign-up, owner panel with manual slip confirmation, billing stages (trial → active → reminder → grace → paused → restored),
   automatic invoices sized by active students, support access granted by the school for set hours.
2. **Students and teachers** — add one by one or import CSV (from Excel), auto registration numbers, duplicate
   warning, siblings share one parent sign-in, teacher-added students await confirmation, profiles with change
   history, forgiving search (Muhammad/Mohammad/Muhammed, partial words, last 4 phone digits), mark as left /
   restore, leaving certificate, deactivate teacher (signed out everywhere, cash flagged), replace class teacher
   from a date, year-end promotion with exceptions.
3. **Attendance** — everyone present by default, tap the exceptions, draft → review → submit, final for the
   teacher; change requests; admin corrections with reason (parent told); holiday calendar; monthly register
   with %, 3-in-a-row and low-attendance warnings; CSV/print; works offline and syncs later.
4. **Fees** — fee heads and per-class plans, sibling/scholarship/custom discounts, monthly vouchers with arrears
   and late fines, printable 3-copy vouchers; three ways to pay (cash to class teacher, Easypaisa/JazzCash slip
   upload, office); verify/reject; numbered receipts; duplicate transaction IDs blocked; cash held per teacher and
   handover; unpaid lists (school/class/month), long-term defaulters, collection report; reminders before, on and
   after the due date; receipts never deleted, only cancelled with a reason.
5. **Notices, messages, results, dashboard** — notices to school/class/one student's parents/teachers/admins with
   read counts; one message thread per student (phone numbers hidden, admin can read, reading is logged); result
   PDFs per student or a whole class by registration number, hidden until published, optional fee hold;
   admin dashboard and end-of-day summary.

Also: storage tracking with 80%/95% warnings and upload stop when full, photo compression, audit log, full
JSON backup export (available even when paused), Pakistan time display.

**Fees, extra controls.** Payment accounts: the admin adds any number of accounts (Easypaisa, JazzCash, any bank or
wallet) with company, holder name and number, and can change them any time; parents see them when paying and on
every printed voucher. Each class's fee is set by the admin (or the class teacher, if allowed), and any single
student can have their own amount per fee head; changes update this month's unpaid vouchers at once. Unpaid months
carry into the next voucher automatically, the parent, class teacher and accountant are told when a student
reaches 2+ unpaid months (configurable), and one payment clears all months. Late fines are optional and off by
default: the admin can turn on a fine once after the due date, per day, and/or per month late, with a maximum,
and can add, change or waive the fine on any single voucher with a reason.

**WhatsApp / SMS from the admin's own phone.** Alerts are queued with the text ready; the admin taps WhatsApp or SMS
to send from their own number, at no cost.

**Not built yet (later, per the plan):** automatic reading of slip amounts, timetable and substitution, homework
diary, teacher leave and salary, own-device mode.

## Run it locally

```bash
npm install
```

```bash
npm run db:local
```

```bash
npm run dev
```

Open http://localhost:8787. Choose **Start a free 14-day trial**. In test mode (`DEV_OTP = "1"` in `wrangler.toml`)
the sign-in code is shown on screen. Sign in as the platform owner with the `OWNER_EMAIL` address.

## Tests

With `npm run dev` running:

```bash
npm test
```

runs 77 end-to-end checks, including the plan's must-pass security tests (a parent cannot read another child, a
teacher cannot open a class they don't teach, school A cannot read school B, a removed or signed-out user is refused).

```bash
node test/ui.mjs
```

opens every screen in a real browser as admin, teacher (phone size), parent and owner.

## Deploy to Cloudflare

```bash
npx wrangler d1 create school-platform
```

Put the returned `database_id` into `wrangler.toml`, then:

```bash
npx wrangler r2 bucket create school-files
```

```bash
npx wrangler d1 migrations apply DB --remote
```

Before going live, edit `wrangler.toml`: set `OWNER_EMAIL` to your email, `PAYMENT_ACCOUNTS` to your own Easypaisa
and JazzCash numbers (where schools pay *you*), and `DEV_OTP = "0"`.

Sign-in codes are delivered by these providers. Add the keys as secrets (never in `wrangler.toml`):

- Email codes, via [Resend](https://resend.com) (free tier, verify your domain first):

```bash
npx wrangler secret put RESEND_API_KEY
```

  Also set `EMAIL_FROM = "School Manager <login@yourdomain.pk>"` under `[vars]`.

- Phone codes for parents, via [Twilio](https://twilio.com) SMS, or WhatsApp if you set `TWILIO_WHATSAPP_FROM`:

```bash
npx wrangler secret put TWILIO_ACCOUNT_SID
```

```bash
npx wrangler secret put TWILIO_AUTH_TOKEN
```

  Also set `TWILIO_SMS_FROM` (a number or Messaging Service SID) under `[vars]`.

- Sign in with Google: create an OAuth Web client in Google Cloud Console, add your site as an authorised
  JavaScript origin, and set `GOOGLE_CLIENT_ID` under `[vars]`. The button appears on the sign-in page.

Google sign-in is the only authentication method. Staff and parent records must have the exact email address of the\nGoogle account they use. Phone numbers may be saved for contact and school communications, but are never accepted as\na login identity. Existing accounts that only had phone-based login must have a Google email added by the school admin.\n\nFor local development, put the Web Client ID in `.dev.vars` (do not commit that file). In Cloudflare, add\n`GOOGLE_CLIENT_ID` under the Worker’s Settings → Variables and Secrets. The client ID is public configuration; do not\nput a Google client secret in browser code or commit credentials to GitHub.\n\nThen deploy:

```bash
npm run deploy
```
