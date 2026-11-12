import { DurableObject } from 'cloudflare:workers';
import type { Env } from './util';

type Statement = { sql: string; values: unknown[] };
type Reply = { results: Record<string, unknown>[]; changes: number; lastRowId: number | null };

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS plans (tier TEXT PRIMARY KEY, min_students INTEGER NOT NULL, max_students INTEGER NOT NULL, monthly INTEGER NOT NULL, yearly INTEGER NOT NULL, storage_gb REAL NOT NULL, sub_admins INTEGER NOT NULL, sort INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS schools (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'school', tier TEXT NOT NULL DEFAULT 'trial', cycle TEXT NOT NULL DEFAULT 'monthly', status TEXT NOT NULL DEFAULT 'trial', renews_at TEXT NOT NULL, grace_days INTEGER NOT NULL DEFAULT 4, price_override INTEGER, extra_storage_gb REAL NOT NULL DEFAULT 0, launch_price_until TEXT, students INTEGER NOT NULL DEFAULT 0, storage_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS logins (identifier TEXT NOT NULL, school_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, PRIMARY KEY(identifier, school_id, kind, ref_id))",
  "CREATE INDEX IF NOT EXISTS logins_school ON logins(school_id, kind, ref_id)",
  "CREATE TABLE IF NOT EXISTS otps (identifier TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL, payload TEXT)",
  "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, school_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, device TEXT, label TEXT, created_at TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS sessions_ref ON sessions(school_id, kind, ref_id)",
  "CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, school_id TEXT NOT NULL, tier TEXT NOT NULL, cycle TEXT NOT NULL, amount INTEGER NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS invoices_school ON invoices(school_id, status)",
  "CREATE TABLE IF NOT EXISTS billing_slips (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, school_id TEXT NOT NULL, txn_id TEXT NOT NULL, amount INTEGER NOT NULL, file_key TEXT, status TEXT NOT NULL DEFAULT 'submitted', reason TEXT, created_at TEXT NOT NULL, decided_at TEXT)",
  "CREATE UNIQUE INDEX IF NOT EXISTS billing_slips_txn ON billing_slips(txn_id) WHERE status != 'rejected'",
  "CREATE TABLE IF NOT EXISTS support_access (school_id TEXT PRIMARY KEY, granted_until TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, school_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS storage_requests (id TEXT PRIMARY KEY, school_id TEXT NOT NULL, requested_by TEXT NOT NULL, blocks INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, decided_at TEXT, decision_note TEXT)",
  "CREATE INDEX IF NOT EXISTS storage_requests_school ON storage_requests(school_id, status)"
];

export class PlatformDO extends DurableObject<Env> {
  private sql: SqlStorage;
  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(async () => {
      for (const sql of SCHEMA) this.sql.exec(sql);
      const row = this.sql.exec('SELECT COUNT(*) AS n FROM plans').toArray()[0] as { n: number };
      if (!Number(row?.n)) {
        const plans = [['trial',0,50,0,0,0.5,1,0],['starter',0,500,1000,10000,5,3,1],['growth',501,800,1500,15000,8,5,2],['large',801,1200,2000,20000,12,8,3],['xl',1201,2000,3000,30000,20,12,4],['custom',2001,1000000,0,0,50,50,5]];
        for (const p of plans) this.sql.exec('INSERT OR IGNORE INTO plans (tier,min_students,max_students,monthly,yearly,storage_gb,sub_admins,sort) VALUES (?,?,?,?,?,?,?,?)', ...p);
      }
    });
  }
  private execute(s: Statement): Reply {
    if (!s || typeof s.sql !== 'string' || s.sql.length > 100000 || !Array.isArray(s.values)) throw new Error('Invalid platform SQL statement');
    const cursor = this.sql.exec(s.sql, ...s.values);
    return { results: cursor.toArray() as Record<string, unknown>[], changes: cursor.rowsWritten ?? 0, lastRowId: cursor.lastRowId ?? null };
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || (url.pathname !== '/_sql' && url.pathname !== '/_batch')) return new Response('Not found', { status: 404 });
    try {
      const body = await request.json() as Statement | { statements: Statement[] };
      if (url.pathname === '/_batch') {
        const statements = (body as { statements: Statement[] }).statements;
        if (!Array.isArray(statements) || statements.length > 50) return Response.json({ error: 'Invalid batch' }, { status: 400 });
        const results = this.sql.transactionSync(() => statements.map((s) => this.execute(s)));
        return Response.json(results);
      }
      return Response.json(this.execute(body as Statement));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Platform SQLite operation failed' }, { status: 400 });
    }
  }
}

export class PlatformDatabase {
  constructor(private namespace: DurableObjectNamespace) {}
  private get stub() { return this.namespace.get(this.namespace.idFromName('platform-registry')); }
  prepare(sql: string) {
    const statement: Statement = { sql, values: [] };
    const prepared: any = {
      bind: (...values: unknown[]) => { statement.values = values; return prepared; },
      first: async (column?: string) => { const r = await this.send('/_sql', statement); const row = r.results[0]; return column ? row?.[column] ?? null : row ?? null; },
      all: async () => { const r = await this.send('/_sql', statement); return { results: r.results, success: true, meta: { changes: r.changes, last_row_id: r.lastRowId } }; },
      run: async () => { const r = await this.send('/_sql', statement); return { success: true, meta: { changes: r.changes, last_row_id: r.lastRowId } }; },
      toStatement: () => ({ sql: statement.sql, values: [...statement.values] })
    };
    return prepared;
  }
  async batch(items: any[]) { const rows = await this.send('/_batch', { statements: items.map((x) => x.toStatement()) }); return rows.map((r: any) => ({ success: true, results: r.results, meta: { changes: r.changes, last_row_id: r.lastRowId } })); }
  private async send(path: string, body: unknown): Promise<any> {
    const response = await this.stub.fetch('https://platform.internal' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const result: any = await response.json();
    if (!response.ok) throw new Error(result.error || 'Platform SQLite request failed');
    return result;
  }
}
