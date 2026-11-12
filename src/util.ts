export interface Env {
  DB: D1Database;
  SCHOOL: DurableObjectNamespace;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  OWNER_EMAIL: string;
  DEV_OTP: string;
  PAYMENT_ACCOUNTS: string;
  // Optional providers. Set the keys with `wrangler secret put`.
  RESEND_API_KEY?: string;      // email codes via Resend
  EMAIL_FROM?: string;          // e.g. "School Manager <login@yourdomain.pk>"
  TWILIO_ACCOUNT_SID?: string;  // SMS / WhatsApp codes via Twilio
  TWILIO_AUTH_TOKEN?: string;
  TWILIO_SMS_FROM?: string;     // e.g. +1xxxxxxxxxx or a Messaging Service SID (MG...)
  TWILIO_WHATSAPP_FROM?: string; // e.g. +14155238886 (sends codes on WhatsApp instead of SMS)
  GOOGLE_CLIENT_ID?: string;    // Sign in with Google
}

/** The trusted identity the Worker passes to a school's object. Never comes from the browser. */
export interface Ctx {
  schoolId: string;
  kind: 'staff' | 'guardian';
  refId: string;
  schoolStatus: string; // trial | active | grace | paused
  studentCap: number;
  storageLimitBytes: number;
}

export const now = () => new Date().toISOString();

export function rid(len = 16): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Emails lower-cased; Pakistani phones normalized to 03xxxxxxxxx. */
export function normId(v: string | null | undefined): string {
  if (!v) return '';
  const s = String(v).trim().toLowerCase();
  if (s.includes('@')) return s;
  let d = s.replace(/[^\d]/g, '');
  if (d.startsWith('92') && d.length === 12) d = '0' + d.slice(2);
  if (d.length === 10 && d.startsWith('3')) d = '0' + d;
  return d;
}

/** Pakistan time helpers (UTC+5, no DST). Times are stored in UTC, shown in PKT. */
export function pkt(d = new Date()) {
  const p = new Date(d.getTime() + 5 * 3600 * 1000);
  const iso = p.toISOString();
  return { date: iso.slice(0, 10), month: iso.slice(0, 7), day: p.getUTCDate(), hour: p.getUTCHours(), weekday: p.getUTCDay() };
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonths(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };
