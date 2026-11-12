-- Platform database (D1): schools, billing, sign-in lookup. Never holds school records.
CREATE TABLE plans (
  tier TEXT PRIMARY KEY, min_students INTEGER NOT NULL, max_students INTEGER NOT NULL,
  monthly INTEGER NOT NULL, yearly INTEGER NOT NULL, storage_gb REAL NOT NULL, sub_admins INTEGER NOT NULL, sort INTEGER NOT NULL
);
INSERT INTO plans VALUES
 ('trial',0,50,0,0,0.5,1,0),
 ('starter',0,500,1000,10000,5,3,1),
 ('growth',501,800,1500,15000,8,5,2),
 ('large',801,1200,2000,20000,12,8,3),
 ('xl',1201,2000,3000,30000,20,12,4),
 ('custom',2001,1000000,0,0,50,50,5);

CREATE TABLE schools (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'school',
  tier TEXT NOT NULL DEFAULT 'trial', cycle TEXT NOT NULL DEFAULT 'monthly',
  status TEXT NOT NULL DEFAULT 'trial', -- trial | active | grace | paused
  renews_at TEXT NOT NULL, grace_days INTEGER NOT NULL DEFAULT 4,
  price_override INTEGER, extra_storage_gb REAL NOT NULL DEFAULT 0,
  launch_price_until TEXT, students INTEGER NOT NULL DEFAULT 0, storage_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- identifier = lower-case email or normalized phone. One identifier may belong to several schools.
CREATE TABLE logins (
  identifier TEXT NOT NULL, school_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
  PRIMARY KEY (identifier, school_id, kind, ref_id)
);
CREATE INDEX logins_school ON logins(school_id, kind, ref_id);

CREATE TABLE otps (
  identifier TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, purpose TEXT NOT NULL, payload TEXT
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, school_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL,
  device TEXT, label TEXT, created_at TEXT NOT NULL, last_seen TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_ref ON sessions(school_id, kind, ref_id);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY, school_id TEXT NOT NULL, tier TEXT NOT NULL, cycle TEXT NOT NULL, amount INTEGER NOT NULL,
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | paid | cancelled
  created_at TEXT NOT NULL
);
CREATE INDEX invoices_school ON invoices(school_id, status);

CREATE TABLE billing_slips (
  id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, school_id TEXT NOT NULL, txn_id TEXT NOT NULL, amount INTEGER NOT NULL,
  file_key TEXT, status TEXT NOT NULL DEFAULT 'submitted', reason TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE UNIQUE INDEX billing_slips_txn ON billing_slips(txn_id) WHERE status != 'rejected';

CREATE TABLE support_access (
  school_id TEXT PRIMARY KEY, granted_until TEXT NOT NULL
);
CREATE TABLE announcements (
  id TEXT PRIMARY KEY, school_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
