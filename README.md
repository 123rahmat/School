# School Manager

A school and academy management system where each institution gets its own isolated workspace for students,
staff, classes, attendance, fees, family communication, results and reports. It runs on Cloudflare and can be
used in a browser or installed as a web app on supported phones, tablets and desktop browsers.

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

1. **Institution spaces, Google-only sign-in, roles, installable app, owner panel** — Google Identity Services
   verifies the user's Google ID token; the verified email is matched to a staff or guardian record. New
   institution registration creates the main administrator profile and a 14-day trial. Sessions can be revoked
   by the main admin, with new-device alerts and platform billing controls. Password, email-code and phone login
   are not enabled.
2. **Students and teachers** — add one by one or import CSV (from Excel), auto registration numbers, duplicate
   warning, siblings share one parent sign-in, teacher-added students await confirmation, profiles with change
   history, forgiving search (Muhammad/Mohammad/Muhammed, partial words, last 4 phone digits), mark as left /
   restore, leaving certificate, deactivate teacher (signed out everywhere, cash flagged), replace class teacher
   from a date, year-end promotion with exceptions.
3. **Attendance** — everyone present by default, tap the exceptions, draft → review → submit, final for the
   teacher; change requests; admin corrections with reason (parent told); holiday calendar; monthly register
   with %, 3-in-a-row and low-attendance warnings; CSV/print. Attendance retains its date-specific queue, while
   other school forms and supported file uploads use a shared IndexedDB queue in the browser and installed PWA.
   Pending means saved on this device only; received means the school server has acknowledged the submission.
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

**Deliberately excluded from the focused school workflow:** weekly timetable, daily teacher substitution and
substitution bonuses, and a syllabus document library. Existing deployed databases retain any legacy rows and
files from these modules; the cleanup does not erase historical records. Automatic reading of slip amounts,
homework diary, teacher leave and salary remain outside the current scope.

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

Open http://localhost:8787. Add `http://localhost:8787` as an authorized JavaScript origin in
the Google OAuth Web client, then use Google sign-in. Set `OWNER_EMAIL` to the Google account that should access
the platform owner panel. For local development, you may also set `GOOGLE_CLIENT_ID` in `.dev.vars`; never put
a Google Client Secret in frontend code or commit it to the repository.

## Tests

`npm test` runs the repository sanity checks for Google-only authentication, deployment bindings,
the public landing page, PWA/offline queue configuration and idempotent attendance submission.
`npm run typecheck` runs TypeScript checks.

The older browser UI walkthrough in `test/ui.mjs` still uses the retired email/phone-code test flow and
must be migrated before it can be treated as a valid Google-authenticated browser test.

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

Before production use, verify `OWNER_EMAIL`, `GOOGLE_CLIENT_ID`, optional `PUBLIC_CONTACT_EMAIL`, and
`PAYMENT_ACCOUNTS` in `wrangler.toml` or Cloudflare Worker Settings → Variables and Secrets.

Google sign-in is the only authentication method. Staff and guardian records must contain the exact Google email
address they use. Phone numbers remain optional contact information and are never login identifiers. When a Google
email is not registered, the sign-in page offers the user a path to create a new institution account or ask their
institution administrator to add that exact email.

The Web Client ID is public configuration. Do not put a Google Client Secret in browser code or commit credentials
to GitHub. The current Google Identity Services ID-token flow does not need the Google Client Secret.

The public landing page reads its optional contact email from `PUBLIC_CONTACT_EMAIL`. Set it to an address you
want visitors to use; the project does not publish a guessed contact address.

```bash
npm run deploy
```
