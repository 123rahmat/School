import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import { Env, Ctx, now, rid, normId, pkt, addDays, HttpError, fail, platformDb } from './util';
import { SCHOOL_SCHEMA, DEFAULT_SETTINGS } from './schema';

type Row = Record<string, any>;

/** Who is asking, resolved from the school's own records on every request. */
export interface Actor {
  key: string; // s:<staffId> | g:<guardianId> | system
  type: 'staff' | 'guardian' | 'system';
  id: string;
  publicId: string;
  name: string;
  role: 'admin' | 'subadmin' | 'teacher' | 'parent' | 'system';
  subrole: string | null;
  isMain: boolean;
  classTeacherOf: Set<string>;
  teaches: Set<string>;
  children: string[];
  permissions: Set<string>;
  scopeClasses: Set<string>;
  scopeAll: boolean;
}

/** Spelling-forgiving key: Muhammad / Mohammad / Muhammed all become "mhmd". */
export function skeleton(s: string): string {
  return String(s || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      w = w.replace(/[^a-z؀-ۿ]/g, '');
      if (!w) return '';
      const first = w[0];
      const rest = w.slice(1).replace(/[aeiouyw]/g, '').replace(/(.)\1+/g, '$1');
      return (first + rest).replace(/^([aeiou])/, 'a');
    })
    .filter(Boolean)
    .join(' ');
}

const STATUS_LABEL: Record<string, string> = { P: 'Present', A: 'Absent', L: 'Late', V: 'Leave' };
const money = (n: number) => 'Rs ' + Math.round(n).toLocaleString('en-PK');

export class SchoolDO extends DurableObject<Env> {
  sql: SqlStorage;
  app: Hono<{ Variables: { actor: Actor; ctx: Ctx } }>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;
    state.blockConcurrencyWhile(async () => {
      for (const stmt of SCHOOL_SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
      // Columns added after the first release (older school databases get them here).
      for (const alter of [
        'ALTER TABLE vouchers ADD COLUMN fine_locked INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE staff ADD COLUMN public_id TEXT',
        'ALTER TABLE staff ADD COLUMN permissions TEXT',
        'ALTER TABLE staff ADD COLUMN scope_classes TEXT',
        'ALTER TABLE enrollments ADD COLUMN to_date TEXT',
        'ALTER TABLE enrollments ADD COLUMN class_name_snapshot TEXT',
        'ALTER TABLE notices ADD COLUMN subject TEXT',
        'ALTER TABLE guardians ADD COLUMN public_id TEXT',
      ]) { try { this.sql.exec(alter); } catch { /* already there */ } }
      // Give existing accounts a stable 128-bit hexadecimal public ID; these IDs are safe to share for lookup.
      this.sql.exec("UPDATE staff SET public_id=lower(hex(randomblob(16))) WHERE public_id IS NULL OR public_id=''");
      this.sql.exec("UPDATE guardians SET public_id=lower(hex(randomblob(16))) WHERE public_id IS NULL OR public_id=''");
      this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS staff_public_id_idx ON staff(public_id)');
      this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS guardians_public_id_idx ON guardians(public_id)');
      // Backfill the legacy one-teacher field into the dated assignment table without
      // deleting or rewriting class_subjects or class_subject_history records.
      this.sql.exec(`INSERT OR IGNORE INTO class_subject_teacher_assignments
        (id, class_subject_id, teacher_id, from_date, to_date, changed_by, created_at)
        SELECT 'legacy_' || cs.id || '_' || cs.teacher_id, cs.id, cs.teacher_id,
          COALESCE((SELECT MAX(h.from_date) FROM class_subject_history h
            WHERE h.class_id=cs.class_id AND h.subject=cs.subject AND h.teacher_id=cs.teacher_id),
            date('now')),
          NULL, 'migration', datetime('now')
        FROM class_subjects cs WHERE cs.teacher_id IS NOT NULL`);
    });
    this.app = this.routes();
  }

  // ---------- tiny SQL helpers ----------
  q(sql: string, ...p: any[]): Row[] { return this.sql.exec(sql, ...p).toArray() as Row[]; }
  one(sql: string, ...p: any[]): Row | null { return this.q(sql, ...p)[0] ?? null; }
  run(sql: string, ...p: any[]) { this.sql.exec(sql, ...p); }
  tx<T>(fn: () => T): T { return this.ctx.storage.transactionSync(fn); }
  setting(k: string): string { return (this.one('SELECT value FROM settings WHERE key=?', k)?.value as string) ?? DEFAULT_SETTINGS[k] ?? ''; }
  num(k: string) { return Number(this.setting(k)) || 0; }

  async fetch(req: Request): Promise<Response> { return this.app.fetch(req); }

  // ---------- identity & access layer ----------
  loadActor(ctx: Ctx): Actor {
    const base = { classTeacherOf: new Set<string>(), teaches: new Set<string>(), children: [] as string[], subrole: null, isMain: false, permissions: new Set<string>(), scopeClasses: new Set<string>(), scopeAll: false };
    if (ctx.refId === 'system') return { ...base, key: 'system', type: 'system', id: 'system', publicId: '', name: 'System', role: 'system', isMain: true, scopeAll: true };
    if (ctx.kind === 'staff') {
      const s = this.one('SELECT * FROM staff WHERE id=? AND active=1', ctx.refId);
      if (!s) fail(401, 'Your account is not active. Please contact the school.');
      let permissions: string[] = [];
      if (s!.permissions) { try { const parsed = JSON.parse(s!.permissions); if (Array.isArray(parsed)) permissions = parsed.filter((x: any) => typeof x === 'string'); } catch {} }
      else if (s!.role === 'subadmin') {
        // One-time compatibility defaults for sub-admins created before granular permissions existed.
        permissions = s!.subrole === 'accountant' ? ['students.view','fees.manage','classes.view','dashboard.view']
          : s!.subrole === 'coordinator' ? ['students.view','attendance.manage','classes.view','notices.manage','dashboard.view']
          : ['students.view','students.manage','fees.manage','classes.view','attendance.manage','notices.manage','dashboard.view'];
      }
      let scopeAll = !s!.scope_classes || s!.scope_classes === '*';
      let scopeClasses: string[] = [];
      if (!scopeAll) { try { const parsed = JSON.parse(s!.scope_classes); if (Array.isArray(parsed)) scopeClasses = parsed.filter((x: any) => typeof x === 'string'); } catch { scopeAll = true; } }
      const a: Actor = { ...base, key: 's:' + s!.id, type: 'staff', id: s!.id, publicId: s!.public_id, name: s!.name, role: s!.role, subrole: s!.subrole, isMain: !!s!.is_main,
        permissions: new Set(permissions), scopeClasses: new Set(scopeClasses), scopeAll };
      for (const r of this.q('SELECT id FROM classes WHERE class_teacher_id=? AND active=1', s!.id)) { a.classTeacherOf.add(r.id); a.teaches.add(r.id); }
      const assignmentDate = pkt().date;
      for (const r of this.q(`SELECT DISTINCT cs.class_id FROM class_subject_teacher_assignments a
        JOIN class_subjects cs ON cs.id=a.class_subject_id
        WHERE a.teacher_id=? AND a.from_date<=? AND (a.to_date IS NULL OR a.to_date>=?)`, s!.id, assignmentDate, assignmentDate)) a.teaches.add(r.class_id);
      return a;
    }
    const g = this.one('SELECT * FROM guardians WHERE id=?', ctx.refId);
    if (!g) fail(401, 'Not found');
    const kids = this.q("SELECT id FROM students WHERE guardian_id=? AND status='active'", g!.id).map((r) => r.id);
    if (!kids.length) fail(401, 'No active student is linked to this sign-in.');
    return { ...base, key: 'g:' + g!.id, type: 'guardian', id: g!.id, publicId: g!.public_id, name: g!.name || 'Parent', role: 'parent', children: kids };
  }

  isAdmin(a: Actor) { return this.isFullAdmin(a) || (a.role === 'subadmin' && a.permissions.size > 0); }
  isFullAdmin(a: Actor) { return a.role === 'admin' || a.role === 'system'; }
  hasPermission(a: Actor, permission: string) { return this.isFullAdmin(a) || a.permissions.has(permission); }
  inClassScope(a: Actor, classId: string) { return this.isFullAdmin(a) || (a.role === 'subadmin' ? (a.scopeAll || a.scopeClasses.has(classId)) : a.teaches.has(classId)); }
  scopedClassIds(a: Actor): string[] {
    if (this.isFullAdmin(a)) return this.q('SELECT id FROM classes WHERE active=1').map((r) => r.id);
    if (a.role === 'subadmin') return a.scopeAll ? this.q('SELECT id FROM classes WHERE active=1').map((r) => r.id) : [...a.scopeClasses];
    return [...a.teaches];
  }
  canFeesAll(a: Actor) { return this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'fees.manage')); }
  canManageStudents(a: Actor) { return this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'students.manage')); }
  requireAdmin(a: Actor) { if (!this.isAdmin(a)) fail(403, 'Only administrators can do this'); }
  requirePermission(a: Actor, permission: string) { if (!this.hasPermission(a, permission)) fail(403, 'Your account has not been granted the ' + permission.replace('.', ' ') + ' permission'); }
  requireFullAdmin(a: Actor) { if (!this.isFullAdmin(a)) fail(403, 'Only a full administrator can do this'); }
  requireMain(a: Actor) { if (!a.isMain) fail(403, 'Only the main admin can do this'); }

  /** SQL filter for the students this person may see. Every student list goes through it. */
  studentScope(a: Actor, alias = 'st'): [string, any[]] {
    if (this.isFullAdmin(a)) return ['1=1', []];
    if (a.type === 'guardian') return [`${alias}.guardian_id=?`, [a.id]];
    if (a.role === 'subadmin') {
      if (!this.hasPermission(a, 'students.view') && !this.hasPermission(a, 'students.manage') && !this.canFeesAll(a) && !this.hasPermission(a, 'attendance.manage') && !this.hasPermission(a, 'notices.manage') && !this.hasPermission(a, 'results.manage') && !a.teaches.size) return ['0=1', []];
      const ids = [...new Set([...this.scopedClassIds(a), ...a.teaches])];
      if (!ids.length) return ['0=1', []];
      return [`${alias}.class_id IN (${ids.map(() => '?').join(',')})`, ids];
    }
    const ids = [...a.teaches];
    if (!ids.length) return ['0=1', []];
    return [`${alias}.class_id IN (${ids.map(() => '?').join(',')})`, ids];
  }

  student(a: Actor, id: string, need: 'view' | 'fees' | 'edit' = 'view'): Row {
    const s = this.one('SELECT * FROM students WHERE id=?', id);
    if (!s) fail(404, 'Student not found');
    const st = s!;
    const scoped = this.isFullAdmin(a) || (a.role === 'subadmin' && this.inClassScope(a, st.class_id));
    let ok = false;
    if (need === 'edit') ok = this.canManageStudents(a) && scoped;
    else if (need === 'fees') ok = (this.canFeesAll(a) && scoped) || a.classTeacherOf.has(st.class_id) || (a.type === 'guardian' && st.guardian_id === a.id);
    else ok = this.isFullAdmin(a) || (a.role === 'subadmin' && scoped && (this.hasPermission(a, 'students.view') || this.canManageStudents(a) || this.canFeesAll(a) || this.hasPermission(a, 'attendance.manage') || this.hasPermission(a, 'notices.manage') || this.hasPermission(a, 'results.manage'))) || a.teaches.has(st.class_id) || (a.type === 'guardian' && st.guardian_id === a.id);
    if (!ok) fail(403, 'You do not have access to this student');
    return st;
  }

  classOf(a: Actor, id: string, need: 'view' | 'teacher' = 'view'): Row {
    const c = this.one('SELECT * FROM classes WHERE id=?', id);
    if (!c) fail(404, 'Class not found');
    if (this.isFullAdmin(a)) return c!;
    if (a.classTeacherOf.has(id)) return c!;
    if (need === 'view' && a.teaches.has(id)) return c!;
    if (a.role === 'subadmin') {
      if (!this.inClassScope(a, id)) fail(403, 'This class is outside your assigned scope');
      if (need === 'teacher' && !this.hasPermission(a, 'attendance.manage')) fail(403, 'Attendance management permission is required');
      const allowed = ['students.view','students.manage','fees.manage','attendance.manage','classes.view','notices.manage','results.manage'].some((p) => this.hasPermission(a, p));
      if (allowed) return c!;
      fail(403, 'Your account has no access to this class');
    }
    fail(403, 'You do not have access to this class');
    return c!;
  }

  writable(ctx: Ctx) {
    if (ctx.schoolStatus === 'paused') fail(402, 'The school is paused for non-payment. You can view and export data; the main admin can restore it under Billing.');
  }

  audit(a: Actor, action: string, entity: string | null, entityId: string | null, detail?: any) {
    this.run('INSERT INTO audit_log (id, user_key, user_name, action, entity, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?,?)',
      rid(12), a.key, a.name, action, entity, entityId, detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail), now());
  }

  notify(userKey: string, title: string, body: string, link?: string) {
    this.run('INSERT INTO notifications (id, user_key, title, body, link, created_at) VALUES (?,?,?,?,?,?)', rid(12), userKey, title, body, link ?? null, now());
    this.queuePhone(userKey, title, body);
  }

  /** Queue a WhatsApp/SMS for parents and teachers; the admin sends it from their own phone. */
  queuePhone(userKey: string, title: string, body: string) {
    if (this.setting('phone_messages') !== '1') return;
    let who: Row | null = null, kind = '';
    if (userKey.startsWith('g:')) { who = this.one('SELECT name, phone FROM guardians WHERE id=?', userKey.slice(2)); kind = 'parent'; }
    else if (userKey.startsWith('s:')) { who = this.one("SELECT name, phone FROM staff WHERE id=? AND role='teacher' AND active=1", userKey.slice(2)); kind = 'teacher'; }
    if (!who?.phone) return;
    const school = this.one("SELECT value FROM meta WHERE key='school_name'")?.value || 'School';
    this.run('INSERT INTO phone_outbox (id, user_key, name, phone, kind, text, created_at) VALUES (?,?,?,?,?,?,?)',
      'po_' + rid(12), userKey, who.name, who.phone, kind, `${school}: ${title}\n${body}`, now());
  }
  notifyParentOf(studentId: string, title: string, body: string, link?: string) {
    const s = this.one('SELECT guardian_id, name FROM students WHERE id=?', studentId);
    if (s) this.notify('g:' + s.guardian_id, title, `${s.name}: ${body}`, link ?? `#/student/${studentId}`);
  }
  notifyAdmins(title: string, body: string, opts: { mainOnly?: boolean; subrole?: string; link?: string } = {}) {
    let rows = this.q("SELECT id, role, subrole, is_main FROM staff WHERE active=1 AND role IN ('admin','subadmin')");
    if (opts.mainOnly) rows = rows.filter((r) => r.is_main);
    else if (opts.subrole) rows = rows.filter((r) => r.role === 'admin' || r.subrole === opts.subrole);
    for (const r of rows) this.notify('s:' + r.id, title, body, opts.link);
  }
  notifyClassTeacher(classId: string, title: string, body: string, link?: string) {
    const c = this.one('SELECT class_teacher_id FROM classes WHERE id=?', classId);
    if (c?.class_teacher_id) this.notify('s:' + c.class_teacher_id, title, body, link);
  }

  /** Keep the platform sign-in lookup in step with the school's records. */
  async syncLogin(kind: 'staff' | 'guardian', refId: string, ids: string[], revoke = false) {
    const schoolId = this.schoolId();
    const stmts = [platformDb(this.env).prepare('DELETE FROM logins WHERE school_id=? AND kind=? AND ref_id=?').bind(schoolId, kind, refId)];
    for (const i of [...new Set(ids.map(normId).filter((value) => value.includes('@')))])
      stmts.push(platformDb(this.env).prepare('INSERT OR IGNORE INTO logins (identifier, school_id, kind, ref_id) VALUES (?,?,?,?)').bind(i, schoolId, kind, refId));
    if (revoke) stmts.push(platformDb(this.env).prepare('UPDATE sessions SET revoked=1 WHERE school_id=? AND kind=? AND ref_id=?').bind(schoolId, kind, refId));
    await platformDb(this.env).batch(stmts);
  }
  schoolId(): string { return this.one("SELECT value FROM meta WHERE key='school_id'")?.value as string; }

  /** Physical R2 usage: active files, recycle-bin files awaiting purge, and uploads in flight. */
  storageUsed(): number {
    const files = Number(this.one('SELECT COALESCE(SUM(size),0) AS n FROM files')?.n || 0);
    const pending = Number(this.one('SELECT COALESCE(SUM(size),0) AS n FROM file_upload_reservations')?.n || 0);
    return files + pending;
  }

  async putFile(ctx: Ctx, a: Actor, file: File, kind: string, maxMb = 10): Promise<string> {
    if (file.size > maxMb * 1024 * 1024) fail(400, `File too large (max ${maxMb} MB)`);
    const contentType = String(file.type || '').split(';')[0].trim().toLowerCase();
    const allowedTypes = kind === 'results' ? ['application/pdf'] : kind === 'slips' ? ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] : [];
    if (!allowedTypes.includes(contentType)) fail(400, kind === 'results' ? 'Results must be uploaded as PDF files' : 'Upload a PDF, JPEG, PNG or WebP file');
    // Browser-provided Content-Type is untrusted; compare it with the file signature.
    const sig = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isPdf = sig[0] === 0x25 && sig[1] === 0x50 && sig[2] === 0x44 && sig[3] === 0x46 && sig[4] === 0x2d;
    const isJpeg = sig[0] === 0xff && sig[1] === 0xd8 && sig[2] === 0xff;
    const isPng = sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4e && sig[3] === 0x47 &&
      sig[4] === 0x0d && sig[5] === 0x0a && sig[6] === 0x1a && sig[7] === 0x0a;
    const isWebp = sig[0] === 0x52 && sig[1] === 0x49 && sig[2] === 0x46 && sig[3] === 0x46 &&
      sig[8] === 0x57 && sig[9] === 0x45 && sig[10] === 0x42 && sig[11] === 0x50;
    const signatureMatches = contentType === 'application/pdf' ? isPdf : contentType === 'image/jpeg' ? isJpeg :
      contentType === 'image/png' ? isPng : contentType === 'image/webp' ? isWebp : false;
    if (!signatureMatches) fail(400, 'The uploaded file content does not match its declared file type.');
    const key = `${ctx.schoolId}/${kind}/${rid(16)}-${(file.name || 'file').replace(/[^\w.-]/g, '_').slice(-60)}`;
    const reservation = 'up_' + rid(12);
    // Reserve synchronously before the network await. Concurrent uploads in this
    // Durable Object see the reservation and cannot collectively exceed the quota.
    if (this.storageUsed() + file.size > ctx.storageLimitBytes) fail(507, 'Storage is full. Add a 5 GB storage block under Billing.');
    this.run('INSERT INTO file_upload_reservations (id, key, size, created_at) VALUES (?,?,?,?)', reservation, key, file.size, now());
    try {
      await this.env.FILES.put(key, file.stream(), { httpMetadata: { contentType } });
      this.tx(() => {
        this.run('INSERT INTO files (key, size, kind, uploaded_by, content_type, created_at) VALUES (?,?,?,?,?,?)', key, file.size, kind, a.key, contentType, now());
        this.run('DELETE FROM file_upload_reservations WHERE id=?', reservation);
      });
    } catch (error) {
      try { await this.env.FILES.delete(key); } catch (cleanupError) { console.error('R2 upload cleanup failed', key, cleanupError); }
      this.run('DELETE FROM file_upload_reservations WHERE id=?', reservation);
      throw error;
    }
    const used = this.storageUsed(), limit = ctx.storageLimitBytes;
    const ratio = limit > 0 ? used / limit : 1;
    const reached: number[] = [];
    for (const pct of [80, 95, 98]) {
      const key = `storage_warning_${pct}`;
      if (ratio < (pct - 5) / 100) {
        this.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', key, '0');
      } else if (ratio >= pct / 100 && this.setting(key) !== '1') {
        this.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', key, '1');
        reached.push(pct);
      }
    }
    if (reached.length) {
      const remaining = Math.max(0, 100 - ratio * 100);
      this.notifyAdmins(reached.includes(98) ? 'Storage almost full' : 'Storage usage warning',
        reached.includes(98)
          ? `Only ${remaining.toFixed(1)}% storage remains. Request another 5 GB block under Billing before uploads reach the limit.`
          : `Storage has reached ${reached.join('% and ')}% of its allowance.`,
        { mainOnly: true });
    }
    return key;
  }

  // ---------- registration numbers, guardians ----------
  nextRegNo(): string {
    const y = pkt().date.slice(0, 4);
    const prefix = (this.setting('reg_prefix') || y) + '-';
    const last = this.one('SELECT reg_no FROM students WHERE reg_no LIKE ? ORDER BY length(reg_no) DESC, reg_no DESC LIMIT 1', prefix + '%');
    const n = last ? Number(String(last.reg_no).slice(prefix.length)) + 1 : 1;
    return prefix + String(n || 1).padStart(4, '0');
  }

  guardianFor(phone: string, email: string | null, fatherName: string): string {
    const p = normId(phone || '') || null;
    const e = normId(email || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) fail(400, 'A valid parent email is required for Google sign-in');
    const g = this.one('SELECT * FROM guardians WHERE email=?', e);
    if (g) {
      if (p && p !== g.phone) this.run('UPDATE guardians SET phone=? WHERE id=?', p, g.id);
      return g.id;
    }
    const id = 'g_' + rid(12);
    this.run('INSERT INTO guardians (id, public_id, phone, email, name, created_at) VALUES (?, lower(hex(randomblob(16))), ?,?,?,?)', id, p, e, fatherName, now());
    return id;
  }
  async syncGuardian(gid: string) {
    const g = this.one('SELECT * FROM guardians WHERE id=?', gid);
    const active = this.one("SELECT COUNT(*) AS n FROM students WHERE guardian_id=? AND status='active'", gid)?.n;
    await this.syncLogin('guardian', gid, active && g ? [g.email] : [], !active);
  }

  currentSession(): Row {
    let s = this.one('SELECT * FROM academic_sessions WHERE current=1');
    if (!s) {
      const y = Number(pkt().date.slice(0, 4));
      const id = 'ses_' + rid(8);
      this.run('INSERT INTO academic_sessions (id, name, current, created_at) VALUES (?,?,1,?)', id, `${y}-${y + 1}`, now());
      s = this.one('SELECT * FROM academic_sessions WHERE id=?', id);
    }
    return s!;
  }

  // ---------- students ----------
  createStudent(a: Actor, ctx: Ctx, b: Row): Row {
    for (const f of ['name', 'father_name', 'class_id', 'parent_email']) if (!String(b[f] ?? '').trim()) fail(400, `Missing ${f.replace('_', ' ')}`);
    const cls = this.one('SELECT * FROM classes WHERE id=? AND active=1', b.class_id);
    if (!cls) fail(400, 'Unknown class');
    const byTeacher = !this.canManageStudents(a);
    if (byTeacher) {
      if (this.setting('teacher_add_students') !== '1' || !a.classTeacherOf.has(b.class_id)) fail(403, 'Only the class teacher can add students to their own class, if the admin allows it');
    }
    const activeCount = Number(this.one("SELECT COUNT(*) AS n FROM students WHERE status!='left'")?.n || 0);
    if (activeCount >= ctx.studentCap) fail(402, `Your plan allows ${ctx.studentCap} students. Upgrade under Billing.`);
    const reg = String(b.reg_no || '').trim() || this.nextRegNo();
    if (this.one('SELECT 1 FROM students WHERE reg_no=?', reg)) fail(409, `Registration number ${reg} already exists`);
    const phone = normId(b.parent_phone || '');
    if (phone && !/^0\d{10}$/.test(phone)) fail(400, 'Parent phone should look like 03001234567');
    const email = normId(b.parent_email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid parent email for Google sign-in');
    const id = 'st_' + rid(12);
    const gid = this.guardianFor(phone, email, b.father_name);
    const status = byTeacher ? 'pending' : 'active';
    this.run(`INSERT INTO students (id, reg_no, name, father_name, guardian_id, class_id, parent_phone, parent_email, dob, gender, address, admission_date,
      status, added_by, confirmed_by, search_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, reg, b.name.trim(), b.father_name.trim(), gid, b.class_id, phone, b.parent_email ? normId(b.parent_email) : null,
      b.dob || null, b.gender || null, b.address || null, b.admission_date || pkt().date, status, a.key, byTeacher ? null : a.key,
      skeleton(b.name + ' ' + b.father_name), now());
    this.run('INSERT INTO enrollments (id, student_id, class_id, session_id, from_date) VALUES (?,?,?,?,?)', rid(12), id, b.class_id, this.currentSession().id, pkt().date);
    this.audit(a, 'student.add', 'student', id, { reg_no: reg, status });
    if (byTeacher) this.notifyAdmins('Student awaiting confirmation', `${b.name} added to ${cls!.name} by ${a.name}`, { link: '#/students?status=pending' });
    return this.one('SELECT * FROM students WHERE id=?', id)!;
  }

  duplicateWarning(b: Row): string | null {
    const d = this.one("SELECT reg_no FROM students WHERE lower(name)=lower(?) AND lower(father_name)=lower(?) AND class_id=? AND status!='left'", b.name?.trim(), b.father_name?.trim(), b.class_id);
    return d ? `A student with the same name and father's name already exists in this class (${d.reg_no}).` : null;
  }

  // ---------- attendance ----------
  attendanceSheet(a: Actor, classId: string, date: string) {
    const cls = this.classOf(a, classId, 'view');
    const day = this.one('SELECT * FROM attendance_days WHERE class_id=? AND date=?', classId, date);
    const students = this.q(`SELECT s.id, s.name, s.father_name, s.reg_no, COALESCE(r.status,'P') AS status FROM students s
      LEFT JOIN attendance_records r ON r.student_id=s.id AND r.date=? WHERE s.class_id=? AND s.status IN ('active','pending') ORDER BY s.name`, date, classId);
    const holiday = this.one('SELECT name FROM holidays WHERE date=?', date);
    return { class: cls, date, status: day?.status || 'new', submitted_at: day?.submitted_at, submitted_by: day?.submitted_by, holiday: holiday?.name || null, students };
  }

  saveAttendance(a: Actor, classId: string, date: string, records: Record<string, string>, submit: boolean) {
    this.classOf(a, classId, 'teacher');
    if (date > pkt().date) fail(400, 'Cannot mark attendance for a future date');
    if (this.one('SELECT 1 FROM holidays WHERE date=?', date)) fail(400, 'This date is a holiday');
    const day = this.one('SELECT * FROM attendance_days WHERE class_id=? AND date=?', classId, date);
    if (day?.status === 'submitted') {
      // A queued offline submit may be retried after the server committed it but
      // the response was lost. Treat the same submitter's retry as an acknowledgement,
      // without repeating audit entries or parent notifications.
      if (submit && day.submitted_by === a.key) return this.attendanceSheet(a, classId, date);
      fail(409, 'Attendance is already submitted. Send a change request to the admin.');
    }
    const valid = new Set(this.q("SELECT id FROM students WHERE class_id=? AND status IN ('active','pending')", classId).map((r) => r.id));
    const t = now();
    this.tx(() => {
      for (const sid of valid) {
        const st = records[sid] && STATUS_LABEL[records[sid]] ? records[sid] : 'P';
        this.run(`INSERT INTO attendance_records (student_id, class_id, date, status, marked_by, updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(student_id, date) DO UPDATE SET status=excluded.status, marked_by=excluded.marked_by, updated_at=excluded.updated_at, class_id=excluded.class_id`,
          sid, classId, date, st, a.key, t);
      }
      this.run(`INSERT INTO attendance_days (class_id, date, status, submitted_by, submitted_at) VALUES (?,?,?,?,?)
        ON CONFLICT(class_id, date) DO UPDATE SET status=excluded.status, submitted_by=excluded.submitted_by, submitted_at=excluded.submitted_at`,
        classId, date, submit ? 'submitted' : 'draft', submit ? a.key : null, submit ? t : null);
    });
    if (submit) {
      this.audit(a, 'attendance.submit', 'class', classId, { date });
      if (this.setting('absence_alerts') === '1') {
        for (const r of this.q("SELECT student_id, status FROM attendance_records WHERE class_id=? AND date=? AND status IN ('A','L')", classId, date))
          this.notifyParentOf(r.student_id, r.status === 'A' ? 'Absent today' : 'Late today', `marked ${STATUS_LABEL[r.status].toLowerCase()} on ${date}.`);
      }
      this.checkAbsenceStreaks(classId, date);
    }
    return this.attendanceSheet(a, classId, date);
  }

  checkAbsenceStreaks(classId: string, date: string) {
    for (const r of this.q("SELECT student_id FROM attendance_records WHERE class_id=? AND date=? AND status='A'", classId, date)) {
      const last = this.q('SELECT status FROM attendance_records WHERE student_id=? AND date<=? ORDER BY date DESC LIMIT 3', r.student_id, date);
      if (last.length === 3 && last.every((x) => x.status === 'A')) {
        const s = this.one('SELECT name FROM students WHERE id=?', r.student_id)!;
        this.notifyClassTeacher(classId, 'Absent 3 days in a row', `${s.name} has been absent for 3 school days in a row.`, `#/student/${r.student_id}`);
        this.notifyAdmins('Absent 3 days in a row', `${s.name} has been absent for 3 school days in a row.`, { subrole: 'coordinator', link: `#/student/${r.student_id}` });
      }
    }
  }

  correctAttendance(a: Actor, studentId: string, date: string, status: string, reason: string) {
    if (!STATUS_LABEL[status]) fail(400, 'Unknown status');
    if (!reason) fail(400, 'A reason is required');
    const st = this.student(a, studentId);
    const old = this.one('SELECT status FROM attendance_records WHERE student_id=? AND date=?', studentId, date);
    this.run(`INSERT INTO attendance_records (student_id, class_id, date, status, marked_by, source, updated_at) VALUES (?,?,?,?,?, 'correction', ?)
      ON CONFLICT(student_id, date) DO UPDATE SET status=excluded.status, marked_by=excluded.marked_by, source='correction', updated_at=excluded.updated_at`,
      studentId, st.class_id, date, status, a.key, now());
    this.audit(a, 'attendance.correct', 'student', studentId, { date, old: old?.status ?? null, new: status, reason });
    this.notifyParentOf(studentId, 'Attendance corrected', `${date} changed from ${STATUS_LABEL[old?.status] || 'not marked'} to ${STATUS_LABEL[status]}. Reason: ${reason}`);
  }

  monthAttendance(studentIds: string[], month: string) {
    if (!studentIds.length) return [];
    return this.q(`SELECT student_id, date, status FROM attendance_records WHERE date LIKE ? AND student_id IN (${studentIds.map(() => '?').join(',')}) ORDER BY date`, month + '%', ...studentIds);
  }

  // ---------- fees ----------
  voucherTotal(v: Row) { return v.current - v.discount + v.arrears + v.fine; }

  /** The monthly fee lines for one student: the class plan, with the student's own amounts replacing it where set. */
  feeLines(s: Row): Row[] {
    const plan = this.q('SELECT h.id AS head_id, h.name, p.amount FROM fee_plans p JOIN fee_heads h ON h.id=p.head_id WHERE p.class_id=? AND h.monthly=1', s.class_id);
    const own = new Map(this.q('SELECT head_id, amount FROM student_fee_overrides WHERE student_id=?', s.id).map((o) => [o.head_id, o.amount]));
    const lines: Row[] = plan.map((l) => ({ ...l, amount: own.has(l.head_id) ? own.get(l.head_id) : l.amount, custom: own.has(l.head_id) }));
    for (const [hid, amt] of own) if (!plan.some((l) => l.head_id === hid)) {
      const h = this.one('SELECT name, monthly FROM fee_heads WHERE id=?', hid);
      if (h?.monthly) lines.push({ head_id: hid, name: h.name, amount: amt, custom: true });
    }
    return lines.filter((l) => l.amount > 0);
  }

  /** After a fee change, update this month's voucher if nothing has been paid on it yet. */
  refreshOpenVoucher(studentId: string) {
    const s = this.one('SELECT * FROM students WHERE id=?', studentId); if (!s) return;
    const v = this.one("SELECT * FROM vouchers WHERE student_id=? AND status='unpaid' AND paid=0 ORDER BY month DESC LIMIT 1", studentId);
    if (!v || v.month !== pkt().month) return;
    const lines = this.feeLines(s);
    const current = lines.reduce((t, l) => t + l.amount, 0);
    const discount = Math.min(current, this.q('SELECT amount FROM student_discounts WHERE student_id=?', s.id).reduce((t, d) => t + d.amount, 0));
    this.run("DELETE FROM voucher_lines WHERE voucher_id=? AND label NOT IN ('Arrears')", v.id);
    for (const l of lines) this.run('INSERT INTO voucher_lines VALUES (?,?,?)', v.id, l.name, l.amount);
    if (discount) this.run('INSERT INTO voucher_lines VALUES (?,?,?)', v.id, 'Discount', -discount);
    this.run('UPDATE vouchers SET current=?, discount=? WHERE id=?', current, discount, v.id);
  }

  canSetFees(a: Actor, classId: string) {
    return this.isFullAdmin(a) || (a.role === 'subadmin' && this.canFeesAll(a) && this.inClassScope(a, classId)) ||
      (this.setting('teacher_set_fees') === '1' && a.classTeacherOf.has(classId));
  }

  /** Optional late fine set by the admin: fixed + per day + per month late, capped. Off unless the admin turns it on. */
  autoFine(v: Row, date: string): number {
    if (this.setting('fine_enabled') !== '1' || v.fine_locked) return v.fine;
    const late = Math.round((Date.parse(date) - Date.parse(v.due_date)) / 864e5);
    if (late <= 0) return 0;
    let fine = this.num('fine_fixed') + this.num('fine_per_day') * late + this.num('fine_per_month') * Math.ceil(late / 30);
    const max = this.num('fine_max');
    if (max > 0) fine = Math.min(fine, max);
    return fine;
  }

  unpaidMonths(studentId: string): number {
    return Number(this.one("SELECT COUNT(*) AS n FROM vouchers WHERE student_id=? AND status IN ('unpaid','partial','carried')", studentId)!.n);
  }
  voucherBalance(v: Row) { return this.voucherTotal(v) - v.paid; }

  generateVouchers(a: Actor, month: string, studentIds?: string[], classIds?: string[]) {
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'Month should be YYYY-MM');
    const heads = this.q('SELECT * FROM fee_heads');
    const dueDay = Math.min(28, Math.max(1, this.num('due_day') || 10));
    const issue = pkt().date;
    const due = `${month}-${String(dueDay).padStart(2, '0')}`;
    let students = this.q("SELECT * FROM students WHERE status='active'");
    if (studentIds) students = students.filter((s) => studentIds.includes(s.id));
    if (classIds) students = students.filter((s) => classIds.includes(s.class_id));
    let created = 0;
    let num = Number(this.one('SELECT COALESCE(MAX(number),1000) AS n FROM vouchers')!.n);
    // Sibling discount: from setting? Discounts are stored per student; nothing automatic beyond what the admin sets.
    this.tx(() => {
      for (const s of students) {
        if (this.one('SELECT 1 FROM vouchers WHERE student_id=? AND month=?', s.id, month)) continue;
        const lines = this.feeLines(s);
        if (!lines.length && !heads.length) continue;
        const current = lines.reduce((t, l) => t + l.amount, 0);
        const discount = Math.min(current, this.q('SELECT amount FROM student_discounts WHERE student_id=?', s.id).reduce((t, d) => t + d.amount, 0));
        const prev = this.q("SELECT * FROM vouchers WHERE student_id=? AND status IN ('unpaid','partial') AND month<?", s.id, month);
        const arrears = prev.reduce((t, v) => t + this.voucherBalance(v), 0);
        for (const v of prev) this.run("UPDATE vouchers SET status='carried' WHERE id=?", v.id);
        if (current - discount + arrears <= 0) continue;
        const id = 'v_' + rid(12);
        num += 1;
        this.run(`INSERT INTO vouchers (id, number, student_id, class_id, month, issue_date, due_date, current, discount, arrears, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, num, s.id, s.class_id, month, issue, due, current, discount, arrears, now());
        for (const l of lines) this.run('INSERT INTO voucher_lines VALUES (?,?,?)', id, l.name, l.amount);
        if (discount) this.run('INSERT INTO voucher_lines VALUES (?,?,?)', id, 'Discount', -discount);
        if (arrears) this.run('INSERT INTO voucher_lines VALUES (?,?,?)', id, 'Arrears', arrears);
        this.notifyParentOf(s.id, 'Fee voucher issued', `${money(current - discount + arrears)} for ${month}, due ${due}.`, `#/student/${s.id}`);
        created++;
        // Students who have not paid for several months are flagged automatically.
        const months = this.unpaidMonths(s.id);
        if (months >= (this.num('defaulter_months') || 2)) {
          const msg = `${s.name}: fee for ${months} months is pending. Total due ${money(current - discount + arrears)}.`;
          this.notifyParentOf(s.id, 'Fee pending for ' + months + ' months', `fee for ${months} months is pending. Total due ${money(current - discount + arrears)}. Please pay to avoid further fines.`);
          this.notifyClassTeacher(s.class_id, 'Long-term unpaid', msg, `#/student/${s.id}?tab=fees`);
          this.notifyAdmins('Long-term unpaid', msg, { subrole: 'accountant', link: '#/fees/defaulters' });
        }
      }
    });
    this.audit(a, 'vouchers.generate', 'month', month, { created });
    return { created };
  }

  latestVoucher(studentId: string): Row | null {
    return this.one("SELECT * FROM vouchers WHERE student_id=? AND status NOT IN ('carried','settled') ORDER BY month DESC LIMIT 1", studentId);
  }

  applyVerified(p: Row) {
    const found = this.one('SELECT * FROM vouchers WHERE id=?', p.voucher_id);
    if (!found) fail(404, 'Voucher not found');
    const v = found as Row;
    if (v.status === 'carried') fail(409, 'This voucher has been carried into a newer one. Verify payment against the latest voucher.');
    const balance = this.voucherBalance(v);
    if (!(Number(p.amount) > 0) || Number(p.amount) > balance) fail(409, `Payment exceeds the remaining voucher balance of ${money(balance)}.`);
    const paid = v.paid + p.amount;
    const status = paid >= this.voucherTotal(v) ? 'paid' : 'partial';
    const receipt = Number(this.one('SELECT COALESCE(MAX(receipt_no),0) AS n FROM payments')!.n) + 1;
    this.run('UPDATE vouchers SET paid=?, status=? WHERE id=?', paid, status, v.id);
    // Older months carried into this voucher are settled once the arrears are covered.
    if (paid >= v.arrears) this.run("UPDATE vouchers SET status='settled' WHERE student_id=? AND status='carried' AND month<?", v.student_id, v.month);
    this.run("UPDATE payments SET status='verified', receipt_no=?, verified_at=? WHERE id=?", receipt, now(), p.id);
    this.notifyParentOf(p.student_id, 'Payment received', `${money(p.amount)} received. Receipt #${receipt}. Balance ${money(this.voucherTotal(v) - paid)}.`, `#/receipt/${p.id}`);
    this.notifyClassTeacher(p.class_id, 'Fee paid', `Receipt #${receipt}: ${money(p.amount)} for ${this.one('SELECT name FROM students WHERE id=?', p.student_id)!.name}.`);
    return receipt;
  }

  canVerify(a: Actor, p: Row) {
    if (this.canFeesAll(a) && this.inClassScope(a, p.class_id)) return true;
    return a.classTeacherOf.has(p.class_id) && this.setting('teacher_verify_slips') === '1' && p.method !== 'cash_teacher';
  }

  // ---------- daily automation ----------
  async runCron(ctx: Ctx) {
    const t = pkt();
    const paused = ctx.schoolStatus === 'paused';
    const hasRun = (k: string) => !!this.one('SELECT 1 FROM meta WHERE key=?', k);
    const markRun = (k: string) => this.run('INSERT OR IGNORE INTO meta VALUES (?,?)', k, now());
    const sys = this.loadActor({ ...ctx, refId: 'system' });
    const isHoliday = !!this.one('SELECT 1 FROM holidays WHERE date=?', t.date) || t.weekday === 0;

    if (!paused) {
      // Monthly vouchers on the voucher day.
      const voucherKey = 'vouchers:' + t.month;
      if (t.day >= (this.num('voucher_day') || 1) && !hasRun(voucherKey) && this.q('SELECT 1 FROM fee_plans LIMIT 1').length) {
        this.generateVouchers(sys, t.month);
        markRun(voucherKey);
      }

      // Attendance not submitted by the deadline.
      const attendanceKey = 'att-reminder:' + t.date;
      if (!isHoliday && t.hour >= (this.num('attendance_deadline_hour') || 10) && !hasRun(attendanceKey)) {
        const missing = this.q(`SELECT c.* FROM classes c WHERE c.active=1 AND NOT EXISTS
          (SELECT 1 FROM attendance_days d WHERE d.class_id=c.id AND d.date=? AND d.status='submitted')`, t.date);
        for (const c of missing) if (c.class_teacher_id) this.notify('s:' + c.class_teacher_id, 'Attendance not submitted', `${c.name}: please submit today's attendance.`, `#/attendance/${c.id}`);
        if (missing.length) this.notifyAdmins('Attendance pending', `${missing.length} class(es) have not submitted: ${missing.map((c) => c.name).join(', ')}`, { subrole: 'coordinator' });
        markRun(attendanceKey);
      }

      // Late fines and fee reminders (once a day at 9 AM or later).
      const feesKey = 'fees-daily:' + t.date;
      if (t.hour >= 9 && !hasRun(feesKey)) {
        const before = this.num('reminder_days_before') || 3;
        for (const v of this.q("SELECT * FROM vouchers WHERE status IN ('unpaid','partial')")) {
          const late = Math.round((Date.parse(t.date) - Date.parse(v.due_date)) / 864e5);
          const fine = this.autoFine(v, t.date);
          if (fine !== v.fine) { this.run('UPDATE vouchers SET fine=? WHERE id=?', fine, v.id); v.fine = fine; }
          if (this.one('SELECT 1 FROM reminder_pauses WHERE student_id=?', v.student_id)) continue;
          const remind = late === -before || late === 0 || (late > 0 && late % 7 === 0);
          if (remind) {
            const bal = this.voucherBalance(v);
            this.notifyParentOf(v.student_id, late < 0 ? 'Fee due soon' : late === 0 ? 'Fee due today' : 'Fee overdue', `${money(bal)} for ${v.month} (due ${v.due_date}).`, `#/student/${v.student_id}`);
            this.run('UPDATE vouchers SET last_reminder=? WHERE id=?', now(), v.id);
          }
        }
        // Cash held too long.
        const days = this.num('cash_alert_days') || 3;
        const old = this.q(`SELECT held_by, SUM(amount) AS amt, MIN(created_at) AS since FROM payments WHERE method='cash_teacher' AND handover_id IS NULL
          AND status IN ('submitted','verified') GROUP BY held_by HAVING MIN(created_at) < ?`, new Date(Date.now() - days * 864e5).toISOString());
        for (const r of old) {
          const s = this.one('SELECT name FROM staff WHERE id=?', String(r.held_by).slice(2));
          this.notifyAdmins('Cash held too long', `${s?.name || 'A teacher'} has held ${money(r.amt)} since ${String(r.since).slice(0, 10)}.`, { subrole: 'accountant', link: '#/cash' });
        }
        markRun(feesKey);
      }

      // End-of-day summary for the main admin.
      const summaryKey = 'summary:' + t.date;
      if (t.hour >= 18 && !hasRun(summaryKey)) {
        const d = this.dashboard(sys);
        this.notifyAdmins('Daily summary', `Attendance ${d.attendance.percent}% (${d.attendance.submitted}/${d.attendance.classes} classes). Collected today ${money(d.fees.collectedToday)}. Slips waiting ${d.fees.slipsWaiting}. Cash with teachers ${money(d.fees.cashWithTeachers)}.`, { mainOnly: true, link: '#/' });
        markRun(summaryKey);
      }
    }

    // Clean abandoned upload reservations and recycle-bin objects only after R2 confirms deletion.
    const staleReservation = new Date(Date.now() - 60 * 60e3).toISOString();
    for (const r of this.q('SELECT id, key FROM file_upload_reservations WHERE created_at<?', staleReservation)) {
      try {
        await this.env.FILES.delete(r.key);
        this.run('DELETE FROM file_upload_reservations WHERE id=?', r.id);
      } catch (e) { console.error('R2 reservation cleanup failed', r.key, e); }
    }
    // Recycle bin: retain quota until physical R2 deletion succeeds after 30 days.
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
    for (const f of this.q('SELECT key FROM files WHERE deleted_at IS NOT NULL AND deleted_at<?', cutoff)) {
      try {
        await this.env.FILES.delete(f.key);
        this.run('DELETE FROM files WHERE key=? AND deleted_at IS NOT NULL', f.key);
      } catch (e) { console.error('R2 recycle-bin purge failed', f.key, e); }
    }
    this.run('DELETE FROM notifications WHERE created_at<?', new Date(Date.now() - 180 * 864e5).toISOString());
    // Keep one year of successful receipts for administration history and safe network retries.
    this.run("DELETE FROM api_submissions WHERE created_at<? AND status='saved'", new Date(Date.now() - 365 * 864e5).toISOString());

    return { students: Number(this.one("SELECT COUNT(*) AS n FROM students WHERE status!='left'")!.n), storage_bytes: this.storageUsed() };
  }

  dashboard(a: Actor) {
    const t = pkt();
    const allClasses = this.q('SELECT id, name, class_teacher_id FROM classes WHERE active=1 ORDER BY grade, name');
    const allowed = this.isFullAdmin(a) ? null : new Set(this.scopedClassIds(a));
    const classes = allowed ? allClasses.filter((c) => allowed.has(c.id)) : allClasses;
    const classIds = classes.map((c) => c.id);
    const inScope = (row: Row) => !allowed || allowed.has(row.class_id);
    const days = new Map(this.q('SELECT class_id, status FROM attendance_days WHERE date=?', t.date).filter(inScope).map((r) => [r.class_id, r.status]));
    const counts = this.q('SELECT class_id, status, COUNT(*) AS n FROM attendance_records WHERE date=? GROUP BY class_id, status', t.date).filter(inScope);
    const perClass = classes.map((c) => {
      const cs = counts.filter((x) => x.class_id === c.id);
      const total = cs.reduce((s, x) => s + x.n, 0), present = cs.filter((x) => x.status === 'P' || x.status === 'L').reduce((s, x) => s + x.n, 0);
      return { id: c.id, name: c.name, status: days.get(c.id) || 'not started', present, total };
    });
    const sub = perClass.filter((c) => c.status === 'submitted');
    const tot = sub.reduce((s, c) => s + c.total, 0), pres = sub.reduce((s, c) => s + c.present, 0);
    const startUtc = new Date(Date.parse(t.date + 'T00:00:00Z') - 5 * 3600e3).toISOString();
    const paymentsToday = this.q("SELECT class_id, amount FROM payments WHERE status='verified' AND verified_at>=?", startUtc).filter(inScope);
    const slipsWaiting = this.q("SELECT class_id FROM payments WHERE status='submitted' AND method!='cash_teacher'").filter(inScope).length;
    const cashRows = this.q("SELECT class_id, amount FROM payments WHERE method='cash_teacher' AND handover_id IS NULL AND status IN ('submitted','verified')").filter(inScope);
    const lateVouchers = this.q("SELECT DISTINCT s.id,s.class_id FROM vouchers v JOIN students s ON s.id=v.student_id WHERE v.status IN ('unpaid','partial') AND v.due_date<?", t.date).filter(inScope);
    const students = this.q("SELECT class_id,status,COUNT(*) AS n FROM students WHERE status IN ('active','pending') GROUP BY class_id").filter(inScope);
    const activeStudents = students.filter((r) => r.status === 'active').reduce((n, r) => n + r.n, 0);
    const pendingStudents = students.filter((r) => r.status === 'pending').reduce((n, r) => n + r.n, 0);
    const changeRequests = this.hasPermission(a, 'attendance.manage') || this.hasPermission(a, 'students.manage')
      ? this.q("SELECT * FROM change_requests WHERE status='open'").filter((r) => {
          const detail = (() => { try { return JSON.parse(r.detail); } catch { return {}; } })();
          const sid = detail.student_id || (r.kind === 'student' ? r.ref : null);
          if (!sid) return this.isFullAdmin(a);
          const student = this.one('SELECT class_id FROM students WHERE id=?', sid);
          return !!student && (!allowed || allowed.has(student.class_id));
        }).length
      : 0;
    return {
      date: t.date,
      attendance: { classes: classes.length, submitted: sub.length, percent: tot ? Math.round((pres / tot) * 100) : 0, perClass, notSubmitted: perClass.filter((c) => c.status !== 'submitted').map((c) => c.name) },
      fees: {
        collectedToday: paymentsToday.reduce((n, p) => n + p.amount, 0),
        slipsWaiting,
        cashWithTeachers: cashRows.reduce((n, p) => n + p.amount, 0),
        defaulters: lateVouchers.length,
      },
      students: { active: activeStudents, pending: pendingStudents },
      changeRequests,
      notices: this.noticesFor(a).slice(0, 5).map((n) => ({ id: n.id, title: n.title, poster_name: n.poster_name, created_at: n.created_at })),
    };
  }

  // ---------- routes ----------
  routes() {
    const app = new Hono<{ Variables: { actor: Actor; ctx: Ctx } }>();
    app.onError((err, c) => {
      if (err instanceof HttpError) return c.json({ error: err.message }, err.status as any);
      console.error(err);
      return c.json({ error: String((err as any)?.message || 'Something went wrong') }, 500);
    });

    // Internal calls from the Worker (never reachable from the browser: the Worker blocks /internal).
    app.post('/internal/init', async (c) => {
      const ctx = JSON.parse(c.req.header('x-ctx')!) as Ctx;
      const b = await c.req.json<any>();
      if (this.one("SELECT 1 FROM meta WHERE key='school_id'")) fail(409, 'Already initialised');
      this.run("INSERT INTO meta VALUES ('school_id', ?)", ctx.schoolId);
      this.run("INSERT INTO meta VALUES ('school_name', ?)", b.name);
      const id = 'tch_' + rid(12);
      this.run("INSERT INTO staff (id, public_id, name, email, phone, role, is_main, search_key, created_at) VALUES (?, lower(hex(randomblob(16))), ?, ?, ?, 'admin', 1, ?, ?)",
        id, b.admin.name, normId(b.admin.email), normId(b.admin.phone) || null, skeleton(b.admin.name), now());
      for (const h of ['Tuition', 'Admission', 'Exam', 'Transport']) this.run('INSERT INTO fee_heads VALUES (?,?,?)', 'fh_' + rid(8), h, h === 'Tuition' || h === 'Transport' ? 1 : 0);
      this.currentSession();
      await this.syncLogin('staff', id, [b.admin.email, b.admin.phone]);
      return c.json({ ok: true, id });
    });
    app.post('/internal/main-admin', (c) => c.json(this.one('SELECT id, name, public_id AS userId FROM staff WHERE is_main=1 LIMIT 1')));
    app.post('/internal/notify-admins', async (c) => {
      const b = await c.req.json<any>();
      if (b.once) { if (this.one('SELECT 1 FROM meta WHERE key=?', 'n:' + b.once)) return c.json({ ok: true }); this.run('INSERT INTO meta VALUES (?,?)', 'n:' + b.once, now()); }
      this.notifyAdmins(b.title, b.body, { mainOnly: b.mainOnly, link: '#/billing' });
      return c.json({ ok: true });
    });
    app.post('/internal/cron', async (c) => c.json(await this.runCron(JSON.parse(c.req.header('x-ctx')!))));

    // Resolve the actor, then use a stable client submission ID to make network retries safe.
    app.use('*', async (c, next) => {
      const ctx = JSON.parse(c.req.header('x-ctx') || 'null') as Ctx;
      if (!ctx) fail(401, 'Unauthorised');
      c.set('ctx', ctx);
      const actor = this.loadActor(ctx);
      c.set('actor', actor);
      const expectedActor = c.req.header('x-expected-actor');
      if (expectedActor && expectedActor !== actor.key) fail(409, 'This saved form belongs to a different signed-in account. Sign in with the original account to synchronize it.');
      if (!['GET', 'HEAD'].includes(c.req.method) && !c.req.path.startsWith('/notifications') && !c.req.path.endsWith('/read')) this.writable(ctx);

      const submissionId = c.req.header('x-submission-id');
      const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
      if (!submissionId || !isWrite) { await next(); return; }
      if (!/^[A-Za-z0-9_-]{12,100}$/.test(submissionId)) fail(400, 'Invalid submission reference');
      const path = c.req.path;
      const method = c.req.method.toUpperCase();
      const contentType = c.req.header('content-type') || 'application/json';
      let requestHash: string | null = null;
      if (contentType.includes('application/json')) {
        const raw = await c.req.raw.clone().text();
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(method + '|' + path + '|' + raw));
        requestHash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
      }
      const existing = this.one('SELECT * FROM api_submissions WHERE id=?', submissionId);
      if (existing) {
        if (existing.user_key !== actor.key || existing.method !== method || existing.path !== path ||
            (existing.request_hash && requestHash && existing.request_hash !== requestHash)) {
          fail(409, 'This submission reference belongs to a different request. Reopen the form and submit it again.');
        }
        if (existing.status === 'saved') {
          return new Response(existing.response_body || '{}', {
            status: Number(existing.http_status) || 200,
            headers: { 'content-type': existing.content_type || 'application/json', 'cache-control': 'no-store', 'x-submission-replayed': '1' },
          });
        }
        const processingAge = Date.now() - Date.parse(String(existing.updated_at || existing.created_at || ''));
        if (Number.isFinite(processingAge) && processingAge < 120000) {
          fail(409, 'This submission is still being processed. Retry the same submission reference shortly.');
        }
        // Recover a request whose worker stopped before writing its final receipt.
        this.run("DELETE FROM api_submissions WHERE id=? AND user_key=? AND status='processing'", submissionId, actor.key);
      }
      const label = String(c.req.header('x-submission-label') || (method + ' ' + path))
        .replace(/[\\r\\n\\t]/g, ' ').trim().slice(0, 120);
      const created = now();
      this.run(`INSERT INTO api_submissions (id,user_key,user_name,method,path,label,request_hash,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'processing',?,?)`, submissionId, actor.key, actor.name, method, path, label, requestHash, created, created);
      try { await next(); }
      catch (error) {
        this.run("DELETE FROM api_submissions WHERE id=? AND user_key=? AND status='processing'", submissionId, actor.key);
        throw error;
      }
      const response = c.res.clone();
      const body = await response.text();
      if (response.status >= 200 && response.status < 300) {
        this.run(`UPDATE api_submissions SET status='saved',http_status=?,content_type=?,response_body=?,updated_at=?
          WHERE id=? AND user_key=?`, response.status, response.headers.get('content-type') || 'application/json', body, now(), submissionId, actor.key);
      } else {
        this.run('DELETE FROM api_submissions WHERE id=? AND user_key=?', submissionId, actor.key);
      }
    });

    app.get('/me', (c) => {
      const a = c.get('actor');
      const classes = this.q('SELECT id, name FROM classes WHERE active=1 ORDER BY grade, name').filter((x) =>
        this.isFullAdmin(a) || (a.role === 'subadmin' && this.inClassScope(a, x.id) && ['students.view','students.manage','fees.manage','attendance.manage','classes.view'].some((p) => this.hasPermission(a, p))) || a.teaches.has(x.id));
      const children = a.type === 'guardian' ? this.q("SELECT s.id, s.name, s.reg_no, c.name AS class_name FROM students s JOIN classes c ON c.id=s.class_id WHERE s.guardian_id=? AND s.status='active'", a.id) : [];
      const settings: Row = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) settings[k] = this.setting(k);
      return c.json({ id: a.id, userId: a.publicId || null, kind: a.type, name: a.name, role: a.role, subrole: a.subrole, isMainAdmin: a.isMain, isAdmin: this.isAdmin(a), isFullAdmin: this.isFullAdmin(a),
        permissions: [...a.permissions], scopeAll: a.scopeAll, scopeClasses: [...a.scopeClasses],
        canFees: this.canFeesAll(a), canManageStudents: this.canManageStudents(a), canViewStudents: this.isFullAdmin(a) || this.hasPermission(a, 'students.view') || this.canManageStudents(a) || this.canFeesAll(a) || this.hasPermission(a, 'attendance.manage'),
        canManageAttendance: this.isFullAdmin(a) || this.hasPermission(a, 'attendance.manage'), canManageNotices: this.isFullAdmin(a) || this.hasPermission(a, 'notices.manage'),
        canDecideRequests: this.isFullAdmin(a) || this.hasPermission(a, 'attendance.manage') || this.canManageStudents(a),
        canViewStaff: this.isFullAdmin(a) || this.hasPermission(a, 'staff.view'),
        schoolName: this.one("SELECT value FROM meta WHERE key='school_name'")?.value, classes, classTeacherOf: [...a.classTeacherOf], teaches: [...a.teaches], children, settings,
        unread: Number(this.one('SELECT COUNT(*) AS n FROM notifications WHERE user_key=? AND read_at IS NULL', a.key)!.n),
        outbox: this.isFullAdmin(a) || a.subrole === 'office' ? Number(this.one("SELECT COUNT(*) AS n FROM phone_outbox WHERE status='pending'")!.n) : 0 });
    });

    app.get('/dashboard', (c) => { const a = c.get('actor'); if (!this.isFullAdmin(a)) this.requirePermission(a, 'dashboard.view'); return c.json(this.dashboard(a)); });

    // ----- settings -----
    app.get('/settings', (c) => {
      const s: Row = {}; for (const k of Object.keys(DEFAULT_SETTINGS)) s[k] = this.setting(k);
      return c.json({ settings: s, schoolName: this.one("SELECT value FROM meta WHERE key='school_name'")?.value });
    });
    app.post('/settings', async (c) => {
      const a = c.get('actor'); this.requireMain(a);
      const b = await c.req.json<any>();
      for (const [k, v] of Object.entries(b.settings || {})) if (k in DEFAULT_SETTINGS && k !== 'payment_accounts') this.run('INSERT OR REPLACE INTO settings VALUES (?,?)', k, String(v));
      if (b.schoolName) this.run("INSERT OR REPLACE INTO meta VALUES ('school_name', ?)", b.schoolName);
      this.audit(a, 'settings.update', null, null, b);
      return c.json({ ok: true });
    });

    // ----- staff -----
    app.get('/staff', (c) => {
      const a = c.get('actor');
      if (a.type === 'guardian') fail(403, 'No access');
      const active = c.req.query('active') !== '0' ? 1 : 0;
      if (!this.isFullAdmin(a) && !this.hasPermission(a, 'staff.view') && !this.hasPermission(a, 'attendance.manage')) fail(403, 'Staff directory access has not been granted to this account');
      const cols = this.isFullAdmin(a) ? '*' : 'id, name, role, subjects, active';
      const rows = this.q(`SELECT ${cols} FROM staff WHERE active=? ORDER BY is_main DESC, role, name`, active);
      return c.json(rows.map((r) => ({ ...r, classes: this.q('SELECT name FROM classes WHERE class_teacher_id=? AND active=1', r.id).map((x) => x.name), subject_classes: this.q('SELECT DISTINCT c.name, cs.subject FROM class_subject_teacher_assignments a JOIN class_subjects cs ON cs.id=a.class_subject_id JOIN classes c ON c.id=cs.class_id WHERE a.teacher_id=? AND a.from_date<=? AND (a.to_date IS NULL OR a.to_date>=?)', r.id, pkt().date, pkt().date) })));
    });
    app.post('/staff', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the new staff account and confirm before creating it');
      if (!b.name || !b.email) fail(400, 'Name and a Google sign-in email are required');
      const role = ['teacher', 'subadmin', 'admin'].includes(b.role) ? b.role : 'teacher';
      if (role !== 'teacher') this.requireMain(a);
      const email = normId(b.email), phone = normId(b.phone) || null;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid Google sign-in email');
      if (this.one('SELECT 1 FROM staff WHERE email=? AND active=1', email) || (phone && this.one('SELECT 1 FROM staff WHERE phone=? AND active=1', phone))) fail(409, 'A staff member with this email or phone already exists');
      const allowedPermissions = new Set(['dashboard.view','staff.view','students.view','students.manage','fees.manage','attendance.manage','classes.view','notices.manage','results.manage']);
      let permissionsJson: string | null = null, scopeRaw: string | null = null;
      if (role === 'subadmin') {
        const requestedPermissions: string[] = Array.isArray(b.permissions)
          ? b.permissions.filter((p: unknown): p is string => typeof p === 'string')
          : [];
        const permissions = [...new Set<string>(requestedPermissions)];
        if (!permissions.length || permissions.some((p) => !allowedPermissions.has(p))) fail(400, 'Choose at least one valid Mini Admin permission');
        if (permissions.some((p) => ['fees.manage','attendance.manage'].includes(p)) && !permissions.includes('students.view')) permissions.push('students.view');
        const scopeAll = b.scope_all !== false;
        const scopeIds = [...new Set(Array.isArray(b.scope_classes) ? b.scope_classes.map(String) : [])];
        if (!scopeAll && (!scopeIds.length || scopeIds.some((cid) => !this.one('SELECT 1 FROM classes WHERE id=? AND active=1', cid)))) fail(400, 'Choose one or more active classes for this Mini Admin');
        permissionsJson = JSON.stringify(permissions);
        scopeRaw = scopeAll ? '*' : JSON.stringify(scopeIds);
      }
      const id = 'tch_' + rid(12);
      this.run('INSERT INTO staff (id, public_id, name, email, phone, role, subrole, subjects, permissions, scope_classes, search_key, created_at) VALUES (?, lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, b.name.trim(), email, phone, role, role === 'subadmin' ? b.subrole || 'office' : null, b.subjects || null, permissionsJson, scopeRaw, skeleton(b.name), now());
      await this.syncLogin('staff', id, [email]);
      this.audit(a, 'staff.add', 'staff', id, { name: b.name, role });
      return c.json(this.one('SELECT * FROM staff WHERE id=?', id));
    });
    app.get('/staff/:id', (c) => {
      const a = c.get('actor');
      const id = c.req.param('id');
      if (!this.isFullAdmin(a) && a.id !== id && !this.hasPermission(a, 'staff.view')) fail(403, 'You can only view your own profile unless staff directory access is granted');
      const s = this.one('SELECT * FROM staff WHERE id=?', id);
      if (!s) fail(404, 'Not found');
      return c.json({
        staff: s,
        classTeacherOf: this.q('SELECT id, name FROM classes WHERE class_teacher_id=? AND active=1 ORDER BY grade,name', id),
        subjects: this.q('SELECT DISTINCT cs.id,cs.subject,c.name AS class_name,c.id AS class_id FROM class_subject_teacher_assignments a JOIN class_subjects cs ON cs.id=a.class_subject_id JOIN classes c ON c.id=cs.class_id WHERE a.teacher_id=? AND a.from_date<=? AND (a.to_date IS NULL OR a.to_date>=?) ORDER BY c.grade,c.name,cs.subject', id, pkt().date, pkt().date),
        submissions: this.q('SELECT d.date, c.name AS class_name, d.submitted_at FROM attendance_days d JOIN classes c ON c.id=d.class_id WHERE d.submitted_by=? ORDER BY d.date DESC LIMIT 30', 's:' + id),
        notices: this.q('SELECT id, title, created_at FROM notices WHERE posted_by=? ORDER BY created_at DESC LIMIT 20', 's:' + id),
        cashHeld: this.q("SELECT p.id, p.amount, p.created_at, s.name AS student_name FROM payments p JOIN students s ON s.id=p.student_id WHERE p.held_by=? AND p.handover_id IS NULL AND p.status IN ('submitted','verified')", 's:' + id),
        history: this.isFullAdmin(a) ? this.q("SELECT * FROM audit_log WHERE entity='staff' AND entity_id=? ORDER BY created_at DESC LIMIT 50", id) : [],
      });
    });
    app.patch('/staff/:id', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const id = c.req.param('id');
      const s = this.one('SELECT * FROM staff WHERE id=?', id); if (!s) fail(404, 'Not found');
      if (s!.is_main && !a.isMain) fail(403, 'Only the main admin can edit the main admin');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the staff account changes and confirm before saving');
      const changes: Row = {};
      for (const k of ['name', 'email', 'phone', 'subjects', 'role', 'subrole']) if (k in b) {
        let v = b[k];
        if (k === 'email') {
          v = normId(v || '');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail(400, 'A valid Google sign-in email is required');
          const duplicate = this.one('SELECT id FROM staff WHERE email=? AND id<>? AND active=1 LIMIT 1', v, id);
          if (duplicate) fail(409, 'That Google sign-in email is already assigned to another active staff account.');
        }
        if (k === 'phone') v = normId(v) || null;
        if ((k === 'role' || k === 'subrole') && !a.isMain) continue;
        if (s![k] !== v) { changes[k] = { old: s![k], new: v }; this.run(`UPDATE staff SET ${k}=? WHERE id=?`, v, id); }
      }
      let accessChanged = false;
      if (a.isMain && (['permissions', 'scope_classes', 'scope_all'].some((k) => k in b) || changes.role)) {
        const current = this.one('SELECT * FROM staff WHERE id=?', id)!;
        const nextRole = String(current.role || 'teacher');
        if (nextRole === 'subadmin') {
          const allowedPermissions = new Set(['dashboard.view','staff.view','students.view','students.manage','fees.manage','attendance.manage','classes.view','notices.manage','results.manage']);
          let permissions: string[] = [];
          if (Array.isArray(b.permissions)) permissions = [...new Set<string>(b.permissions.filter((p: unknown): p is string => typeof p === 'string'))];
          else if (current.permissions) { try { const parsed = JSON.parse(current.permissions); if (Array.isArray(parsed)) permissions = parsed; } catch {} }
          else permissions = current.subrole === 'accountant' ? ['students.view','fees.manage','classes.view','dashboard.view']
            : current.subrole === 'coordinator' ? ['students.view','attendance.manage','classes.view','notices.manage','dashboard.view']
            : ['students.view','students.manage','fees.manage','classes.view','attendance.manage','notices.manage','dashboard.view'];
          if (!permissions.length || permissions.some((p) => !allowedPermissions.has(p))) fail(400, 'Choose at least one valid Mini Admin permission');
          if (permissions.some((p) => ['fees.manage','attendance.manage'].includes(p)) && !permissions.includes('students.view')) permissions.push('students.view');
          const previousScope: string[] = (() => { try { const v = JSON.parse(current.scope_classes || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })();
          const scopeAll = b.scope_all !== undefined ? !!b.scope_all : ('scope_classes' in b ? false : (!current.scope_classes || current.scope_classes === '*'));
          const scopeIds = [...new Set(Array.isArray(b.scope_classes) ? b.scope_classes.map(String) : previousScope)];
          if (!scopeAll && (!scopeIds.length || scopeIds.some((cid) => !this.one('SELECT 1 FROM classes WHERE id=? AND active=1', cid)))) fail(400, 'Choose one or more active classes for this Mini Admin');
          const permissionValue = JSON.stringify(permissions), scopeValue = scopeAll ? '*' : JSON.stringify(scopeIds);
          if (current.permissions !== permissionValue || current.scope_classes !== scopeValue) {
            this.run('UPDATE staff SET permissions=?, scope_classes=? WHERE id=?', permissionValue, scopeValue, id);
            changes.permissions = { old: current.permissions, new: permissionValue };
            changes.scope_classes = { old: current.scope_classes, new: scopeValue };
            accessChanged = true;
          }
        } else if (current.permissions || current.scope_classes) {
          this.run('UPDATE staff SET permissions=NULL, scope_classes=NULL WHERE id=?', id);
          changes.permissions = { old: current.permissions, new: null };
          changes.scope_classes = { old: current.scope_classes, new: null };
          accessChanged = true;
        }
      }
      if (changes.name) this.run('UPDATE staff SET search_key=? WHERE id=?', skeleton(b.name), id);
      const n = this.one('SELECT * FROM staff WHERE id=?', id)!;
      if (changes.email || changes.phone || changes.role || accessChanged) await this.syncLogin('staff', id, [n.email, n.phone], true);
      this.audit(a, 'staff.edit', 'staff', id, changes);
      return c.json(n);
    });
    app.post('/staff/:id/deactivate', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const id = c.req.param('id');
      const b = await c.req.json<any>();
      const s = this.one('SELECT * FROM staff WHERE id=?', id); if (!s) fail(404, 'Not found');
      if (s!.is_main) fail(400, 'The main admin cannot be deactivated');
      if (s!.role === 'admin' && !a.isMain) fail(403, 'Only the main admin can deactivate another full administrator');
      const cash = Number(this.one("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE held_by=? AND handover_id IS NULL AND status IN ('submitted','verified')", 's:' + id)!.n);
      if (cash > 0 && !b.confirm_cash) return c.json({ needsConfirm: true, message: `${s!.name} still holds ${money(cash)} in cash. Settle it first, or confirm to continue.` }, 409);
      if (b.confirm !== true) fail(400, 'Confirm this account deactivation before continuing');
      this.run('UPDATE staff SET active=0, left_at=?, left_reason=? WHERE id=?', b.date || pkt().date, b.reason || null, id);
      await this.syncLogin('staff', id, [], true);
      this.audit(a, 'staff.deactivate', 'staff', id, { reason: b.reason, cash });
      return c.json({ ok: true });
    });
    app.post('/staff/:id/reactivate', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm this staff account reactivation before continuing');
      const id = c.req.param('id');
      const s = this.one('SELECT * FROM staff WHERE id=?', id);
      if (!s) return fail(404, 'Staff account not found');
      if (s.active) fail(409, 'This staff account is already active');
      if (s.is_main || (s.role === 'admin' && !a.isMain)) fail(403, 'Only the main admin can reactivate a full administrator account');
      this.run('UPDATE staff SET active=1, left_at=NULL, left_reason=NULL WHERE id=? AND active=0', id);
      await this.syncLogin('staff', id, [s.email, s.phone]);
      this.audit(a, 'staff.reactivate', 'staff', id);
      return c.json({ ok: true });
    });

    // Replace a teacher with a genuinely new profile. Historical attendance,
    // messages, audit entries and cash receipts remain attached to the former ID.
    app.post('/staff/:id/replace', async (c) => {
      const a = c.get('actor'); this.requireMain(a);
      const oldId = c.req.param('id');
      const old = this.one("SELECT * FROM staff WHERE id=? AND role='teacher' AND active=1", oldId);
      if (!old) return fail(404, 'Active teacher not found');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the replacement teacher details and confirm the handover');
      const name = String(b.name || '').trim();
      const email = normId(b.email || '');
      const phone = normId(b.phone || '') || null;
      const effective = String(b.from_date || pkt().date);
      if (!name || !email) fail(400, 'The replacement teacher name and Google email are required');
      if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) fail(400, 'Enter a valid Google sign-in email');
      if (email === normId(old.email)) fail(400, 'A replacement teacher must use their own Google account email');
      if (this.one('SELECT 1 FROM staff WHERE email=? AND active=1', email)) fail(409, 'This Google email already belongs to an active staff account');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effective) || effective !== pkt().date) fail(400, 'Teacher replacement takes effect today. Future-dated handovers are not activated automatically yet.');
      const cash = Number(this.one("SELECT COALESCE(SUM(amount),0) AS n FROM payments WHERE held_by=? AND method='cash_teacher' AND handover_id IS NULL AND status IN ('submitted','verified')", 's:' + oldId)?.n || 0);
      if (cash > 0 && !b.confirm_cash) return c.json({ needsConfirm: true, message: `${old.name} still holds ${money(cash)} in cash. Confirm the cash handover or settle it before replacement.` }, 409);
      const classIds: string[] = [...new Set<string>((Array.isArray(b.transfer_class_ids) ? b.transfer_class_ids : []).map((id: unknown): string => String(id)))];
      const subjectIds: string[] = [...new Set<string>((Array.isArray(b.transfer_subject_ids) ? b.transfer_subject_ids : []).map((id: unknown): string => String(id)))];
      const validClasses = new Set(this.q('SELECT id FROM classes WHERE class_teacher_id=? AND active=1', oldId).map((r) => r.id));
      const validSubjects = new Set(this.q('SELECT DISTINCT cs.id FROM class_subject_teacher_assignments a JOIN class_subjects cs ON cs.id=a.class_subject_id WHERE a.teacher_id=? AND a.from_date<=? AND (a.to_date IS NULL OR a.to_date>=?)', oldId, effective, effective).map((r) => r.id));
      if (classIds.some((id) => !validClasses.has(id)) || subjectIds.some((id) => !validSubjects.has(id))) fail(400, 'One or more selected teaching assignments no longer belong to this teacher. Refresh and review again.');
      const newId = this.replaceTeacherProfile(a, old, { name, email, phone, subjects: b.subjects || null }, effective, {
        classIds, subjectIds,
      });
      await this.syncLogin('staff', oldId, [], true);
      await this.syncLogin('staff', newId, [email]);
      this.audit(a, 'staff.replace', 'staff', oldId, { replacement_id: newId, effective, cash, transfer_class_ids: classIds, transfer_subject_ids: subjectIds });
      return c.json({ ok: true, old_id: oldId, new_id: newId, old_name: old.name, new_name: name, cash });
    });

    // ----- classes -----
    app.get('/classes', (c) => {
      const a = c.get('actor');
      if (a.type === 'guardian') fail(403, 'No access');
      const rows = this.q(`SELECT c.*, t.name AS class_teacher_name, (SELECT COUNT(*) FROM students s WHERE s.class_id=c.id AND s.status='active') AS students
        FROM classes c LEFT JOIN staff t ON t.id=c.class_teacher_id WHERE c.active=1 ORDER BY c.grade, c.name`);
      return c.json(rows.filter((r) => this.isFullAdmin(a) || (a.role === 'subadmin' && this.inClassScope(a, r.id) && ['classes.view','students.view','students.manage','fees.manage','attendance.manage'].some((p) => this.hasPermission(a, p))) || a.teaches.has(r.id)).map((r) => ({
        ...r,
        subjects: this.q('SELECT id, subject, teacher_id FROM class_subjects WHERE class_id=? ORDER BY subject', r.id).map((subject) => {
          const assignments = this.q(`SELECT a.id AS assignment_id, a.teacher_id, t.name AS teacher_name, a.from_date, a.to_date
            FROM class_subject_teacher_assignments a JOIN staff t ON t.id=a.teacher_id
            WHERE a.class_subject_id=? ORDER BY a.from_date DESC`, subject.id);
          const current = assignments.find((assignment) => assignment.from_date <= pkt().date && (!assignment.to_date || assignment.to_date >= pkt().date));
          return { ...subject, teacher_name: current?.teacher_name || null, teachers: assignments };
        })
      })));
    });
    app.post('/classes', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) fail(400, 'Class name is required');
      if (this.one('SELECT 1 FROM classes WHERE lower(name)=lower(?) AND active=1', name)) fail(409, 'An active class already has this name');
      const teacherId = String(b.class_teacher_id || '') || null;
      if (teacherId && !this.one("SELECT id FROM staff WHERE id=? AND active=1 AND role IN ('teacher','subadmin','admin')", teacherId)) fail(400, 'Choose an active teacher account');
      const id = 'cl_' + rid(10);
      this.run('INSERT INTO classes (id, name, grade, section, room, class_teacher_id, created_at) VALUES (?,?,?,?,?,?,?)', id, name, Number(b.grade) || 0, b.section || null, b.room || null, teacherId, now());
      if (teacherId) this.run('INSERT INTO class_teacher_assignments VALUES (?,?,?,?,NULL)', rid(10), id, teacherId, pkt().date);
      this.audit(a, 'class.add', 'class', id, b);
      return c.json(this.one('SELECT * FROM classes WHERE id=?', id));
    });
    app.patch('/classes/:id', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const id = c.req.param('id'); const b = await c.req.json<any>();
      const cl = this.one('SELECT * FROM classes WHERE id=? AND active=1', id); if (!cl) fail(404, 'Active class not found');
      const nextName = 'name' in b ? String(b.name || '').trim() : cl!.name;
      if (!nextName) fail(400, 'Class name is required');
      if (this.one('SELECT 1 FROM classes WHERE lower(name)=lower(?) AND id<>? AND active=1', nextName, id)) fail(409, 'Another active class already has this name');
      const nameChanged = nextName !== cl!.name;
      const teacherChanged = 'class_teacher_id' in b && String(b.class_teacher_id || '') !== String(cl!.class_teacher_id || '');
      if ((nameChanged || teacherChanged) && b.confirm !== true) fail(400, 'Review the class rename or teacher reassignment and confirm before saving');
      if (teacherChanged && b.class_teacher_id) {
        const teacher = this.one("SELECT id FROM staff WHERE id=? AND active=1 AND role IN ('teacher','subadmin','admin')", b.class_teacher_id);
        if (!teacher) fail(400, 'Choose an active teacher account');
      }
      this.tx(() => {
        if (nameChanged) {
          this.run('UPDATE enrollments SET class_name_snapshot=? WHERE class_id=? AND class_name_snapshot IS NULL', cl!.name, id);
          this.run('UPDATE classes SET name=? WHERE id=?', nextName, id);
        }
        for (const k of ['grade', 'section', 'room']) if (k in b) this.run(`UPDATE classes SET ${k}=? WHERE id=?`, k === 'grade' ? Number(b[k]) || 0 : (b[k] || null), id);
      });
      if (teacherChanged) this.replaceTeacher(a, id, b.class_teacher_id || null, pkt().date);
      this.audit(a, nameChanged ? 'class.rename' : 'class.edit', 'class', id, { old_name:cl!.name, new_name:nextName, teacher_changed:teacherChanged, changes:b });
      return c.json(this.one('SELECT * FROM classes WHERE id=?', id));
    });
    app.post('/classes/:id/replace-teacher', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm the teacher handover before saving');
      this.replaceTeacher(a, c.req.param('id'), b.teacher_id, b.from_date || pkt().date, !!b.subjects_too);
      return c.json({ ok: true });
    });
    app.post('/classes/:id/subjects', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm this subject before adding it');
      const classId = c.req.param('id');
      if (!this.one('SELECT 1 FROM classes WHERE id=? AND active=1', classId)) fail(404, 'Active class not found');
      const subject = String(b.subject || '').trim().slice(0, 80);
      if (!subject) fail(400, 'Subject is required');
      if (this.one('SELECT 1 FROM class_subjects WHERE class_id=? AND lower(subject)=lower(?)', classId, subject)) fail(409, 'This subject is already assigned to the class');
      const subjectId = 'cs_' + rid(10);
      this.run('INSERT INTO class_subjects VALUES (?,?,?,NULL)', subjectId, classId, subject);
      const teacherIds = [...new Set([...(Array.isArray(b.teacher_ids) ? b.teacher_ids : []), ...(b.teacher_id ? [b.teacher_id] : [])].map((id) => String(id || '')).filter(Boolean))];
      for (const teacherId of teacherIds) {
        if (!this.one("SELECT id FROM staff WHERE id=? AND active=1 AND role IN ('teacher','subadmin','admin')", teacherId)) fail(400, 'Choose an active teacher account');
        const fromDate = String(b.from_date || pkt().date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !Number.isFinite(Date.parse(fromDate + 'T00:00:00Z'))) fail(400, 'Enter a valid teacher assignment start date');
        const assignmentId = 'csta_' + rid(10);
        this.run('INSERT INTO class_subject_teacher_assignments (id,class_subject_id,teacher_id,from_date,changed_by,created_at) VALUES (?,?,?,?,?,?)',
          assignmentId, subjectId, teacherId, fromDate, a.key, now());
        this.run('INSERT INTO class_subject_history (id,class_id,subject,teacher_id,from_date,changed_by) VALUES (?,?,?,?,?,?)',
          rid(10), classId, subject, teacherId, fromDate, a.key);
        if (!this.one('SELECT teacher_id FROM class_subjects WHERE id=? AND teacher_id IS NOT NULL', subjectId)) {
          this.run('UPDATE class_subjects SET teacher_id=? WHERE id=?', teacherId, subjectId);
        }
      }
      this.audit(a, 'class.subject.add', 'class', classId, { subject, teacher_ids: teacherIds });
      return c.json({ ok: true, id: subjectId, teacher_count: teacherIds.length });
    });
    app.post('/classes/:id/subjects/:sid/teachers', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm this teacher assignment before saving');
      const classId = c.req.param('id'), subjectId = c.req.param('sid');
      const subject = this.one('SELECT * FROM class_subjects WHERE id=? AND class_id=?', subjectId, classId);
      if (!subject) fail(404, 'Subject not found in this class');
      const teacherId = String(b.teacher_id || '');
      if (!teacherId || !this.one("SELECT id FROM staff WHERE id=? AND active=1 AND role IN ('teacher','subadmin','admin')", teacherId)) fail(400, 'Choose an active teacher account');
      const fromDate = String(b.from_date || pkt().date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !Number.isFinite(Date.parse(fromDate + 'T00:00:00Z'))) fail(400, 'Enter a valid teacher assignment start date');
      const overlap = this.one(`SELECT id FROM class_subject_teacher_assignments
        WHERE class_subject_id=? AND teacher_id=? AND from_date<=? AND (to_date IS NULL OR to_date>=?) LIMIT 1`,
        subjectId, teacherId, fromDate, fromDate);
      if (overlap) fail(409, 'This teacher already has an overlapping assignment for this subject');
      const assignmentId = 'csta_' + rid(10);
      this.run('INSERT INTO class_subject_teacher_assignments (id,class_subject_id,teacher_id,from_date,changed_by,created_at) VALUES (?,?,?,?,?,?)',
        assignmentId, subjectId, teacherId, fromDate, a.key, now());
      this.run('INSERT INTO class_subject_history (id,class_id,subject,teacher_id,from_date,changed_by) VALUES (?,?,?,?,?,?)',
        rid(10), classId, subject.subject, teacherId, fromDate, a.key);
      if (!subject.teacher_id) this.run('UPDATE class_subjects SET teacher_id=? WHERE id=?', teacherId, subjectId);
      this.audit(a, 'class.subject.teacher.add', 'class', classId, { subject_id: subjectId, subject: subject.subject, teacher_id: teacherId, from_date: fromDate });
      this.notify('s:' + teacherId, 'Subject assigned', 'You are assigned to teach ' + subject.subject + ' in ' + this.one('SELECT name FROM classes WHERE id=?', classId)?.name + ' from ' + fromDate + '.');
      return c.json({ ok: true, id: assignmentId });
    });
    app.post('/classes/:id/subjects/:sid/teachers/:aid/end', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm ending this subject teacher assignment');
      const classId = c.req.param('id'), subjectId = c.req.param('sid'), assignmentId = c.req.param('aid');
      const today = pkt().date;
      const assignment = this.one('SELECT * FROM class_subject_teacher_assignments WHERE id=? AND class_subject_id=? AND (to_date IS NULL OR to_date>=?)', assignmentId, subjectId, today);
      if (!assignment) fail(404, 'Active subject teacher assignment not found');
      const toDate = String(b.to_date || today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate) || !Number.isFinite(Date.parse(toDate + 'T00:00:00Z')) || toDate < assignment.from_date) fail(400, 'Choose a valid end date on or after the assignment start date');
      this.run('UPDATE class_subject_teacher_assignments SET to_date=? WHERE id=?', toDate, assignmentId);
      const subject = this.one('SELECT * FROM class_subjects WHERE id=? AND class_id=?', subjectId, classId);
      if (subject) {
        this.run('UPDATE class_subject_history SET to_date=? WHERE class_id=? AND subject=? AND teacher_id=? AND (to_date IS NULL OR to_date>=?)',
          toDate, classId, subject.subject, assignment.teacher_id, today);
        if (subject.teacher_id === assignment.teacher_id && toDate < today) {
          const next = this.one('SELECT teacher_id FROM class_subject_teacher_assignments WHERE class_subject_id=? AND from_date<=? AND (to_date IS NULL OR to_date>=?) ORDER BY from_date DESC LIMIT 1', subjectId, today, today);
          this.run('UPDATE class_subjects SET teacher_id=? WHERE id=?', next?.teacher_id || null, subjectId);
        }
      }
      this.audit(a, 'class.subject.teacher.end', 'class', classId, { subject_id: subjectId, teacher_id: assignment.teacher_id, to_date: toDate });
      return c.json({ ok: true });
    });
    app.delete('/classes/:id/subjects/:sid', (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      if (c.req.query('confirm') !== '1') fail(400, 'Confirm removal of this subject');
      const subjectId = c.req.param('sid'), classId = c.req.param('id');
      const subject = this.one('SELECT * FROM class_subjects WHERE id=? AND class_id=?', subjectId, classId);
      if (!subject) fail(404, 'Subject not found');
      const today = pkt().date;
      this.run('UPDATE class_subject_teacher_assignments SET to_date=? WHERE class_subject_id=? AND to_date IS NULL', today, subjectId);
      this.run('UPDATE class_subject_history SET to_date=? WHERE class_id=? AND subject=? AND to_date IS NULL', today, classId, subject.subject);
      this.run('DELETE FROM class_subjects WHERE id=? AND class_id=?', subjectId, classId);
      this.audit(a, 'class.subject.remove', 'class', classId, subjectId);
      return c.json({ ok: true });
    });
    app.get('/classes/:id', (c) => {
      const a = c.get('actor');
      const cl = this.classOf(a, c.req.param('id'));
      const feeAccess = (this.canFeesAll(a) && this.inClassScope(a, cl.id)) || a.classTeacherOf.has(cl.id);
      const students = this.q("SELECT id, reg_no, name, father_name, status FROM students WHERE class_id=? AND status IN ('active','pending') ORDER BY name", cl.id);
      const month = pkt().month;
      const fees = feeAccess ? this.q(`SELECT v.*, s.name AS student_name FROM vouchers v JOIN students s ON s.id=v.student_id WHERE v.class_id=? AND v.month=?`, cl.id, month)
        .map((v) => ({ id: v.id, student_name: v.student_name, total: this.voucherTotal(v), paid: v.paid, status: v.status })) : null;
      return c.json({
        class: { ...cl, class_teacher_name: this.one('SELECT name FROM staff WHERE id=?', cl.class_teacher_id)?.name },
        subjects: this.q('SELECT id, subject, teacher_id FROM class_subjects WHERE class_id=? ORDER BY subject', cl.id).map((subject) => {
          const assignments = this.q(`SELECT a.id AS assignment_id, a.teacher_id, t.name AS teacher_name, a.from_date, a.to_date
            FROM class_subject_teacher_assignments a JOIN staff t ON t.id=a.teacher_id
            WHERE a.class_subject_id=? ORDER BY a.from_date DESC`, subject.id);
          const current = assignments.filter((assignment) => assignment.from_date <= pkt().date && (!assignment.to_date || assignment.to_date >= pkt().date));
          return { ...subject, teacher_name: current[0]?.teacher_name || null, teachers: assignments };
        }),
        students, today: this.attendanceSheet(a, cl.id, pkt().date), fees,
        history: this.q('SELECT a.from_date, a.to_date, t.name FROM class_teacher_assignments a JOIN staff t ON t.id=a.teacher_id WHERE a.class_id=? ORDER BY a.from_date DESC', cl.id),
      });
    });

    // ----- students -----
    app.get('/students', (c) => {
      const a = c.get('actor');
      const [w, p] = this.studentScope(a, 's');
      const status = c.req.query('status') || 'active';
      const cls = c.req.query('class_id');
      let sql = `SELECT s.id, s.reg_no, s.name, s.father_name, s.class_id, c.name AS class_name, s.status, s.left_date, s.created_at,
        ${this.isFullAdmin(a) ? 's.parent_phone' : "'' AS parent_phone"} FROM students s JOIN classes c ON c.id=s.class_id WHERE ${w}`;
      const params: any[] = [...p];
      if (status !== 'all') { sql += ' AND s.status=?'; params.push(status); }
      if (cls) { sql += ' AND s.class_id=?'; params.push(cls); }
      if (c.req.query('added') === 'month') { sql += ' AND s.created_at>=?'; params.push(pkt().month + '-01'); }
      let rows = this.q(sql + ' ORDER BY c.grade, c.name, s.name LIMIT 5000', ...params);
      if (c.req.query('unpaid') === '1') {
        const unpaid = new Set(this.q("SELECT DISTINCT student_id FROM vouchers WHERE status IN ('unpaid','partial')").map((r) => r.student_id));
        rows = rows.filter((r) => unpaid.has(r.id));
      }
      const below = Number(c.req.query('below') || 0);
      if (below) {
        const m = pkt().month;
        const stats = new Map(this.q("SELECT student_id, SUM(status IN ('P','L')) AS p, COUNT(*) AS n FROM attendance_records WHERE date LIKE ? GROUP BY student_id", m + '%').map((r) => [r.student_id, r.n ? (100 * r.p) / r.n : 100]));
        rows = rows.filter((r) => (stats.get(r.id) ?? 100) < below);
      }
      return c.json(rows);
    });
    app.post('/students', async (c) => {
      const a = c.get('actor'); const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the student details and confirm before creating the profile');
      const warning = this.duplicateWarning(b);
      if (warning && !b.allow_duplicate) return c.json({ needsConfirm: true, message: warning }, 409);
      const s = this.createStudent(a, c.get('ctx'), b);
      if (s.status === 'active') await this.syncGuardian(s.guardian_id);
      return c.json(s);
    });
    app.post('/students/import', async (c) => {
      const a = c.get('actor'); if (!this.canManageStudents(a)) fail(403, 'Only admins can import');
      const { rows, confirm } = await c.req.json<any>();
      if (confirm !== true) fail(400, 'Review the import preview and confirm the batch');
      const classes = this.q('SELECT id, name FROM classes WHERE active=1');
      const byName = new Map(classes.map((x) => [String(x.name).toLowerCase().replace(/\s+/g, ''), x.id]));
      const out: any[] = []; const gids = new Set<string>();
      for (const [i, r] of (rows || []).entries()) {
        try {
          const class_id = r.class_id || byName.get(String(r.class || '').toLowerCase().replace(/\s+/g, ''));
          if (!class_id) throw new HttpError(400, `Unknown class "${r.class}"`);
          const s = this.createStudent(a, c.get('ctx'), { ...r, class_id });
          gids.add(s.guardian_id);
          out.push({ row: i + 1, ok: true, reg_no: s.reg_no });
        } catch (e: any) { out.push({ row: i + 1, ok: false, error: e.message }); }
      }
      for (const g of gids) await this.syncGuardian(g);
      return c.json({ results: out, added: out.filter((x) => x.ok).length });
    });
    app.get('/students/:id', (c) => {
      const a = c.get('actor');
      const s = this.student(a, c.req.param('id'));
      const feeAccess = (this.canFeesAll(a) && this.inClassScope(a, s.class_id)) || a.classTeacherOf.has(s.class_id) || a.type === 'guardian';
      const month = c.req.query('month') || pkt().month;
      const vouchers = feeAccess ? this.q('SELECT * FROM vouchers WHERE student_id=? ORDER BY month DESC', s.id).map((v): Row => ({ ...v, total: this.voucherTotal(v), balance: this.voucherBalance(v), lines: this.q('SELECT label, amount FROM voucher_lines WHERE voucher_id=?', v.id) })) : null;
      const showPhone = this.isFullAdmin(a) || a.type === 'guardian';
      const att = this.monthAttendance([s.id], month);
      const counted = att.length, present = att.filter((r) => r.status === 'P' || r.status === 'L').length;
      const fullAdmin = this.isFullAdmin(a);
      const hold = this.setting('result_fee_hold') === '1' && a.type === 'guardian' && (vouchers || []).some((v: Row) => v.balance > 0 && v.status !== 'carried');
      return c.json({
        student: { ...s, parent_phone: showPhone ? s.parent_phone : null, parent_email: showPhone ? s.parent_email : null, class_name: this.one('SELECT name FROM classes WHERE id=?', s.class_id)?.name },
        attendance: { month, records: att, percent: counted ? Math.round((100 * present) / counted) : null, holidays: this.q('SELECT date, name FROM holidays WHERE date LIKE ?', month + '%') },
        vouchers, payments: feeAccess ? this.q('SELECT id, voucher_id, method, amount, txn_id, status, reason, receipt_no, created_at, verified_at, slip_key FROM payments WHERE student_id=? ORDER BY created_at DESC', s.id) : null,
        discounts: feeAccess ? this.q('SELECT * FROM student_discounts WHERE student_id=?', s.id) : null,
        results: hold ? [] : this.q(`SELECT id, session, title, file_name, published_at, created_at FROM results WHERE student_id=? AND deleted_at IS NULL ${a.type === 'guardian' ? 'AND published_at IS NOT NULL' : ''} ORDER BY created_at DESC`, s.id),
        resultsHeld: hold,
        notices: this.noticesFor(a, s.id).slice(0, 20),
        classHistory: this.q('SELECT e.*, COALESCE(e.class_name_snapshot,c.name) AS class_name, ss.name AS session_name FROM enrollments e JOIN classes c ON c.id=e.class_id LEFT JOIN academic_sessions ss ON ss.id=e.session_id WHERE e.student_id=? ORDER BY e.from_date DESC', s.id),
        history: fullAdmin ? this.q("SELECT * FROM audit_log WHERE entity='student' AND entity_id=? ORDER BY created_at DESC LIMIT 100", s.id) : [],
        reminderPause: feeAccess ? this.one('SELECT * FROM reminder_pauses WHERE student_id=?', s.id) : null,
      });
    });
    app.patch('/students/:id', async (c) => {
      const a = c.get('actor');
      const s = this.student(a, c.req.param('id'), 'edit');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the student changes and confirm before saving');
      const changes: Row = {};
      if ('class_id' in b) fail(400, 'Use the dedicated Move to another class action so the old class history is preserved');
      for (const k of ['name', 'father_name', 'reg_no', 'parent_phone', 'parent_email', 'dob', 'gender', 'address', 'admission_date']) {
        if (!(k in b)) continue;
        let v = b[k] === '' ? null : b[k];
        if (k === 'parent_phone') {
          v = normId(v || '');
          if (v && !/^0\d{10}$/.test(v)) fail(400, 'Parent phone should look like 03001234567');
        }
        if (k === 'parent_email') {
          v = normId(v || '');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail(400, 'A valid parent email is required for Google sign-in');
        }
        if (k === 'reg_no' && v !== s.reg_no && this.one('SELECT 1 FROM students WHERE reg_no=?', v)) fail(409, 'Registration number already used');
        if (s[k] !== v) changes[k] = { old: s[k], new: v };
      }
      if (!Object.keys(changes).length) return c.json(s);
      const oldGid = s.guardian_id;
      this.tx(() => {
        for (const [k, ch] of Object.entries(changes)) this.run(`UPDATE students SET ${k}=? WHERE id=?`, (ch as any).new, s.id);
        if (changes.parent_email) {
          const n = this.one('SELECT * FROM students WHERE id=?', s.id)!;
          const duplicate = this.one('SELECT id FROM guardians WHERE email=? AND id<>? LIMIT 1', n.parent_email, n.guardian_id);
          if (duplicate) fail(409, 'This Google email is already attached to a different parent account. Ask the Main Admin to resolve the duplicate account before changing it.');
          // Update the existing guardian identity in place. This keeps the same
          // parent ID and all sibling links instead of silently creating a new account.
          this.run('UPDATE guardians SET email=?, name=?, phone=? WHERE id=?', n.parent_email, n.father_name, n.parent_phone || null, n.guardian_id);
          this.run('UPDATE students SET parent_email=? WHERE guardian_id=?', n.parent_email, n.guardian_id);
        } else if (changes.parent_phone) {
          const n = this.one('SELECT * FROM students WHERE id=?', s.id)!;
          this.run('UPDATE guardians SET phone=? WHERE id=?', n.parent_phone || null, n.guardian_id);
          this.run('UPDATE students SET parent_phone=? WHERE guardian_id=?', n.parent_phone || null, n.guardian_id);
        }
        this.run('UPDATE students SET search_key=? WHERE id=?', skeleton((b.name ?? s.name) + ' ' + (b.father_name ?? s.father_name)), s.id);
        this.audit(a, 'student.edit', 'student', s.id, { changes, reason: b.reason || null });
      });
      const n = this.one('SELECT * FROM students WHERE id=?', s.id)!;
      if (n.guardian_id !== oldGid) {
        await this.syncLogin('guardian', oldGid, [], true);
        await this.syncGuardian(n.guardian_id);
      } else if (changes.parent_email) {
        await this.syncLogin('guardian', oldGid, [n.parent_email], true);
      }
      return c.json(n);
    });
    app.post('/students/:id/move-class', async (c) => {
      const a = c.get('actor');
      const s = this.student(a, c.req.param('id'), 'edit');
      if (!(this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'students.manage')))) fail(403, 'Student management permission is required to move this student');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the student, current class, destination and effective date, then confirm');
      const destinationId = String(b.class_id || '');
      const effective = String(b.effective_date || pkt().date);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effective) || effective !== pkt().date) fail(400, 'Class transfers take effect today so attendance and fee records cannot be changed retroactively');
      if (s.status !== 'active' && s.status !== 'pending') fail(400, 'Only active or pending students can be moved. Restore a former student first.');
      const currentClass = this.one('SELECT * FROM classes WHERE id=? AND active=1', s.class_id);
      const destination = this.one('SELECT * FROM classes WHERE id=? AND active=1', destinationId);
      if (!currentClass || !destination) return fail(404, 'Current or destination class is no longer active');
      if (currentClass.id === destination.id) fail(400, 'The student is already in this class');
      if (!this.inClassScope(a, currentClass.id) || !this.inClassScope(a, destination.id)) fail(403, 'Both the current and destination classes must be within your assigned Mini Admin scope');
      const currentSession = this.currentSession();
      const currentEnrollment = this.one('SELECT * FROM enrollments WHERE student_id=? AND session_id=? AND to_date IS NULL ORDER BY from_date DESC LIMIT 1', s.id, currentSession.id);
      this.tx(() => {
        if (currentEnrollment) {
          this.run('UPDATE enrollments SET to_date=?,outcome=?,class_name_snapshot=COALESCE(class_name_snapshot,?) WHERE id=?',
            addDays(effective, -1), 'transferred', currentClass.name, currentEnrollment.id);
        } else {
          this.run('INSERT INTO enrollments (id,student_id,class_id,session_id,from_date,outcome,to_date,class_name_snapshot) VALUES (?,?,?,?,?,?,?,?)',
            rid(12), s.id, currentClass.id, currentSession.id, s.admission_date || effective, 'transferred', addDays(effective, -1), currentClass.name);
        }
        this.run('UPDATE students SET class_id=? WHERE id=?', destination.id, s.id);
        this.run('INSERT INTO enrollments (id,student_id,class_id,session_id,from_date,class_name_snapshot) VALUES (?,?,?,?,?,?)',
          rid(12), s.id, destination.id, currentSession.id, effective, destination.name);
      });
      const detail = { student_id:s.id, student_name:s.name, reg_no:s.reg_no, from_class_id:currentClass.id, from_class:currentClass.name, to_class_id:destination.id, to_class:destination.name, effective_date:effective, reason:String(b.reason || '').trim() || null };
      this.audit(a, 'student.class.transfer', 'student', s.id, detail);
      this.notify('g:' + s.guardian_id, 'Class changed', s.name + ' has been moved from ' + currentClass.name + ' to ' + destination.name + ' from ' + effective + '.');
      for (const tid of [currentClass.class_teacher_id, destination.class_teacher_id]) if (tid) this.notify('s:' + tid, 'Student class transfer', s.name + ' (' + s.reg_no + ') moved from ' + currentClass.name + ' to ' + destination.name + '.');
      return c.json({ ok:true, student_id:s.id, from_class:currentClass.name, to_class:destination.name, effective_date:effective });
    });
    
    app.post('/students/:id/confirm', async (c) => {
      const a = c.get('actor');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm that this student profile should become active');
      const s = this.student(a, c.req.param('id'), 'edit');
      if (s.status !== 'pending') fail(400, 'Student is not awaiting confirmation');
      this.run("UPDATE students SET status='active', confirmed_by=? WHERE id=?", a.key, s.id);
      this.audit(a, 'student.confirm', 'student', s.id);
      await this.syncGuardian(s.guardian_id);
      this.notifyParentOf(s.id, 'Welcome', `${this.one("SELECT value FROM meta WHERE key='school_name'")?.value} has added your child. Install the app and sign in with your Google account registered as the parent email.`);
      return c.json({ ok: true });
    });
    app.post('/students/:id/left', async (c) => {
      const a = c.get('actor');
      const s = this.student(a, c.req.param('id'), 'edit');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm the student leaving status and date before saving');
      if (!['active', 'pending'].includes(s.status)) fail(409, 'Only an active or pending student can be marked as left');
      const reasons = ['transferred', 'left without notice', 'expelled', 'passed out', 'other'];
      if (!reasons.includes(b.reason)) fail(400, 'Choose a leaving reason');
      const leavingDate = String(b.date || pkt().date);
      const parsedDate = new Date(leavingDate + 'T00:00:00Z');
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(leavingDate) || !Number.isFinite(parsedDate.getTime()) ||
          parsedDate.toISOString().slice(0, 10) !== leavingDate || leavingDate > pkt().date) {
        fail(400, 'Enter a valid leaving date that is not in the future');
      }
      const enrollment = this.one('SELECT * FROM enrollments WHERE student_id=? AND to_date IS NULL ORDER BY from_date DESC LIMIT 1', s.id);
      if (enrollment && leavingDate < enrollment.from_date) fail(400, 'Leaving date cannot be before the current class enrollment');
      const className = this.one('SELECT name FROM classes WHERE id=?', s.class_id)?.name || '';
      const reason = b.reason + (b.note ? `: ${String(b.note).trim().slice(0, 500)}` : '');
      this.tx(() => {
        this.run("UPDATE students SET status='left', left_date=?, left_reason=? WHERE id=?", leavingDate, reason, s.id);
        if (enrollment) this.run("UPDATE enrollments SET to_date=?, outcome='left', class_name_snapshot=COALESCE(class_name_snapshot, ?) WHERE id=? AND to_date IS NULL",
          leavingDate, className, enrollment.id);
      });
      this.audit(a, 'student.left', 'student', s.id, { ...b, date: leavingDate });
      await this.syncGuardian(s.guardian_id);
      return c.json({ ok: true });
    });
    app.post('/students/:id/restore', async (c) => {
      const a = c.get('actor');
      const ctx = c.get('ctx');
      const s = this.student(a, c.req.param('id'), 'edit');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm that this former student should be restored');
      if (s.status !== 'left') fail(409, 'Only a former student can be restored');
      const classId = String(b.class_id || s.class_id);
      const destination = this.one('SELECT id, name FROM classes WHERE id=? AND active=1', classId);
      if (!destination) return fail(400, 'Choose an active class for this student before restoring');
      if (!this.inClassScope(a, classId)) fail(403, 'The destination class is outside your assigned scope');
      const activeCount = Number(this.one("SELECT COUNT(*) AS n FROM students WHERE status!='left'")?.n || 0);
      if (activeCount >= ctx.studentCap) fail(402, `Your plan allows ${ctx.studentCap} students. Upgrade under Billing before restoring another student.`);
      const session = this.currentSession();
      const effective = pkt().date;
      this.tx(() => {
        this.run("UPDATE enrollments SET to_date=?, outcome=COALESCE(outcome,'left') WHERE student_id=? AND to_date IS NULL",
          s.left_date || effective, s.id);
        this.run("UPDATE students SET status='active', left_date=NULL, left_reason=NULL, class_id=? WHERE id=?", classId, s.id);
        this.run('INSERT INTO enrollments (id, student_id, class_id, session_id, from_date) VALUES (?,?,?,?,?)',
          rid(12), s.id, classId, session.id, effective);
      });
      this.audit(a, 'student.restore', 'student', s.id, { class_id: classId, class_name: destination.name });
      await this.syncGuardian(s.guardian_id);
      return c.json({ ok: true, class_id: classId });
    });
    app.delete('/students/:id', async (c) => {
      const a = c.get('actor'); this.requireMain(a);
      if (c.req.query('confirm') !== '1') fail(400, 'Confirm permanent deletion of this student profile');
      const s = this.student(a, c.req.param('id'), 'edit');
      if (this.one('SELECT 1 FROM attendance_records WHERE student_id=? LIMIT 1', s.id) || this.one('SELECT 1 FROM vouchers WHERE student_id=? LIMIT 1', s.id))
        fail(400, 'This student has attendance or fee records. Use Mark as left instead.');
      this.tx(() => { this.run('DELETE FROM enrollments WHERE student_id=?', s.id); this.run('DELETE FROM students WHERE id=?', s.id); this.audit(a, 'student.delete', 'student', s.id, s); });
      await this.syncGuardian(s.guardian_id);
      return c.json({ ok: true });
    });
    app.post('/students/:id/discounts', async (c) => {
      const a = c.get('actor'); if (!this.canFeesAll(a)) fail(403, 'Only assigned fee managers can set discounts');
      const s = this.student(a, c.req.param('id'), 'fees'); const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm this student discount before saving');
      if (!['sibling', 'scholarship', 'staff child', 'custom'].includes(b.kind) || !(Number(b.amount) > 0)) fail(400, 'Choose a kind and an amount');
      this.run('INSERT INTO student_discounts VALUES (?,?,?,?,?)', 'sd_' + rid(10), s.id, b.kind, Math.round(Number(b.amount)), b.note || null);
      this.audit(a, 'discount.add', 'student', s.id, b);
      return c.json({ ok: true });
    });
    app.delete('/students/:id/discounts/:did', (c) => {
      const a = c.get('actor'); if (!this.canFeesAll(a)) fail(403, 'No access');
      const student = this.student(a, c.req.param('id'), 'fees');
      if (c.req.query('confirm') !== '1') fail(400, 'Confirm removing this student discount');
      this.run('DELETE FROM student_discounts WHERE id=? AND student_id=?', c.req.param('did'), student.id);
      this.audit(a, 'discount.remove', 'student', c.req.param('id'), c.req.param('did'));
      return c.json({ ok: true });
    });
    app.post('/students/:id/reminder-pause', async (c) => {
      const a = c.get('actor'); const s = this.student(a, c.req.param('id'), 'fees');
      if (a.type === 'guardian') fail(403, 'No access');
      const b = await c.req.json<any>();
      if (b.off) this.run('DELETE FROM reminder_pauses WHERE student_id=?', s.id);
      else { if (!b.reason) fail(400, 'A reason is required'); this.run('INSERT OR REPLACE INTO reminder_pauses VALUES (?,?,?,?)', s.id, b.reason, a.key, b.until || null); }
      this.audit(a, b.off ? 'reminders.resume' : 'reminders.pause', 'student', s.id, b);
      return c.json({ ok: true });
    });

    // ----- search -----
    app.get('/search', (c) => {
      const a = c.get('actor');
      if (a.type === 'guardian') return c.json({ students: [], staff: [], users: [] });
      const raw = String(c.req.query('q') || '').trim();
      if (raw.length < 2) return c.json({ students: [], staff: [], users: [] });
      const lower = raw.toLowerCase(), sk = skeleton(raw), digits = raw.replace(/\D/g, '');
      const [w, p] = this.studentScope(a, 's');
      const cand = this.q(`SELECT s.id, s.reg_no, s.name, s.father_name, s.status, s.parent_phone, s.search_key, c.name AS class_name FROM students s
        JOIN classes c ON c.id=s.class_id WHERE ${w}`, ...p);
      const students = cand.filter((s) => {
        if (s.name.toLowerCase().includes(lower) || s.father_name.toLowerCase().includes(lower) || s.reg_no.toLowerCase().includes(lower) || s.class_name.toLowerCase().replace(/\s/g, '') === lower.replace(/\s/g, '')) return true;
        if (digits.length >= 4 && s.parent_phone.endsWith(digits)) return true;
        return sk.split(' ').every((part) => s.search_key.split(' ').some((x: string) => x.startsWith(part)));
      }).slice(0, 20).map((s) => ({ ...s, parent_phone: this.isFullAdmin(a) ? s.parent_phone : undefined, search_key: undefined }));
      const staffRows = this.q('SELECT id, public_id, name, email, phone, subjects, search_key, active, role, is_main FROM staff');
      const staff = staffRows.filter((s) =>
        s.name.toLowerCase().includes(lower) || (s.subjects || '').toLowerCase().includes(lower) || (digits.length >= 4 && (s.phone || '').endsWith(digits)) ||
        sk.split(' ').every((part) => String(s.search_key).split(' ').some((x: string) => x.startsWith(part)))
      ).slice(0, 10).map((s) => ({ id: s.id, name: s.name, subjects: s.subjects, active: s.active, phone: this.isFullAdmin(a) ? s.phone : undefined, userId: this.isFullAdmin(a) ? s.public_id : undefined }));
      let users: Row[] = [];
      if (this.isFullAdmin(a)) {
        const staffUsers = staffRows.filter((u) =>
          String(u.public_id || '').toLowerCase().includes(lower) ||
          String(u.name || '').toLowerCase().includes(lower) ||
          String(u.email || '').toLowerCase().includes(lower) ||
          (digits.length >= 4 && String(u.phone || '').endsWith(digits))
        ).map((u) => ({
          userId: u.public_id, name: u.name, email: u.email,
          accountType: u.is_main ? 'Main administrator' : (u.role === 'teacher' ? 'Teacher' : 'Staff / administrator'),
          active: !!u.active,
        }));
        const guardianUsers = this.q("SELECT g.id, g.public_id, g.name, g.email, g.phone, EXISTS(SELECT 1 FROM students s WHERE s.guardian_id=g.id AND s.status='active') AS active FROM guardians g").filter((u) =>
          String(u.public_id || '').toLowerCase().includes(lower) ||
          String(u.name || '').toLowerCase().includes(lower) ||
          String(u.email || '').toLowerCase().includes(lower) ||
          (digits.length >= 4 && String(u.phone || '').endsWith(digits))
        ).map((u) => ({
          userId: u.public_id, name: u.name || 'Parent', email: u.email,
          accountType: 'Parent / guardian', active: !!u.active,
        }));
        users = [...staffUsers, ...guardianUsers].slice(0, 20);
      }
      return c.json({ students, staff, users });
    });

    // ----- attendance -----
    app.get('/attendance/:classId/:date', (c) => c.json(this.attendanceSheet(c.get('actor'), c.req.param('classId'), c.req.param('date'))));
    app.put('/attendance/:classId/:date', async (c) => {
      const b = await c.req.json<any>();
      return c.json(this.saveAttendance(c.get('actor'), c.req.param('classId'), c.req.param('date'), b.records || {}, false));
    });
    app.post('/attendance/:classId/:date/submit', async (c) => {
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the attendance register and confirm submission');
      return c.json(this.saveAttendance(c.get('actor'), c.req.param('classId'), c.req.param('date'), b.records || {}, true));
    });
    app.post('/attendance/correct', async (c) => {
      const a = c.get('actor');
      const b = await c.req.json<any>();
      const target = this.one('SELECT class_id FROM students WHERE id=?', b.student_id);
      if (!target) return fail(404, 'Student not found');
      if (!(this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'attendance.manage') && this.inClassScope(a, target.class_id)))) fail(403, 'Attendance correction permission is required for this class');
      if (b.confirm !== true) fail(400, 'Review the attendance correction and confirm before saving');
      this.correctAttendance(a, b.student_id, b.date, b.status, b.reason);
      return c.json({ ok: true });
    });
    app.get('/register/:classId/:month', (c) => {
      const a = c.get('actor');
      const cl = this.classOf(a, c.req.param('classId'));
      const month = c.req.param('month');
      const students = this.q("SELECT id, name, reg_no FROM students WHERE class_id=? AND status IN ('active','pending') ORDER BY name", cl.id);
      const records = this.monthAttendance(students.map((s) => s.id), month);
      const dates = [...new Set(records.map((r) => r.date))].sort();
      const low = this.num('low_attendance_percent') || 75;
      const rows = students.map((s) => {
        const r = records.filter((x) => x.student_id === s.id);
        const pres = r.filter((x) => x.status === 'P' || x.status === 'L').length;
        const pct = r.length ? Math.round((100 * pres) / r.length) : null;
        let streak = 0, max = 0; for (const x of r) { streak = x.status === 'A' ? streak + 1 : 0; max = Math.max(max, streak); }
        return { ...s, days: Object.fromEntries(r.map((x) => [x.date, x.status])), percent: pct, warning: max >= 3 ? '3+ absences in a row' : pct !== null && pct < low ? `Below ${low}%` : null };
      });
      return c.json({ class: cl, month, dates, rows });
    });
    app.get('/holidays', (c) => c.json(this.q('SELECT * FROM holidays ORDER BY date')));
    app.post('/holidays', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || !b.name) fail(400, 'Date and name are required');
      const to = b.to && /^\d{4}-\d{2}-\d{2}$/.test(b.to) ? b.to : b.date;
      for (let d = b.date; d <= to; d = addDays(d, 1)) this.run('INSERT OR REPLACE INTO holidays VALUES (?,?)', d, b.name);
      this.audit(a, 'holiday.add', null, null, b);
      return c.json({ ok: true });
    });
    app.delete('/holidays/:date', (c) => { const a = c.get('actor'); this.requireFullAdmin(a); this.run('DELETE FROM holidays WHERE date=?', c.req.param('date')); this.audit(a, 'holiday.remove', null, null, c.req.param('date')); return c.json({ ok: true }); });

    // ----- change requests (teacher → admin) -----
    app.post('/change-requests', async (c) => {
      const a = c.get('actor');
      if (a.type !== 'staff') fail(403, 'Only staff can send change requests');
      const b = await c.req.json<any>();
      if (!b.reason) fail(400, 'A reason is required');
      if (b.kind === 'attendance') {
        this.student(a, b.student_id);
        if (!STATUS_LABEL[b.status]) fail(400, 'Unknown status');
      } else if (b.kind === 'student') this.student(a, b.student_id);
      else fail(400, 'Unknown request');
      const id = 'cr_' + rid(10);
      this.run('INSERT INTO change_requests (id, kind, ref, detail, reason, requested_by, created_at) VALUES (?,?,?,?,?,?,?)', id, b.kind, b.student_id, JSON.stringify(b), b.reason, a.key, now());
      this.notifyAdmins('Change request', `${a.name}: ${b.reason}`, { subrole: 'coordinator', link: '#/requests' });
      return c.json({ ok: true, id });
    });
    app.get('/change-requests', (c) => {
      const a = c.get('actor');
      let rows = this.q("SELECT * FROM change_requests ORDER BY status='open' DESC, created_at DESC LIMIT 300");
      if (!this.isFullAdmin(a)) {
        if (a.role === 'subadmin' && (this.hasPermission(a, 'attendance.manage') || this.canManageStudents(a))) {
          rows = rows.filter((r) => {
            if (r.kind === 'attendance' && !this.hasPermission(a, 'attendance.manage')) return false;
            if (r.kind === 'student' && !this.canManageStudents(a)) return false;
            const student = this.one('SELECT class_id FROM students WHERE id=?', r.ref);
            return !!student && this.inClassScope(a, student.class_id);
          });
        } else rows = rows.filter((r) => r.requested_by === a.key);
      }
      return c.json(rows.map((r) => ({ ...r, detail: JSON.parse(r.detail), student_name: this.one('SELECT name FROM students WHERE id=?', r.ref)?.name, requested_by_name: this.one('SELECT name FROM staff WHERE id=?', String(r.requested_by).slice(2))?.name })));
    });
    app.post('/change-requests/:id/decide', async (c) => {
      const a = c.get('actor');
      const b = await c.req.json<any>();
      const r = this.one("SELECT * FROM change_requests WHERE id=? AND status='open'", c.req.param('id')); if (!r) fail(404, 'Not found');
      const d = JSON.parse(r!.detail);
      const target = this.one('SELECT class_id FROM students WHERE id=?', r!.ref);
      const allowed = this.isFullAdmin(a) || (a.role === 'subadmin' && (r!.kind === 'attendance' ? this.hasPermission(a, 'attendance.manage') : this.canManageStudents(a)) && !!target && this.inClassScope(a, target.class_id));
      if (!allowed) fail(403, 'You do not have permission to decide this request');
      if (b.confirm !== true) fail(400, 'Review the request and confirm your decision');
      if (b.approve && r!.kind === 'attendance') this.correctAttendance(a, d.student_id, d.date, d.status, `Teacher request: ${r!.reason}`);
      this.run('UPDATE change_requests SET status=?, decided_by=?, decided_at=? WHERE id=?', b.approve ? 'approved' : 'declined', a.key, now(), r!.id);
      this.notify(r!.requested_by, `Request ${b.approve ? 'approved' : 'declined'}`, r!.reason);
      this.audit(a, 'change_request.' + (b.approve ? 'approve' : 'decline'), 'student', r!.ref, r!.reason);
      return c.json({ ok: true });
    });

    // ----- fees -----
    app.get('/fees/setup', (c) => {
      const a = c.get('actor');
      let classes = this.q('SELECT id, name FROM classes WHERE active=1 ORDER BY grade, name');
      if (!this.isFullAdmin(a)) {
        classes = classes.filter((x) => this.canSetFees(a, x.id));
        if (!classes.length) fail(403, 'No access');
      }
      const allowedIds = new Set(classes.map((x) => x.id));
      const plans = this.q('SELECT * FROM fee_plans').filter((x) => allowedIds.has(x.class_id));
      return c.json({ heads: this.q('SELECT * FROM fee_heads'), plans, classes, editable: classes.filter((x) => this.canSetFees(a, x.id)).map((x) => x.id) });
    });
    app.post('/fees/heads', async (c) => {
      const a = c.get('actor');
      if (!(this.isFullAdmin(a) || (a.role === 'subadmin' && this.canFeesAll(a) && a.scopeAll))) fail(403, 'Creating shared fee heads requires full-institution fee management');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm adding this shared fee head');
      if (!b.name) fail(400, 'Name required');
      this.run('INSERT INTO fee_heads VALUES (?,?,?)', 'fh_' + rid(8), b.name, b.monthly === false ? 0 : 1);
      this.audit(a, 'fee_head.add', null, null, b); return c.json({ ok: true });
    });
    app.post('/fees/plans', async (c) => {
      const a = c.get('actor');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm the class fee plan changes before saving');
      const plans = b.plans || [];
      for (const p of plans) if (!this.canSetFees(a, p.class_id)) fail(403, 'You cannot set fees for this class');
      const changed = new Set<string>();
      for (const p of plans) {
        const amt = Math.max(0, Math.round(Number(p.amount) || 0));
        const old = this.one('SELECT amount FROM fee_plans WHERE class_id=? AND head_id=?', p.class_id, p.head_id);
        if (old?.amount === amt) continue;
        this.run('INSERT OR REPLACE INTO fee_plans VALUES (?,?,?)', p.class_id, p.head_id, amt);
        changed.add(p.class_id);
      }
      if (b.update_current !== false) for (const cid of changed) for (const s of this.q("SELECT id FROM students WHERE class_id=? AND status='active'", cid)) this.refreshOpenVoucher(s.id);
      this.audit(a, 'fee_plan.update', null, null, b); return c.json({ ok: true, classesChanged: changed.size });
    });
    app.get('/students/:id/fee', (c) => {
      const a = c.get('actor'); const s = this.student(a, c.req.param('id'), 'fees');
      const plan = this.q('SELECT h.id AS head_id, h.name, COALESCE(p.amount,0) AS class_amount FROM fee_heads h LEFT JOIN fee_plans p ON p.head_id=h.id AND p.class_id=? WHERE h.monthly=1', s.class_id);
      const own = new Map(this.q('SELECT head_id, amount FROM student_fee_overrides WHERE student_id=?', s.id).map((o) => [o.head_id, o.amount]));
      return c.json({ heads: plan.map((h) => ({ ...h, student_amount: own.has(h.head_id) ? own.get(h.head_id) : null })), canEdit: this.canSetFees(a, s.class_id),
        monthly: this.feeLines(s).reduce((t, l) => t + l.amount, 0) });
    });
    app.post('/students/:id/fee', async (c) => {
      const a = c.get('actor'); const s = this.student(a, c.req.param('id'), 'fees');
      if (!this.canSetFees(a, s.class_id)) fail(403, 'You cannot change fees for this student');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm the individual student fee change before saving');
      for (const l of b.heads || []) {
        if (l.amount === null || l.amount === '' || l.amount === undefined) this.run('DELETE FROM student_fee_overrides WHERE student_id=? AND head_id=?', s.id, l.head_id);
        else this.run('INSERT OR REPLACE INTO student_fee_overrides VALUES (?,?,?)', s.id, l.head_id, Math.max(0, Math.round(Number(l.amount))));
      }
      this.refreshOpenVoucher(s.id);
      this.audit(a, 'student.fee', 'student', s.id, b);
      return c.json({ ok: true });
    });
    app.post('/vouchers/:id/fine', async (c) => {
      const a = c.get('actor'); if (!this.canFeesAll(a)) fail(403, 'Only the admin or accountant can change a fine');
      const v = this.one('SELECT * FROM vouchers WHERE id=?', c.req.param('id')); if (!v) fail(404, 'Not found');
      this.student(a, v!.student_id, 'fees');
      if (!['unpaid', 'partial'].includes(v!.status)) fail(400, 'Only an unpaid voucher can be changed');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm the voucher fine change before saving');
      if (b.auto) { this.run('UPDATE vouchers SET fine_locked=0 WHERE id=?', v!.id); this.run('UPDATE vouchers SET fine=? WHERE id=?', this.autoFine({ ...v!, fine_locked: 0 }, pkt().date), v!.id); }
      else {
        const amt = Math.max(0, Math.round(Number(b.amount) || 0));
        if (!b.reason) fail(400, 'A reason is required');
        this.run('UPDATE vouchers SET fine=?, fine_locked=1 WHERE id=?', amt, v!.id);
        if (amt !== v!.fine) this.notifyParentOf(v!.student_id, amt > v!.fine ? 'Late fine added' : 'Fine reduced', `Fine for ${v!.month} is now ${money(amt)}. ${b.reason}`);
      }
      const n = this.one('SELECT * FROM vouchers WHERE id=?', v!.id)!;
      if (n.status === 'partial' && n.paid >= this.voucherTotal(n)) this.run("UPDATE vouchers SET status='paid' WHERE id=?", n.id);
      this.audit(a, 'voucher.fine', 'student', v!.student_id, { voucher: v!.id, old: v!.fine, new: n.fine, reason: b.reason || 'automatic' });
      return c.json({ ok: true, fine: n.fine });
    });
    app.get('/payment-accounts', (c) => { try { return c.json(JSON.parse(this.setting('payment_accounts') || '[]')); } catch { return c.json([]); } });
    app.post('/payment-accounts', async (c) => {
      const a = c.get('actor'); this.requireFullAdmin(a);
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm the institution payment account changes before saving');
      const list = (Array.isArray(b.accounts) ? b.accounts : []).slice(0, 10).map((x: any) => ({
        company: String(x.company || '').trim().slice(0, 60),   // Easypaisa, JazzCash, Meezan Bank, UBL, SadaPay… any service
        title: String(x.title || '').trim().slice(0, 80),       // account holder name
        number: String(x.number || '').trim().slice(0, 40),     // account number / mobile number / IBAN
        branch: String(x.branch || '').trim().slice(0, 80),     // optional: branch or note
      })).filter((x: any) => x.company && x.number);
      this.run("INSERT OR REPLACE INTO settings VALUES ('payment_accounts', ?)", JSON.stringify(list));
      this.audit(a, 'payment_accounts.update', null, null, list);
      return c.json({ ok: true, accounts: list });
    });
    app.post('/fees/generate', async (c) => {
      const a = c.get('actor'); if (!this.canFeesAll(a)) fail(403, 'No access');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Confirm generating fee vouchers for the selected month');
      const classIds = this.isFullAdmin(a) ? undefined : this.scopedClassIds(a).filter((id) => this.canSetFees(a, id));
      if (!this.isFullAdmin(a) && !classIds?.length) fail(403, 'No fee-manageable classes are assigned to this account');
      return c.json(this.generateVouchers(a, b.month || pkt().month, undefined, classIds));
    });
    app.get('/vouchers/:id', (c) => {
      const a = c.get('actor');
      const v = this.one('SELECT * FROM vouchers WHERE id=?', c.req.param('id')); if (!v) fail(404, 'Not found');
      const s = this.student(a, v!.student_id, 'fees');
      return c.json({ voucher: { ...v, total: this.voucherTotal(v!), balance: this.voucherBalance(v!) }, lines: this.q('SELECT * FROM voucher_lines WHERE voucher_id=?', v!.id),
        student: { name: s.name, father_name: s.father_name, reg_no: s.reg_no, class_name: this.one('SELECT name FROM classes WHERE id=?', s.class_id)?.name },
        school: this.one("SELECT value FROM meta WHERE key='school_name'")?.value, accounts: JSON.parse(this.setting('payment_accounts') || '[]') });
    });
    app.get('/fees/unpaid', (c) => {
      const a = c.get('actor');
      const month = c.req.query('month') || pkt().month;
      const cls = c.req.query('class_id');
      let classes: string[] | null = null;
      if (!this.isFullAdmin(a)) {
        classes = a.role === 'subadmin' && this.canFeesAll(a)
          ? this.scopedClassIds(a).filter((id) => this.canSetFees(a, id))
          : [...a.classTeacherOf];
        if (!classes.length) fail(403, 'No access');
      }
      let rows = this.q(`SELECT v.*, s.name, s.reg_no, s.parent_phone, c.name AS class_name, s.status AS student_status FROM vouchers v JOIN students s ON s.id=v.student_id
        JOIN classes c ON c.id=v.class_id WHERE v.month=? AND v.status IN ('unpaid','partial','carried')`, month);
      if (classes) rows = rows.filter((r) => classes!.includes(r.class_id));
      if (cls) rows = rows.filter((r) => r.class_id === cls);
      const today = pkt().date;
      return c.json(rows.map((v) => ({ id: v.id, student_id: v.student_id, name: v.name, reg_no: v.reg_no, parent_phone: v.parent_phone, class_name: v.class_name, month: v.month,
        due: this.voucherTotal(v), paid: v.paid, balance: this.voucherBalance(v), status: v.status, student_status: v.student_status,
        days_overdue: Math.max(0, Math.round((Date.parse(today) - Date.parse(v.due_date)) / 864e5)), last_reminder: v.last_reminder })));
    });
    app.get('/fees/defaulters', (c) => {
      const a = c.get('actor'); if (!this.canFeesAll(a)) fail(403, 'No access');
      let rows = this.q(`SELECT s.id, s.name, s.reg_no, s.status, s.class_id, c.name AS class_name, COUNT(*) AS months FROM vouchers v JOIN students s ON s.id=v.student_id JOIN classes c ON c.id=s.class_id
        WHERE v.status IN ('unpaid','partial','carried') GROUP BY s.id HAVING COUNT(*)>=? ORDER BY months DESC`, this.num('defaulter_months') || 2);
      if (!this.isFullAdmin(a)) { const allowed = this.scopedClassIds(a).filter((id) => this.canSetFees(a, id)); rows = rows.filter((r) => allowed.includes(r.class_id)); }
      return c.json(rows.map((r) => ({ ...r, balance: this.latestVoucher(r.id) ? this.voucherBalance(this.latestVoucher(r.id)!) : 0 })));
    });
    app.get('/fees/report', (c) => {
      const a = c.get('actor'); if (!this.canFeesAll(a)) fail(403, 'No access');
      const month = c.req.query('month') || pkt().month;
      let v = this.q('SELECT * FROM vouchers WHERE month=?', month);
      const allowed = this.isFullAdmin(a) ? null : this.scopedClassIds(a).filter((id) => this.canSetFees(a, id));
      if (allowed) v = v.filter((x) => allowed.includes(x.class_id));
      const expected = v.reduce((t, x) => t + this.voucherTotal(x), 0);
      let daily = this.q(`SELECT substr(datetime(verified_at, '+5 hours'),1,10) AS day, method, SUM(amount) AS amount, COUNT(*) AS n, class_id FROM payments
        WHERE status='verified' AND substr(datetime(verified_at, '+5 hours'),1,7)=? GROUP BY day, method, class_id ORDER BY day`, month);
      if (allowed) daily = daily.filter((x) => allowed.includes(x.class_id));
      const dailySummary: Row[] = [];
      for (const p of daily) {
        const existing = dailySummary.find((x) => x.day === p.day && x.method === p.method);
        if (existing) { existing.amount += p.amount; existing.n += p.n; }
        else dailySummary.push({ day: p.day, method: p.method, amount: p.amount, n: p.n });
      }
      return c.json({ month, expected, collected: dailySummary.reduce((t, x) => t + x.amount, 0), vouchers: v.length, paid: v.filter((x) => x.status === 'paid').length, daily: dailySummary });
    });
    app.post('/fees/remind', async (c) => {
      const a = c.get('actor');
      const b = await c.req.json<any>();
      let sent = 0;
      for (const id of b.voucher_ids || []) {
        const v = this.one('SELECT * FROM vouchers WHERE id=?', id); if (!v) continue;
        this.student(a, v.student_id, 'fees');
        if (a.type === 'guardian') fail(403, 'No access');
        this.notifyParentOf(v.student_id, 'Fee reminder', `${money(this.voucherBalance(v))} is due for ${v.month}.`);
        this.run('UPDATE vouchers SET last_reminder=? WHERE id=?', now(), v.id); sent++;
      }
      return c.json({ sent });
    });

    app.post('/payments', async (c) => {
      const a = c.get('actor'); const ctx = c.get('ctx');
      const ct = c.req.header('content-type') || '';
      let b: Row; let file: File | null = null;
      if (ct.includes('multipart')) { const f = await c.req.formData(); b = Object.fromEntries([...f.entries()].filter(([, v]) => typeof v === 'string')); file = (f.get('slip') as unknown as File) || null; }
      else b = await c.req.json<any>();
      const v = this.one('SELECT * FROM vouchers WHERE id=?', b.voucher_id); if (!v) fail(404, 'Voucher not found');
      const s = this.student(a, v!.student_id, 'fees');
      if (v!.status === 'carried') fail(400, 'This voucher was carried into a newer one. Pay the latest voucher.');
      const amount = Math.round(Number(b.amount));
      if (!(amount > 0)) fail(400, 'Enter the amount');
      if (amount > this.voucherBalance(v!)) fail(400, `Amount cannot exceed the remaining balance of ${money(this.voucherBalance(v!))}.`);
      const method = String(b.method);
      const txn = b.txn_id ? String(b.txn_id).trim().toUpperCase() : null;
      let status = 'submitted', held: string | null = null;
      if (a.type === 'guardian') {
        if (!['easypaisa', 'jazzcash', 'bank'].includes(method)) fail(400, 'Choose Easypaisa, JazzCash or bank');
        if (!txn) fail(400, 'Transaction ID is required');
        if (!file || !file.size) fail(400, 'Upload the payment slip (image or PDF)');
      } else if (method === 'cash_teacher') {
        if (!a.classTeacherOf.has(s.class_id) && !this.canFeesAll(a)) fail(403, 'Only the class teacher can take cash for this class');
        held = a.key;
      } else if (['office_cash', 'bank', 'easypaisa', 'jazzcash'].includes(method)) {
        if (!this.canFeesAll(a)) fail(403, 'Only the accountant or admin can record office payments');
        status = 'verified';
      } else fail(400, 'Unknown payment method');
      if (txn && this.one("SELECT 1 FROM payments WHERE txn_id=? AND status IN ('submitted','verified')", txn)) fail(409, 'This transaction ID has already been used. It may be a duplicate slip.');
      const slipKey = file && file.size ? await this.putFile(ctx, a, file, 'slips', 5) : null;
      const id = 'pay_' + rid(12);
      this.run(`INSERT INTO payments (id, voucher_id, student_id, class_id, method, amount, txn_id, slip_key, status, submitted_by, held_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,'submitted',?,?,?)`, id, v!.id, s.id, s.class_id, method, amount, txn, slipKey, a.key, held, now());
      this.audit(a, 'payment.submit', 'student', s.id, { id, method, amount, txn });
      let receipt: number | null = null;
      if (status === 'verified') { this.run('UPDATE payments SET verified_by=? WHERE id=?', a.key, id); receipt = this.applyVerified(this.one('SELECT * FROM payments WHERE id=?', id)!); }
      else if (method === 'cash_teacher') {
        this.notifyParentOf(s.id, 'Cash received by teacher', `${money(amount)} received by ${a.name}. A receipt follows once the office confirms.`);
        this.notifyAdmins('Cash with teacher', `${a.name} took ${money(amount)} from ${s.name}.`, { subrole: 'accountant', link: '#/cash' });
      } else {
        this.notifyParentOf(s.id, 'Slip received', `Your ${method} slip for ${money(amount)} is awaiting verification.`);
        this.notifyAdmins('New slip to verify', `${s.name}: ${money(amount)} by ${method} (${txn}).`, { subrole: 'accountant', link: '#/fees/slips' });
        this.notifyClassTeacher(s.class_id, 'New slip', `${s.name}: ${money(amount)} by ${method}.`);
      }
      return c.json({ ok: true, id, receipt });
    });
    app.get('/payments', (c) => {
      const a = c.get('actor');
      const status = c.req.query('status') || 'submitted';
      let rows = this.q(`SELECT p.*, s.name AS student_name, s.reg_no, c.name AS class_name FROM payments p JOIN students s ON s.id=p.student_id JOIN classes c ON c.id=p.class_id
        WHERE p.status=? ORDER BY p.created_at DESC LIMIT 500`, status);
      if (!this.isFullAdmin(a)) {
        if (a.type === 'guardian') fail(403, 'No access');
        const allowed = a.role === 'subadmin' && this.canFeesAll(a)
          ? this.scopedClassIds(a).filter((id) => this.canSetFees(a, id))
          : [...a.classTeacherOf];
        rows = rows.filter((r) => allowed.includes(r.class_id));
      }
      return c.json(rows.map((r) => ({ ...r, can_verify: this.canVerify(a, r), submitted_by_name: this.one('SELECT name FROM staff WHERE id=?', String(r.submitted_by).slice(2))?.name || (r.submitted_by.startsWith('g:') ? 'Parent' : '') })));
    });
    app.get('/payments/:id', (c) => {
      const a = c.get('actor');
      const p = this.one('SELECT * FROM payments WHERE id=?', c.req.param('id')); if (!p) fail(404, 'Not found');
      const s = this.student(a, p!.student_id, 'fees');
      const v = this.one('SELECT * FROM vouchers WHERE id=?', p!.voucher_id)!;
      return c.json({ payment: p, student: { name: s.name, father_name: s.father_name, reg_no: s.reg_no, class_name: this.one('SELECT name FROM classes WHERE id=?', s.class_id)?.name },
        voucher: { ...v, total: this.voucherTotal(v), balance: this.voucherBalance(v) }, school: this.one("SELECT value FROM meta WHERE key='school_name'")?.value,
        verified_by_name: this.one('SELECT name FROM staff WHERE id=?', String(p!.verified_by || '').slice(2))?.name });
    });
    app.post('/payments/:id/verify', async (c) => {
      const a = c.get('actor');
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the slip amount, student and transaction reference, then confirm verification');
      const p = this.one("SELECT * FROM payments WHERE id=? AND status='submitted'", c.req.param('id')); if (!p) fail(404, 'Payment not found or already handled');
      if (!this.canVerify(a, p!)) fail(403, 'You cannot verify this payment');
      if (p!.submitted_by === a.key && a.type !== 'staff') fail(403, 'You cannot verify your own payment');
      const receipt = this.tx(() => {
        this.run("UPDATE payments SET verified_by=? WHERE id=? AND status='submitted'", a.key, p!.id);
        if (Number(this.one('SELECT changes() AS n')?.n || 0) !== 1) fail(409, 'This payment has already been handled. Refresh the page.');
        return this.applyVerified(p!);
      });
      this.audit(a, 'payment.verify', 'student', p!.student_id, { id: p!.id, receipt });
      return c.json({ ok: true, receipt });
    });
    app.post('/payments/:id/reject', async (c) => {
      const a = c.get('actor'); const { reason, confirm } = await c.req.json<any>();
      const p = this.one("SELECT * FROM payments WHERE id=? AND status='submitted'", c.req.param('id')); if (!p) fail(404, 'Not found');
      if (!this.canVerify(a, p!)) fail(403, 'You cannot reject this payment');
      if (confirm !== true) fail(400, 'Confirm that this payment slip should be rejected');
      if (!reason) fail(400, 'A reason is required');
      this.tx(() => {
        this.run("UPDATE payments SET status='rejected', reason=?, verified_by=?, verified_at=? WHERE id=? AND status='submitted'",
          String(reason).slice(0, 500), a.key, now(), p!.id);
        if (Number(this.one('SELECT changes() AS n')?.n || 0) !== 1) fail(409, 'This payment has already been handled. Refresh the page.');
      });
      this.notifyParentOf(p!.student_id, 'Slip rejected', `Reason: ${String(reason).slice(0, 500)}. Please upload again.`);
      this.notifyClassTeacher(p!.class_id, 'Slip rejected', reason);
      this.audit(a, 'payment.reject', 'student', p!.student_id, { id: p!.id, reason });
      return c.json({ ok: true });
    });
    app.post('/payments/:id/cancel', async (c) => {
      const a = c.get('actor'); this.requireMain(a);
      const { reason, confirm } = await c.req.json<any>(); if (!reason) fail(400, 'A reason is required');
      if (confirm !== true) fail(400, 'Confirm cancellation of this verified receipt');
      const p = this.one("SELECT * FROM payments WHERE id=? AND status='verified'", c.req.param('id')); if (!p) fail(404, 'Not found');
      this.tx(() => {
        this.run("UPDATE payments SET status='cancelled', reason=? WHERE id=? AND status='verified'", String(reason).trim().slice(0, 500), p!.id);
        if (Number(this.one('SELECT changes() AS n')?.n || 0) !== 1) fail(409, 'This receipt has already been cancelled or changed.');

        const original = this.one('SELECT * FROM vouchers WHERE id=?', p!.voucher_id);
        if (!original) return fail(409, 'The original voucher is missing. No financial changes were made.');
        const originalPaid = Number(original.paid) - Number(p!.amount);
        if (originalPaid < 0) fail(409, 'The receipt exceeds the recorded amount paid on its voucher.');

        const latest = this.latestVoucher(p!.student_id);
        if (latest && latest.id !== original.id && latest.month > original.month) {
          // The old balance was rolled into a newer voucher. Put the cancelled amount
          // back into that current balance, even if the older voucher had been marked paid.
          const arrears = Number(latest.arrears) + Number(p!.amount);
          const total = Number(latest.current) - Number(latest.discount) + arrears + Number(latest.fine);
          const latestStatus = Number(latest.paid) >= total ? 'paid' : Number(latest.paid) > 0 ? 'partial' : 'unpaid';
          const carryStatus = Number(latest.paid) >= arrears ? 'settled' : 'carried';
          this.run('UPDATE vouchers SET paid=?, status=? WHERE id=?', originalPaid, carryStatus, original.id);
          this.run('UPDATE vouchers SET arrears=?, status=? WHERE id=?', arrears, latestStatus, latest.id);
          const arrearsLine = this.one("SELECT rowid FROM voucher_lines WHERE voucher_id=? AND label='Arrears' LIMIT 1", latest.id);
          if (arrearsLine) this.run("UPDATE voucher_lines SET amount=? WHERE rowid=?", arrears, arrearsLine.rowid);
          else this.run("INSERT INTO voucher_lines (voucher_id, label, amount) VALUES (?, 'Arrears', ?)", latest.id, arrears);
          this.run("UPDATE vouchers SET status=? WHERE student_id=? AND month<? AND status IN ('carried','settled')",
            carryStatus, p!.student_id, latest.month);
        } else {
          const total = this.voucherTotal(original);
          const status = originalPaid >= total ? 'paid' : originalPaid > 0 ? 'partial' : 'unpaid';
          this.run('UPDATE vouchers SET paid=?, status=? WHERE id=?', originalPaid, status, original.id);
          if (latest) {
            const carryStatus = Number(latest.paid) >= Number(latest.arrears) ? 'settled' : 'carried';
            this.run("UPDATE vouchers SET status=? WHERE student_id=? AND month<? AND status IN ('carried','settled')",
              carryStatus, p!.student_id, latest.month);
          }
        }
        this.audit(a, 'receipt.cancel', 'student', p!.student_id, { id: p!.id, receipt: p!.receipt_no, reason: String(reason).trim().slice(0, 500) });
      });
      return c.json({ ok: true });
    });

    app.get('/cash', (c) => {
      const a = c.get('actor');
      if (a.type !== 'staff') fail(403, 'No access');
      let rows = this.q(`SELECT p.id, p.amount, p.created_at, p.held_by, p.status, p.class_id, s.name AS student_name, c.name AS class_name FROM payments p JOIN students s ON s.id=p.student_id
        JOIN classes c ON c.id=p.class_id WHERE p.method='cash_teacher' AND p.handover_id IS NULL AND p.status IN ('submitted','verified') ORDER BY p.created_at`);
      if (!this.isFullAdmin(a)) {
        if (this.canFeesAll(a)) { const allowed = this.scopedClassIds(a).filter((id) => this.canSetFees(a, id)); rows = rows.filter((r) => allowed.includes(r.class_id)); }
        else rows = rows.filter((r) => r.held_by === a.key);
      }
      const byTeacher: Row = {};
      for (const r of rows) {
        const t = (byTeacher[r.held_by] ||= { teacher_id: String(r.held_by).slice(2), name: this.one('SELECT name FROM staff WHERE id=?', String(r.held_by).slice(2))?.name, total: 0, items: [] });
        t.total += r.amount; t.items.push(r);
      }
      return c.json({ teachers: Object.values(byTeacher), handovers: this.q('SELECT h.*, t.name FROM cash_handovers h JOIN staff t ON t.id=h.teacher_id ORDER BY h.created_at DESC LIMIT 50') });
    });
    app.post('/cash/handover', async (c) => {
      const a = c.get('actor'); if (!this.canFeesAll(a)) fail(403, 'Only an assigned fee manager can confirm a handover');
      const { teacher_id, amount, confirm } = await c.req.json<any>();
      if (confirm !== true) fail(400, 'Confirm the teacher cash handover');
      const items = this.q("SELECT * FROM payments WHERE held_by=? AND method='cash_teacher' AND handover_id IS NULL AND status IN ('submitted','verified')", 's:' + teacher_id)
        .filter((p) => this.isFullAdmin(a) || this.inClassScope(a, p.class_id));
      const total = items.reduce((t, p) => t + p.amount, 0);
      if (!items.length) fail(400, 'This teacher holds no cash');
      if (amount !== undefined && Number(amount) !== total) fail(400, `Amount does not match. The teacher holds ${money(total)}.`);
      const id = 'ho_' + rid(10);
      this.tx(() => {
        this.run('INSERT INTO cash_handovers VALUES (?,?,?,?,?)', id, teacher_id, total, a.key, now());
        for (const p of items) {
          this.run('UPDATE payments SET handover_id=? WHERE id=?', id, p.id);
          if (p.status === 'submitted') { this.run('UPDATE payments SET verified_by=? WHERE id=?', a.key, p.id); this.applyVerified(p); }
        }
      });
      this.notify('s:' + teacher_id, 'Cash handover confirmed', `${money(total)} received by ${a.name}.`);
      this.audit(a, 'cash.handover', 'staff', teacher_id, { total, id });
      return c.json({ ok: true, total });
    });

    // ----- notices -----
    app.get('/notices', (c) => c.json(this.noticesFor(c.get('actor'))));
    app.post('/notices', async (c) => {
      const a = c.get('actor'); const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the audience and notice text, then confirm sending');
      if (a.type !== 'staff' && a.type !== 'system') fail(403, 'Parents cannot post notices');
      if (!b.title || !b.body) fail(400, 'Title and message are required');
      const aud = String(b.audience);
      if (aud === 'school' && !(this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'notices.manage') && a.scopeAll))) fail(403, 'School-wide notices require a full admin or an all-school notice permission');
      if (aud === 'teachers' && !(this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'notices.manage') && a.scopeAll))) fail(403, 'Only a full admin or all-school notice manager can notify all teachers');
      if (aud === 'admins' && !a.isMain) fail(403, 'Only the Main Admin can send notices to administrators');
      let subject: string | null = null;
      if (aud === 'class') {
        const classId = String(b.target_id || '');
        this.classOf(a, classId);
        const assignedSubject = this.one('SELECT cs.subject FROM class_subject_teacher_assignments a JOIN class_subjects cs ON cs.id=a.class_subject_id WHERE cs.class_id=? AND a.teacher_id=? AND a.from_date<=? AND (a.to_date IS NULL OR a.to_date>=?) AND lower(cs.subject)=lower(?)', classId, a.id, pkt().date, pkt().date, String(b.subject || '').trim());
        const hasAnySubject = !!this.one('SELECT 1 FROM class_subject_teacher_assignments a JOIN class_subjects cs ON cs.id=a.class_subject_id WHERE cs.class_id=? AND a.teacher_id=? AND a.from_date<=? AND (a.to_date IS NULL OR a.to_date>=?)', classId, a.id, pkt().date, pkt().date);
        const mayManage = this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'notices.manage') && this.inClassScope(a, classId));
        if (!mayManage && !a.classTeacherOf.has(classId)) {
          if (!hasAnySubject) fail(403, 'You can only post a notice to a class where you teach a subject');
          if (!String(b.subject || '').trim() || !assignedSubject) fail(403, 'Subject teachers must select one of their assigned subjects for the class notice');
        }
        if (String(b.subject || '').trim()) {
          const validSubject = this.one('SELECT 1 FROM class_subjects WHERE class_id=? AND lower(subject)=lower(?)', classId, String(b.subject).trim());
          if (!validSubject) fail(400, 'That subject is not assigned to this class');
          subject = String(b.subject).trim();
        }
      }
      if (aud === 'student') {
        if (!this.isFullAdmin(a) && !(a.role === 'subadmin' && this.hasPermission(a, 'notices.manage') && this.inClassScope(a, String(this.one('SELECT class_id FROM students WHERE id=?', b.target_id)?.class_id || '')))) fail(403, 'Only an administrator can send a notice to an individual student');
        this.student(a, b.target_id);
      }
      if (!['school', 'class', 'student', 'teachers', 'admins'].includes(aud)) fail(400, 'Choose an audience');
      const id = 'nt_' + rid(10);
      this.run('INSERT INTO notices (id, audience, target_id, title, body, subject, posted_by, poster_name, created_at) VALUES (?,?,?,?,?,?,?,?,?)', id, aud, b.target_id || null, b.title, b.body, subject, a.key, a.name, now());
      // App notification to everyone in the audience.
      const keys = new Set<string>();
      if (aud === 'school') for (const g of this.q("SELECT DISTINCT guardian_id FROM students WHERE status='active'")) keys.add('g:' + g.guardian_id);
      if (aud === 'class') for (const g of this.q("SELECT DISTINCT guardian_id FROM students WHERE status='active' AND class_id=?", b.target_id)) keys.add('g:' + g.guardian_id);
      if (aud === 'student') keys.add('g:' + this.one('SELECT guardian_id FROM students WHERE id=?', b.target_id)!.guardian_id);
      if (aud === 'teachers' || aud === 'school') for (const s of this.q('SELECT id FROM staff WHERE active=1')) keys.add('s:' + s.id);
      if (aud === 'admins') for (const s of this.q("SELECT id FROM staff WHERE active=1 AND role IN ('admin','subadmin')")) keys.add('s:' + s.id);
      keys.delete(a.key);
      for (const k of keys) this.notify(k, 'Notice: ' + b.title, String(b.body).slice(0, 140), '#/notices');
      this.audit(a, 'notice.post', 'notice', id, { audience: aud, title: b.title });
      return c.json({ ok: true, id, recipients: keys.size });
    });
    app.delete('/notices/:id', async (c) => {
      const a = c.get('actor');
      const n = this.one('SELECT * FROM notices WHERE id=? AND deleted_at IS NULL', c.req.param('id')); if (!n) fail(404, 'Not found');
      if (!this.canDeleteNotice(a, n!)) fail(403, 'You can remove only notices for classes you administer or notices you posted yourself');
      const b = await c.req.json<any>().catch(() => ({}));
      if (b.confirm !== true) fail(400, 'Confirm that you want to remove this notice');
      this.run('UPDATE notices SET deleted_at=? WHERE id=?', now(), n!.id);
      this.audit(a, 'notice.delete', 'notice', n!.id, n!.title);
      return c.json({ ok: true });
    });
    app.post('/notices/:id/read', (c) => {
      this.run('INSERT OR IGNORE INTO notice_reads VALUES (?,?,?)', c.req.param('id'), c.get('actor').key, now());
      return c.json({ ok: true });
    });

    // ----- message threads (one per student) -----
    app.get('/threads', (c) => {
      const a = c.get('actor');
      if (a.subrole === 'accountant') fail(403, 'No access');
      const [w, p] = this.studentScope(a, 's');
      if (this.isAdmin(a) && !a.isMain && a.role !== 'admin') fail(403, 'No access');
      const rows = this.q(`SELECT s.id AS student_id, s.name, c.name AS class_name, m.body, m.sender_name, m.created_at FROM thread_messages m
        JOIN students s ON s.id=m.student_id JOIN classes c ON c.id=s.class_id WHERE ${w}
        AND m.created_at=(SELECT MAX(created_at) FROM thread_messages x WHERE x.student_id=m.student_id) ORDER BY m.created_at DESC LIMIT 200`, ...p);
      return c.json(rows);
    });
    app.get('/threads/:studentId', (c) => {
      const a = c.get('actor');
      if (a.subrole === 'accountant' || (a.role === 'subadmin')) fail(403, 'No access');
      const s = this.student(a, c.req.param('studentId'));
      if (this.isAdmin(a) && a.type === 'staff') this.audit(a, 'thread.read', 'student', s.id);
      return c.json({ student: { id: s.id, name: s.name }, messages: this.q('SELECT id, sender_key, sender_name, body, created_at FROM thread_messages WHERE student_id=? ORDER BY created_at', s.id) });
    });
    app.post('/threads/:studentId', async (c) => {
      const a = c.get('actor');
      if (a.role === 'subadmin') fail(403, 'No access');
      const s = this.student(a, c.req.param('studentId'));
      const { body } = await c.req.json<any>();
      if (!body || !String(body).trim()) fail(400, 'Write a message');
      const label = a.type === 'guardian' ? `${a.name} (parent)` : a.name;
      this.run('INSERT INTO thread_messages VALUES (?,?,?,?,?,?)', 'tm_' + rid(12), s.id, a.key, label, String(body).slice(0, 4000), now());
      const keys = new Set<string>(['g:' + s.guardian_id]);
      const cl = this.one('SELECT class_teacher_id FROM classes WHERE id=?', s.class_id);
      if (cl?.class_teacher_id) keys.add('s:' + cl.class_teacher_id);
      for (const t of this.q('SELECT DISTINCT a.teacher_id FROM class_subject_teacher_assignments a JOIN class_subjects cs ON cs.id=a.class_subject_id WHERE cs.class_id=? AND a.from_date<=? AND (a.to_date IS NULL OR a.to_date>=?)', s.class_id, pkt().date, pkt().date)) {
        // Subject teachers hear only when they have taken part in this thread.
        if (this.one('SELECT 1 FROM thread_messages WHERE student_id=? AND sender_key=? LIMIT 1', s.id, 's:' + t.teacher_id)) keys.add('s:' + t.teacher_id);
      }
      keys.delete(a.key);
      for (const k of keys) this.notify(k, `Message about ${s.name}`, `${label}: ${String(body).slice(0, 100)}`, `#/thread/${s.id}`);
      return c.json({ ok: true });
    });

    // ----- results (PDF per student, hidden until published) -----
    app.post('/results', async (c) => {
      const a = c.get('actor'); const ctx = c.get('ctx');
      const f = await c.req.formData();
      const title = String(f.get('title') || '').trim(), session = String(f.get('session') || this.currentSession().name);
      if (!title) fail(400, 'Title is required');
      const studentId = f.get('student_id') as string | null;
      const files = f.getAll('files') as unknown as File[];
      const out: any[] = [];
      for (const file of files) {
        if (!file || typeof file !== 'object' || !file.size) continue;
        let sid = studentId;
        if (!sid) {
          const reg = file.name.replace(/\.pdf$/i, '').trim();
          sid = this.one('SELECT id FROM students WHERE reg_no=?', reg)?.id ?? null;
        }
        let st: Row | null = null;
        if (sid) { try { st = this.student(a, sid); } catch { st = null; } }
        const canManageResultClass = !!st && (this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'results.manage') && this.inClassScope(a, st.class_id)));
        const teacherUploadAllowed = !!st && this.setting('teacher_upload_results') === '1' && a.classTeacherOf.has(st.class_id);
        if (st && !canManageResultClass && !teacherUploadAllowed) fail(403, 'You cannot upload results for this class');
        if (!st && !(this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'results.manage') && a.scopeAll))) {
          out.push({ file: file.name, ok: false, error: 'No student with this registration number in your assigned results scope' }); continue;
        }
        const key = await this.putFile(ctx, a, file, 'results', 10);
        const id = 'rs_' + rid(10);
        this.run('INSERT INTO results (id, student_id, session, title, file_key, file_name, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)', id, st?.id ?? null, session, title, key, file.name, a.key, now());
        out.push({ file: file.name, ok: !!st, id, student: st?.name, error: st ? undefined : 'Unmatched — assign it to a student' });
      }
      this.audit(a, 'results.upload', null, null, { title, count: out.length });
      return c.json({ results: out });
    });
    app.get('/results', (c) => {
      const a = c.get('actor'); if (a.type !== 'staff') fail(403, 'No access');
      const [w, p] = this.studentScope(a, 's');
      const rows = this.q(`SELECT r.id, r.title, r.session, r.file_name, r.published_at, r.created_at, r.student_id, s.name AS student_name, s.reg_no, c.name AS class_name, c.id AS class_id
        FROM results r LEFT JOIN students s ON s.id=r.student_id LEFT JOIN classes c ON c.id=s.class_id WHERE r.deleted_at IS NULL AND (r.student_id IS NULL OR ${w}) ORDER BY r.created_at DESC LIMIT 1000`, ...p);
      const canAssignUnmatched = this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'results.manage') && a.scopeAll);
      return c.json(rows.filter((r) => !!r.student_id || canAssignUnmatched));
    });
    app.post('/results/:id/assign', async (c) => {
      const a = c.get('actor');
      const result = this.one('SELECT * FROM results WHERE id=? AND deleted_at IS NULL', c.req.param('id'));
      if (!result || result.student_id) return fail(404, 'Unassigned result not found');
      const { student_id, confirm } = await c.req.json<any>();
      const student = this.student(a, student_id);
      if (!(this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'results.manage') && this.inClassScope(a, student.class_id)))) fail(403, 'Results management is not assigned for this class');
      if (confirm !== true) fail(400, 'Confirm assigning this result PDF to the selected student');
      this.run('UPDATE results SET student_id=? WHERE id=?', student_id, result.id);
      this.audit(a, 'result.assign', 'student', student_id, { result_id:result.id, title:result.title });
      return c.json({ ok: true });
    });
    app.post('/results/publish', async (c) => {
      const a = c.get('actor');
      const { class_id, title, confirm } = await c.req.json<any>();
      if (!(this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'results.manage') && this.inClassScope(a, class_id)))) fail(403, 'Results publishing permission is required for this class');
      if (confirm !== true) fail(400, 'Review the result title and class, then confirm publishing to parents');
      this.classOf(a, class_id);
      const rows = this.q('SELECT r.* FROM results r JOIN students s ON s.id=r.student_id WHERE r.published_at IS NULL AND r.deleted_at IS NULL AND s.class_id=? AND r.title=?', class_id, title);
      for (const r of rows) { this.run('UPDATE results SET published_at=? WHERE id=?', now(), r.id); this.notifyParentOf(r.student_id, 'Result published', `${r.title} is now available.`); }
      this.audit(a, 'results.publish', 'class', class_id, { title, count: rows.length });
      return c.json({ published: rows.length });
    });
    app.delete('/results/:id', (c) => {
      const a = c.get('actor');
      const r = this.one('SELECT * FROM results WHERE id=? AND deleted_at IS NULL', c.req.param('id')); if (!r) fail(404, 'Not found');
      const rclass = r!.student_id ? this.one('SELECT class_id FROM students WHERE id=?', r!.student_id)?.class_id : null;
      const canManageResult = this.isFullAdmin(a) || (a.role === 'subadmin' && this.hasPermission(a, 'results.manage') && !!rclass && this.inClassScope(a, rclass));
      if (!(canManageResult || (r!.uploaded_by === a.key && !r!.published_at))) fail(403, 'You cannot delete this result');
      if (c.req.query('confirm') !== '1') fail(400, 'Confirm removal of this result PDF');
      this.run('UPDATE results SET deleted_at=? WHERE id=?', now(), r!.id);
      this.run('UPDATE files SET deleted_at=? WHERE key=?', now(), r!.file_key);
      this.audit(a, 'result.delete', 'student', r!.student_id, r!.title);
      return c.json({ ok: true });
    });

    // Files are never public: every download is permission-checked.
    app.get('/files/:kind/:name', async (c) => {
      const a = c.get('actor');
      const key = `${c.get('ctx').schoolId}/${c.req.param('kind')}/${c.req.param('name')}`;
      const kind = c.req.param('kind');
      if (kind === 'slips') {
        const p = this.one('SELECT * FROM payments WHERE slip_key=?', key); if (!p) fail(404, 'Not found');
        this.student(a, p!.student_id, 'fees');
      } else if (kind === 'results') {
        const r = this.one('SELECT * FROM results WHERE file_key=? AND deleted_at IS NULL', key); if (!r) fail(404, 'Not found');
        if (r!.student_id) this.student(a, r!.student_id); else this.requireAdmin(a);
        if (a.type === 'guardian' && !r!.published_at) fail(404, 'Not found');
      } else fail(404, 'Not found');
      const o = await this.env.FILES.get(key); if (!o) fail(404, 'File missing');
      this.audit(a, 'file.download', kind, key);
      const storedType = String(o!.httpMetadata?.contentType || '').split(';')[0].trim().toLowerCase();
      const safeType = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(storedType) ? storedType : 'application/octet-stream';
      const safeName = String(c.req.param('name') || 'download').replace(/[^\w.-]/g, '_').slice(0, 100);
      return new Response(o!.body, { headers: {
        'content-type': safeType, 'content-disposition': `inline; filename="${safeName}"`,
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store, private',
      } });
    });

    app.get('/result-file/:id', async (c) => {
      const a = c.get('actor');
      const r = this.one('SELECT * FROM results WHERE id=? AND deleted_at IS NULL', c.req.param('id')); if (!r) fail(404, 'Not found');
      if (r!.student_id) this.student(a, r!.student_id); else this.requireAdmin(a);
      if (a.type === 'guardian' && !r!.published_at) fail(404, 'Not found');
      const o = await this.env.FILES.get(r!.file_key); if (!o) fail(404, 'File missing');
      return new Response(o!.body, { headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${String(r!.file_name || 'result.pdf').replace(/[^\w.-]/g, '_').slice(0, 100)}"`,
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store, private',
      } });
    });

    // ----- phone outbox: admin sends from own WhatsApp / SMS -----
    const outboxAccess = (a: Actor) => { if (!(this.isFullAdmin(a) || a.subrole === 'office')) fail(403, 'Only admins can send phone messages'); };
    app.get('/outbox', (c) => {
      outboxAccess(c.get('actor'));
      const status = c.req.query('status') === 'sent' ? 'sent' : 'pending';
      return c.json(this.q(`SELECT * FROM phone_outbox WHERE status=? ORDER BY created_at ${status === 'sent' ? 'DESC' : 'ASC'} LIMIT 500`, status));
    });
    app.post('/outbox/mark', async (c) => {
      const a = c.get('actor'); outboxAccess(a);
      const b = await c.req.json<any>();
      const st = b.status === 'skipped' ? 'skipped' : 'sent';
      for (const id of (b.ids || []).slice(0, 500)) this.run("UPDATE phone_outbox SET status=?, sent_at=?, sent_by=?, channel=? WHERE id=? AND status='pending'", st, now(), a.key, b.channel || null, id);
      return c.json({ ok: true });
    });
    app.post('/outbox/compose', async (c) => {
      const a = c.get('actor'); outboxAccess(a);
      const b = await c.req.json<any>();
      if (!b.text) fail(400, 'Write a message');
      const keys = new Set<string>();
      if (b.to === 'parents' || b.to === 'all') for (const g of this.q("SELECT DISTINCT guardian_id FROM students WHERE status='active'" + (b.class_id ? ' AND class_id=?' : ''), ...(b.class_id ? [b.class_id] : []))) keys.add('g:' + g.guardian_id);
      if (b.to === 'teachers' || b.to === 'all') for (const s of this.q("SELECT id FROM staff WHERE active=1 AND role='teacher'")) keys.add('s:' + s.id);
      const before = Number(this.one("SELECT COUNT(*) AS n FROM phone_outbox WHERE status='pending'")!.n);
      for (const k of keys) this.queuePhone(k, b.title || 'Message', b.text);
      return c.json({ queued: Number(this.one("SELECT COUNT(*) AS n FROM phone_outbox WHERE status='pending'")!.n) - before });
    });

    // ----- notifications -----
    app.get('/notifications', (c) => c.json(this.q('SELECT * FROM notifications WHERE user_key=? ORDER BY created_at DESC LIMIT 100', c.get('actor').key)));
    app.post('/notifications/read', (c) => { this.run('UPDATE notifications SET read_at=? WHERE user_key=? AND read_at IS NULL', now(), c.get('actor').key); return c.json({ ok: true }); });

    // ----- server-confirmed submission history -----
    app.get('/submissions', (c) => {
      const a = c.get('actor');
      const rows = this.isFullAdmin(a)
        ? this.q("SELECT id,user_key,user_name,method,path,label,status,http_status,created_at,updated_at FROM api_submissions WHERE status='saved' ORDER BY created_at DESC LIMIT 500")
        : this.q("SELECT id,user_key,user_name,method,path,label,status,http_status,created_at,updated_at FROM api_submissions WHERE user_key=? AND status='saved' ORDER BY created_at DESC LIMIT 200", a.key);
      return c.json(rows);
    });

    // ----- audit, storage, sessions & promotion -----
    app.get('/audit', (c) => { this.requireFullAdmin(c.get('actor')); return c.json(this.q('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 500')); });
    app.get('/storage', (c) => {
      this.requireFullAdmin(c.get('actor'));
      const active = Number(this.one('SELECT COALESCE(SUM(size),0) AS n FROM files WHERE deleted_at IS NULL')?.n || 0);
      const trash = Number(this.one('SELECT COALESCE(SUM(size),0) AS n FROM files WHERE deleted_at IS NOT NULL')?.n || 0);
      const pending = Number(this.one('SELECT COALESCE(SUM(size),0) AS n FROM file_upload_reservations')?.n || 0);
      return c.json({
        used: active + trash + pending, active, trash, pending, limit: c.get('ctx').storageLimitBytes,
        byKind: this.q('SELECT kind, SUM(size) AS bytes, COUNT(*) AS n FROM files GROUP BY kind'),
        byUser: this.q('SELECT uploaded_by, SUM(size) AS bytes FROM files WHERE deleted_at IS NULL GROUP BY uploaded_by ORDER BY bytes DESC LIMIT 20'),
      });
    });
    app.get('/sessions', (c) => c.json(this.q('SELECT * FROM academic_sessions ORDER BY created_at DESC')));
    app.post('/promotion', async (c) => {
      const a = c.get('actor'); this.requireMain(a);
      const b = await c.req.json<any>();
      if (b.confirm !== true) fail(400, 'Review the new session and every promotion decision, then confirm');
      if (!b.new_session) fail(400, 'Name the new session, e.g. 2027-2028');
      const old = this.currentSession();
      const decisions: Record<string, { outcome: string; class_id?: string }> = b.decisions || {};
      const nextClass: Record<string, string> = b.next_class || {};
      const validClasses = new Set(this.q('SELECT id FROM classes WHERE active=1').map((r) => r.id));
      for (const target of Object.values(nextClass)) if (target !== 'passout' && !validClasses.has(target)) fail(400, 'One of the class-wide promotion destinations is no longer active');
      const activeStudents = this.q("SELECT id,class_id FROM students WHERE status='active'");
      const activeStudentIds = new Set(activeStudents.map((s) => s.id));
      for (const [studentId, decision] of Object.entries(decisions)) {
        if (!activeStudentIds.has(studentId)) fail(400, 'A selected student is no longer active. Refresh the promotion review.');
        if (!['promoted','not promoted','left','passed out'].includes(decision.outcome)) fail(400, 'Invalid student promotion decision');
        if (decision.class_id && !validClasses.has(decision.class_id)) fail(400, 'A selected student destination class is no longer active');
      }
      if (this.one('SELECT 1 FROM academic_sessions WHERE name=?', String(b.new_session).trim())) fail(409, 'An academic session with this name already exists');
      const sid = 'ses_' + rid(8);
      const today = pkt().date;
      const gids = new Set<string>();
      const counts: Row = { promoted: 0, 'not promoted': 0, left: 0, 'passed out': 0 };
      this.tx(() => {
        this.run('UPDATE enrollments SET to_date=?,class_name_snapshot=COALESCE(class_name_snapshot,(SELECT name FROM classes WHERE id=enrollments.class_id)) WHERE session_id=? AND to_date IS NULL', today, old.id);
        this.run('UPDATE academic_sessions SET current=0, locked=1 WHERE id=?', old.id);
        this.run('INSERT INTO academic_sessions (id, name, current, created_at) VALUES (?,?,1,?)', sid, b.new_session, now());
        for (const s of this.q("SELECT * FROM students WHERE status='active'")) {
          const d = decisions[s.id] || { outcome: nextClass[s.class_id] === 'passout' ? 'passed out' : 'promoted' };
          let target: string = s.class_id;
          if (d.outcome === 'promoted') target = d.class_id || nextClass[s.class_id] || s.class_id;
          if (d.outcome === 'promoted' && target === 'passout') d.outcome = 'passed out';
          if (d.outcome === 'not promoted') target = s.class_id;
          if (d.outcome === 'promoted' && !validClasses.has(target)) fail(400, 'A student destination class is no longer active');
          this.run('UPDATE enrollments SET outcome=? WHERE student_id=? AND session_id=?', d.outcome, s.id, old.id);
          if (d.outcome === 'left' || d.outcome === 'passed out') {
            this.run("UPDATE students SET status='left', left_date=?, left_reason=? WHERE id=?", today, d.outcome, s.id); gids.add(s.guardian_id);
          } else {
            this.run('UPDATE students SET class_id=? WHERE id=?', target, s.id);
            this.run('INSERT INTO enrollments (id, student_id, class_id, session_id, from_date) VALUES (?,?,?,?,?)', rid(12), s.id, target, sid, today);
          }
          counts[d.outcome] = (counts[d.outcome] || 0) + 1;
        }
      });
      for (const g of gids) await this.syncGuardian(g);
      this.audit(a, 'promotion', null, null, { from: old.name, to: b.new_session, counts });
      return c.json({ ok: true, counts });
    });

    app.get('/export', (c) => {
      this.requireMain(c.get('actor'));
      const tables = this.q("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").map((r) => r.name);
      const out: Row = { exported_at: now() };
      for (const t of tables) out[t] = this.q(`SELECT * FROM "${t}"`);
      this.audit(c.get('actor'), 'export', null, null);
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="school-backup-${pkt().date}.json"` } });
    });

    app.all('*', (c) => c.json({ error: 'Not found' }, 404));
    return app;
  }

  canDeleteNotice(a: Actor, n: Row): boolean {
    if (this.isFullAdmin(a)) return true;
    if (n.audience !== 'class') return false;
    const classId = String(n.target_id || '');
    if (a.classTeacherOf.has(classId)) return true;
    if (a.role === 'subadmin' && this.hasPermission(a, 'notices.manage') && this.inClassScope(a, classId)) return true;
    return false;
  }

  noticesFor(a: Actor, onlyStudent?: string): Row[] {
    let rows = this.q('SELECT * FROM notices WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 300');
    const kids = a.type === 'guardian' ? this.q('SELECT id, class_id FROM students WHERE id IN (' + a.children.map(() => '?').join(',') + ')', ...a.children) : [];
    rows = rows.filter((n) => {
      if (onlyStudent) {
        const s = this.one('SELECT class_id FROM students WHERE id=?', onlyStudent);
        return n.audience === 'school' || (n.audience === 'class' && n.target_id === s?.class_id) || (n.audience === 'student' && n.target_id === onlyStudent);
      }
      if (this.isFullAdmin(a)) return true;
      if (a.type === 'guardian') return n.audience === 'school' || (n.audience === 'class' && kids.some((k) => k.class_id === n.target_id)) || (n.audience === 'student' && a.children.includes(n.target_id));
      if (a.role === 'subadmin') {
        const canSchool = this.hasPermission(a, 'notices.manage') && a.scopeAll;
        if (n.audience === 'admins') return a.isMain;
        if (n.audience === 'school' || n.audience === 'teachers') return canSchool;
        if (n.audience === 'class') return (this.hasPermission(a, 'notices.manage') && this.inClassScope(a, n.target_id)) || a.teaches.has(n.target_id);
        if (n.audience === 'student') {
          const st = this.one('SELECT class_id FROM students WHERE id=?', n.target_id);
          return !!st && ((this.hasPermission(a, 'notices.manage') && this.inClassScope(a, st.class_id)) || a.teaches.has(st.class_id));
        }
        return false;
      }
      return n.audience === 'school' || n.audience === 'teachers' || (n.audience === 'class' && a.teaches.has(n.target_id)) || (n.audience === 'student' && (() => { const s = this.one('SELECT class_id FROM students WHERE id=?', n.target_id); return !!s && a.teaches.has(s.class_id); })());
    });
    const reads = this.isAdmin(a);
    return rows.map((n) => ({ ...n, can_delete: this.canDeleteNotice(a, n), read_count: reads ? Number(this.one('SELECT COUNT(*) AS n FROM notice_reads WHERE notice_id=?', n.id)!.n) : undefined,
      target_name: n.audience === 'class' ? this.one('SELECT name FROM classes WHERE id=?', n.target_id)?.name : n.audience === 'student' ? this.one('SELECT name FROM students WHERE id=?', n.target_id)?.name : null }));
  }

  replaceTeacherProfile(a: Actor, old: Row, next: { name: string; email: string; phone: string | null; subjects: string | null }, effective: string,
    move: { classIds: string[]; subjectIds: string[] }): string {
    this.requireMain(a);
    const newId = 'tch_' + rid(12);
    const endDate = addDays(effective, -1);
    const classIds = new Set(move.classIds);
    const subjectIds = new Set(move.subjectIds);
    this.tx(() => {
      this.run(`INSERT INTO staff (id, public_id, name, email, phone, role, subjects, search_key, created_at)
        VALUES (?, lower(hex(randomblob(16))), ?, ?, ?, 'teacher', ?, ?, ?)`,
        newId, next.name, next.email, next.phone, next.subjects, skeleton(next.name), now());

      const classes = this.q('SELECT id FROM classes WHERE class_teacher_id=? AND active=1', old.id);
      for (const cl of classes) {
        this.run('UPDATE class_teacher_assignments SET to_date=? WHERE class_id=? AND teacher_id=? AND to_date IS NULL', endDate, cl.id, old.id);
        if (classIds.has(cl.id)) {
          this.run('INSERT INTO class_teacher_assignments VALUES (?,?,?,?,NULL)', rid(10), cl.id, newId, effective);
          this.run('UPDATE classes SET class_teacher_id=? WHERE id=? AND class_teacher_id=?', newId, cl.id, old.id);
        } else {
          this.run('UPDATE classes SET class_teacher_id=NULL WHERE id=? AND class_teacher_id=?', cl.id, old.id);
        }
      }

      const subjects = this.q(`SELECT DISTINCT cs.id, cs.class_id, cs.subject
        FROM class_subject_teacher_assignments a
        JOIN class_subjects cs ON cs.id=a.class_subject_id
        WHERE a.teacher_id=? AND (a.to_date IS NULL OR a.to_date>=?)`, old.id, effective);
      for (const sub of subjects) {
        const assignments = this.q('SELECT id, from_date FROM class_subject_teacher_assignments WHERE class_subject_id=? AND teacher_id=? AND (to_date IS NULL OR to_date>=?)', sub.id, old.id, effective);
        for (const assignment of assignments) {
          // Future assignments are ended the day before they were due to start.
          const handoverDate = assignment.from_date > effective ? assignment.from_date : effective;
          const assignmentEnd = addDays(handoverDate, -1);
          this.run('UPDATE class_subject_teacher_assignments SET to_date=? WHERE id=?', assignmentEnd, assignment.id);
          this.run('UPDATE class_subject_history SET to_date=? WHERE class_id=? AND subject=? AND teacher_id=? AND (to_date IS NULL OR to_date>=?)',
            assignmentEnd, sub.class_id, sub.subject, old.id, effective);
          if (subjectIds.has(sub.id)) {
            const alreadyAssigned = this.one('SELECT 1 FROM class_subject_teacher_assignments WHERE class_subject_id=? AND teacher_id=? AND from_date<=? AND (to_date IS NULL OR to_date>=?) LIMIT 1',
              sub.id, newId, handoverDate, handoverDate);
            if (!alreadyAssigned) {
              this.run('INSERT INTO class_subject_teacher_assignments (id,class_subject_id,teacher_id,from_date,changed_by,created_at) VALUES (?,?,?,?,?,?)',
                'csta_' + rid(10), sub.id, newId, handoverDate, a.key, now());
              this.run('INSERT INTO class_subject_history (id,class_id,subject,teacher_id,from_date,changed_by) VALUES (?,?,?,?,?,?)',
                rid(10), sub.class_id, sub.subject, newId, handoverDate, a.key);
            }
          }
        }
        const nextPrimary = this.one(`SELECT teacher_id FROM class_subject_teacher_assignments
          WHERE class_subject_id=? AND from_date<=? AND (to_date IS NULL OR to_date>=?) ORDER BY from_date DESC LIMIT 1`, sub.id, effective, effective);
        this.run('UPDATE class_subjects SET teacher_id=? WHERE id=? AND teacher_id=?', nextPrimary?.teacher_id || null, sub.id, old.id);
      }

      this.run('UPDATE staff SET active=0, left_at=?, left_reason=? WHERE id=?',
        effective, 'Replaced by ' + next.name, old.id);
    });
    const assignedClasses = this.q('SELECT name FROM classes WHERE class_teacher_id=? AND active=1', newId).map((r) => r.name);
    if (assignedClasses.length) this.notify('s:' + newId, 'Teaching assignments transferred', 'You are now assigned to: ' + assignedClasses.join(', '));
    this.notify('s:' + old.id, 'Teacher account replaced', 'Your institution account has been replaced. Contact the Main Admin if you believe this is an error.');
    return newId;
  }

  replaceTeacher(a: Actor, classId: string, teacherId: string | null, from: string, subjectsToo = false) {
    const cl = this.one('SELECT * FROM classes WHERE id=?', classId); if (!cl) fail(404, 'Class not found');
    if (teacherId && !this.one("SELECT 1 FROM staff WHERE id=? AND role='teacher' AND active=1", teacherId)) fail(400, 'Choose an active teacher account');
    const oldTeacherId = cl!.class_teacher_id;
    const movedSubjects = subjectsToo && oldTeacherId && teacherId
      ? this.q(`SELECT a.id AS assignment_id, cs.id, cs.subject, a.from_date FROM class_subject_teacher_assignments a
        JOIN class_subjects cs ON cs.id=a.class_subject_id
        WHERE cs.class_id=? AND a.teacher_id=? AND (a.to_date IS NULL OR a.to_date>=?)`, classId, oldTeacherId, from) : [];
    this.tx(() => {
      this.run('UPDATE class_teacher_assignments SET to_date=? WHERE class_id=? AND to_date IS NULL', addDays(from, -1), classId);
      if (teacherId) this.run('INSERT INTO class_teacher_assignments VALUES (?,?,?,?,NULL)', rid(10), classId, teacherId, from);
      for (const sub of movedSubjects) {
        const handoverDate = sub.from_date > from ? sub.from_date : from;
        const endDate = addDays(handoverDate, -1);
        this.run('UPDATE class_subject_teacher_assignments SET to_date=? WHERE id=?', endDate, sub.assignment_id);
        this.run('UPDATE class_subject_history SET to_date=? WHERE class_id=? AND subject=? AND teacher_id=? AND (to_date IS NULL OR to_date>=?)',
          endDate, classId, sub.subject, oldTeacherId, from);
        const alreadyAssigned = this.one('SELECT 1 FROM class_subject_teacher_assignments WHERE class_subject_id=? AND teacher_id=? AND from_date<=? AND (to_date IS NULL OR to_date>=?) LIMIT 1',
          sub.id, teacherId, handoverDate, handoverDate);
        if (!alreadyAssigned) {
          this.run('INSERT INTO class_subject_teacher_assignments (id,class_subject_id,teacher_id,from_date,changed_by,created_at) VALUES (?,?,?,?,?,?)',
            'csta_' + rid(10), sub.id, teacherId, handoverDate, a.key, now());
          this.run('INSERT INTO class_subject_history (id,class_id,subject,teacher_id,from_date,changed_by) VALUES (?,?,?,?,?,?)',
            rid(10), classId, sub.subject, teacherId, handoverDate, a.key);
        }
        const primary = this.one('SELECT teacher_id FROM class_subject_teacher_assignments WHERE class_subject_id=? AND from_date<=? AND (to_date IS NULL OR to_date>=?) ORDER BY from_date DESC LIMIT 1',
          sub.id, from, from);
        this.run('UPDATE class_subjects SET teacher_id=? WHERE id=? AND teacher_id=?', primary?.teacher_id || null, sub.id, oldTeacherId);
      }
      this.run('UPDATE classes SET class_teacher_id=? WHERE id=?', teacherId, classId);
    });
    this.audit(a, 'class.replace_teacher', 'class', classId, { old: oldTeacherId, new: teacherId, from, subjectsToo, subjectAssignmentsTransferred: movedSubjects.length });
    if (teacherId) this.notify('s:' + teacherId, 'Class assigned', 'You are now the class teacher of ' + cl!.name + ' from ' + from + '.');
  }
}
