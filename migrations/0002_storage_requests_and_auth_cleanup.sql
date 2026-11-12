-- Platform control plane additions.
-- The OTP table is obsolete: Google Identity Services is the sole sign-in method.
DROP TABLE IF EXISTS otps;

CREATE TABLE IF NOT EXISTS storage_requests (
  id TEXT PRIMARY KEY,
  school_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  blocks INTEGER NOT NULL CHECK (blocks BETWEEN 1 AND 10),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS storage_requests_school_created ON storage_requests(school_id, created_at);
CREATE INDEX IF NOT EXISTS storage_requests_status_created ON storage_requests(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS storage_requests_one_pending ON storage_requests(school_id) WHERE status='pending';

CREATE INDEX IF NOT EXISTS sessions_expiry_status ON sessions(revoked, expires_at);
