// Each school's private database (SQLite inside its own Durable Object).
export const SCHOOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY, public_id TEXT, name TEXT NOT NULL, email TEXT, phone TEXT,
  role TEXT NOT NULL,              -- admin | subadmin | teacher
  subrole TEXT,                    -- legacy role label for existing sub-admins
  permissions TEXT, scope_classes TEXT, -- granular mini-admin permissions and '*' or JSON class scope
  is_main INTEGER NOT NULL DEFAULT 0,
  subjects TEXT, active INTEGER NOT NULL DEFAULT 1, left_at TEXT, left_reason TEXT,
  search_key TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS academic_sessions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, grade INTEGER NOT NULL DEFAULT 0, section TEXT, room TEXT,
  class_teacher_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS class_teacher_assignments (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL, teacher_id TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT
);
CREATE TABLE IF NOT EXISTS class_subjects (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL, subject TEXT NOT NULL, teacher_id TEXT
);
-- Historical subject ownership is retained when a teacher is replaced.
CREATE TABLE IF NOT EXISTS class_subject_history (
  id TEXT PRIMARY KEY, class_id TEXT NOT NULL, subject TEXT NOT NULL, teacher_id TEXT NOT NULL,
  from_date TEXT NOT NULL, to_date TEXT, changed_by TEXT
);
CREATE INDEX IF NOT EXISTS class_subject_history_class ON class_subject_history(class_id, subject, from_date);

-- Weekly timetable, dated substitutions and syllabus library are intentionally excluded
-- from the focused school workflow. Existing legacy tables are left untouched in
-- existing school databases so historical data and R2 files are not discarded.

CREATE TABLE IF NOT EXISTS guardians (
  id TEXT PRIMARY KEY, public_id TEXT, phone TEXT, email TEXT, name TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS guardians_phone ON guardians(phone);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY, reg_no TEXT NOT NULL UNIQUE, name TEXT NOT NULL, father_name TEXT NOT NULL,
  guardian_id TEXT NOT NULL, class_id TEXT NOT NULL, parent_phone TEXT NOT NULL, parent_email TEXT,
  dob TEXT, gender TEXT, address TEXT, admission_date TEXT, photo_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- pending | active | left
  left_date TEXT, left_reason TEXT, added_by TEXT, confirmed_by TEXT,
  search_key TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS students_class ON students(class_id, status);
CREATE INDEX IF NOT EXISTS students_guardian ON students(guardian_id);

CREATE TABLE IF NOT EXISTS enrollments (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL, class_id TEXT NOT NULL, session_id TEXT NOT NULL,
  from_date TEXT NOT NULL, outcome TEXT, to_date TEXT, class_name_snapshot TEXT
);

CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY, name TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS attendance_days (
  class_id TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  submitted_by TEXT, submitted_at TEXT, reminded INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (class_id, date)
);
CREATE TABLE IF NOT EXISTS attendance_records (
  student_id TEXT NOT NULL, class_id TEXT NOT NULL, date TEXT NOT NULL,
  status TEXT NOT NULL,           -- P | A | L (late) | V (leave)
  marked_by TEXT, source TEXT NOT NULL DEFAULT 'app', updated_at TEXT NOT NULL,
  PRIMARY KEY (student_id, date)
);
CREATE INDEX IF NOT EXISTS attendance_class_date ON attendance_records(class_id, date);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, detail TEXT NOT NULL, reason TEXT NOT NULL,
  requested_by TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', decided_by TEXT, created_at TEXT NOT NULL, decided_at TEXT
);

CREATE TABLE IF NOT EXISTS fee_heads (id TEXT PRIMARY KEY, name TEXT NOT NULL, monthly INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS fee_plans (class_id TEXT NOT NULL, head_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (class_id, head_id));
-- A student's own fee for a head, replacing the class amount (0 removes that head for the student).
CREATE TABLE IF NOT EXISTS student_fee_overrides (student_id TEXT NOT NULL, head_id TEXT NOT NULL, amount INTEGER NOT NULL, PRIMARY KEY (student_id, head_id));
CREATE TABLE IF NOT EXISTS student_discounts (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS vouchers (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, student_id TEXT NOT NULL, class_id TEXT NOT NULL, month TEXT NOT NULL,
  issue_date TEXT NOT NULL, due_date TEXT NOT NULL,
  current INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, arrears INTEGER NOT NULL DEFAULT 0, fine INTEGER NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid', -- unpaid | partial | paid | carried
  last_reminder TEXT, created_at TEXT NOT NULL,
  UNIQUE (student_id, month)
);
CREATE TABLE IF NOT EXISTS voucher_lines (voucher_id TEXT NOT NULL, label TEXT NOT NULL, amount INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, voucher_id TEXT NOT NULL, student_id TEXT NOT NULL, class_id TEXT NOT NULL,
  method TEXT NOT NULL,     -- cash_teacher | easypaisa | jazzcash | office_cash | bank
  amount INTEGER NOT NULL, txn_id TEXT, slip_key TEXT,
  status TEXT NOT NULL,     -- submitted | verified | rejected | cancelled
  submitted_by TEXT NOT NULL, verified_by TEXT, reason TEXT, receipt_no INTEGER,
  held_by TEXT, handover_id TEXT, created_at TEXT NOT NULL, verified_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_txn ON payments(txn_id) WHERE txn_id IS NOT NULL AND status IN ('submitted','verified');
CREATE TABLE IF NOT EXISTS cash_handovers (
  id TEXT PRIMARY KEY, teacher_id TEXT NOT NULL, amount INTEGER NOT NULL, confirmed_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminder_pauses (student_id TEXT PRIMARY KEY, reason TEXT NOT NULL, by TEXT NOT NULL, until TEXT);

CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY, audience TEXT NOT NULL, target_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, subject TEXT,
  posted_by TEXT NOT NULL, poster_name TEXT, auto INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS notice_reads (notice_id TEXT NOT NULL, user_key TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (notice_id, user_key));

CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY, student_id TEXT NOT NULL, sender_key TEXT NOT NULL, sender_name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS thread_student ON thread_messages(student_id, created_at);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY, student_id TEXT, session TEXT NOT NULL, title TEXT NOT NULL, file_key TEXT NOT NULL, file_name TEXT,
  uploaded_by TEXT NOT NULL, published_at TEXT, created_at TEXT NOT NULL, deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY, size INTEGER NOT NULL, kind TEXT NOT NULL, uploaded_by TEXT NOT NULL, content_type TEXT, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS files_deleted_created ON files(deleted_at, created_at);
CREATE TABLE IF NOT EXISTS file_upload_reservations (
  id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS file_reservations_created ON file_upload_reservations(created_at);
CREATE INDEX IF NOT EXISTS vouchers_status_due ON vouchers(status, due_date);
CREATE INDEX IF NOT EXISTS payments_status_verified ON payments(status, verified_at);

-- Messages the admin sends from their own phone via WhatsApp or SMS (no paid gateway).
CREATE TABLE IF NOT EXISTS phone_outbox (
  id TEXT PRIMARY KEY, user_key TEXT NOT NULL, name TEXT, phone TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, sent_at TEXT, sent_by TEXT, channel TEXT
);
CREATE INDEX IF NOT EXISTS phone_outbox_status ON phone_outbox(status, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_key TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, link TEXT, created_at TEXT NOT NULL, read_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_key, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, user_key TEXT NOT NULL, user_name TEXT, action TEXT NOT NULL, entity TEXT, entity_id TEXT,
  detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at);

-- Successful API write receipts prevent duplicate records after interrupted network requests.
CREATE TABLE IF NOT EXISTS api_submissions (
  id TEXT PRIMARY KEY, user_key TEXT NOT NULL, user_name TEXT, method TEXT NOT NULL, path TEXT NOT NULL,
  label TEXT, request_hash TEXT, status TEXT NOT NULL DEFAULT 'processing', http_status INTEGER,
  content_type TEXT, response_body TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_submissions_user_created ON api_submissions(user_key, created_at);
CREATE INDEX IF NOT EXISTS api_submissions_created ON api_submissions(created_at);
`;

export const DEFAULT_SETTINGS: Record<string, string> = {
  voucher_day: '1',
  due_day: '10',
  fine_enabled: '0',
  fine_fixed: '0',
  fine_per_month: '0',
  fine_max: '0',
  teacher_set_fees: '0',
  defaulter_months: '2',
  payment_accounts: '[]',
  fine_per_day: '0',
  attendance_deadline_hour: '10',
  teacher_add_students: '0',
  teacher_verify_slips: '0',
  teacher_upload_results: '0',
  cash_alert_days: '3',
  reminder_days_before: '3',
  result_fee_hold: '0',
  absence_alerts: '1',
  low_attendance_percent: '75',
  reg_prefix: '',
  phone_messages: '1',
};
