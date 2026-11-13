import { PlatformDatabase } from './platform';
export interface Env {
  PLATFORM: DurableObjectNamespace;
  SCHOOL: DurableObjectNamespace;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  OWNER_EMAIL: string;
  PAYMENT_ACCOUNTS: string;
  GOOGLE_CLIENT_ID?: string;   // Google Identity Services Web client ID
  PUBLIC_CONTACT_EMAIL?: string; // Optional public contact shown on the landing page
}

/** The trusted identity the Worker passes to a school's object. Never comes from the browser. */
export interface Ctx {
  schoolId: string;
  kind: 'staff' | 'guardian';
  refId: string;
  institutionType: string;
  schoolStatus: string; // trial | active | grace | paused
  studentCap: number;
  subAdminCap: number;
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

export { addDays, addMonths } from './date';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };

const platformDatabases = new WeakMap<Env, PlatformDatabase>();
export function platformDb(env: Env): PlatformDatabase {
  let db = platformDatabases.get(env);
  if (!db) { db = new PlatformDatabase(env.PLATFORM); platformDatabases.set(env, db); }
  return db;
}
