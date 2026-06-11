// routes/employeeRoutes.js — Employee CRUD with safe populate
//
// In addition to the local HRMS MongoDB write, every create/update/delete is
// MIRRORED to the Tesco ERM mobile backend so the employee can log into the
// mobile app with the SAME email + password they were given here. This makes
// the HRMS Employees section the single source of truth — replaces the old
// standalone admin.html file.

const express     = require('express');
const router      = express.Router();
const mongoose    = require('mongoose');
const Employee    = require('../models/Employee');
const Department  = require('../models/Department');
const Designation = require('../models/Designation');
const AccessRole  = require('../models/AccessRole');
const { importMobileUsers } = require('../migrations/importFromMobile');
const { requireAdmin } = require('../middleware/authMiddleware');

const isObjectId = v => v && mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;

// ─── Mirror to mobile backend ──────────────────────────────────────────
const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-9rtc.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET =  process.env.MOBILE_ADMIN_SECRET || '';

/**
 * Mirror a write to the mobile backend AND report the result. Awaits the
 * response (30s timeout — covers Render cold start) so the HRMS POST/PUT/
 * DELETE handlers can include `mobileSync` in their response — the admin
 * sees right away whether the mobile account was actually created.
 *
 * Returns: { ok, status, message, skipped? }
 */
async function mirrorToMobile(method, path, body) {
  if (!ADMIN_SECRET) {
    const msg = 'Skipped — MOBILE_ADMIN_SECRET is not set in HRMS .env. Employee will NOT be able to log into mobile until you set this env var and restart.';
    console.warn(`[employee mirror] ${msg}: ${method} ${path}`);
    return { ok: false, status: 0, message: msg, skipped: true };
  }
  if (typeof fetch !== 'function') {
    const msg = 'Skipped — Node 18+ required (global fetch unavailable).';
    console.warn(`[employee mirror] ${msg}: ${method} ${path}`);
    return { ok: false, status: 0, message: msg, skipped: true };
  }

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(MOBILE_API + path, {
      method,
      headers: {
        'Content-Type':   'application/json',
        'x-admin-secret': ADMIN_SECRET,
      },
      body:   body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const t = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = JSON.parse(t); } catch { /* not JSON */ }
    const msg = parsed?.message || t.slice(0, 200) || `HTTP ${res.status}`;
    if (res.ok) {
      console.log(`[employee mirror] ✓ ${method} ${path} (${res.status})`);
    } else {
      console.warn(`[employee mirror] ✗ ${method} ${path} → ${res.status} ${msg}`);
    }
    return { ok: res.ok, status: res.status, message: msg };
  } catch (err) {
    console.warn(`[employee mirror] ✗ ${method} ${path} failed: ${err.message}`);
    return { ok: false, status: 0, message: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the body the mobile backend's POST/PATCH /admin/users expects from
 * an HRMS Employee record + the original request body (to surface the
 * plain-text password the model has already hashed away).
 */
function mobilePayloadFromHrms(employee, originalBody, designationTitle) {
  const fullName = `${employee.firstName} ${employee.lastName}`.trim();
  const flatAddress = employee.address
    ? [employee.address.street, employee.address.city, employee.address.state,
       employee.address.zipCode, employee.address.country]
      .filter(Boolean).join(', ')
    : '';
  const payload = {
    userId:      employee.employeeId,
    name:        fullName || employee.username || 'Employee',
    email:       (employee.email || '').toLowerCase(),
    phone:       employee.phone || '',
    role:        'employee',
    designation: designationTitle || originalBody?.designation || '',
    status:      (employee.status === 'Active') ? 'Active' : 'Inactive',
    workType:    originalBody?.workType || 'Office',
    address:     flatAddress,
    photoUrl:    originalBody?.photoUrl || '',
  };
  ['dob', 'gender', 'bloodGroup'].forEach((k) => {
    if (originalBody?.[k] !== undefined) payload[k] = originalBody[k];
  });
  return payload;
}

// Safely resolve dept/desig/role from either ObjectId or plain string.
// If the value is an ObjectId but the referenced row was deleted, fall back
// to '—' (NOT the raw ObjectId string — that leaked through the UI before).
const resolveEmployee = (e, deptMap, desigMap, roleMap) => ({
  ...e,
  department:  isObjectId(e.department)
    ? (deptMap[String(e.department)]   || { name: '—' })
    : { name: String(e.department || '—') },
  designation: isObjectId(e.designation)
    ? (desigMap[String(e.designation)] || { title: '—' })
    : { title: String(e.designation || '—') },
  accessRole:  isObjectId(e.accessRole)
    ? (roleMap[String(e.accessRole)]   || { name: '—' })
    : { name: String(e.accessRole || '—') },
});

const loadLookupMaps = async () => {
  const [depts, desigs, roles] = await Promise.all([
    Department.find({}).lean(),
    Designation.find({}).lean(),
    AccessRole.find({}).lean(),
  ]);
  const deptMap  = Object.fromEntries(depts.map(d  => [String(d._id), d]));
  const desigMap = Object.fromEntries(desigs.map(d => [String(d._id), d]));
  const roleMap  = Object.fromEntries(roles.map(r  => [String(r._id), r]));
  return { deptMap, desigMap, roleMap, depts, desigs };
};

// ════════════════════════════════════════════════════════════════════════
// IMPORTANT — ROUTE ORDER NOTE
//
// Express matches routes top-to-bottom. Any STATIC path that LOOKS like an
// id (no slash, single segment) MUST be declared BEFORE the parametric
// /:id route, otherwise Express will treat the literal path as an
// ObjectId and return "Invalid employee id". So /latest, /mobile-sync-status,
// /import-from-mobile all come BEFORE GET /:id below.
// ════════════════════════════════════════════════════════════════════════

// ── GET /api/employees — list ───────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)   || 1);
    const limit  = Math.min(200, parseInt(req.query.limit) || 20);
    const skip   = (page - 1) * limit;
    const search = req.query.search;

    const filter = { isActive: { $ne: false }, status: { $ne: "Terminated" } };
    if (search) {
      filter.$or = [
        { firstName:  { $regex: search, $options: 'i' } },
        { lastName:   { $regex: search, $options: 'i' } },
        { email:      { $regex: search, $options: 'i' } },
        { employeeId: { $regex: search, $options: 'i' } },
      ];
    }

    const [total, rawEmployees] = await Promise.all([
      Employee.countDocuments(filter),
      Employee.find(filter).lean().sort({ createdAt: -1 }).skip(skip).limit(limit),
    ]);

    const { deptMap, desigMap, roleMap } = await loadLookupMaps();
    const employees = rawEmployees.map(e => resolveEmployee(e, deptMap, desigMap, roleMap));

    return res.status(200).json({ success: true, total, page, pages: Math.ceil(total / limit), employees });
  } catch (err) {
    console.error('[EMPLOYEE] List error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/employees/latest ───────────────────────────────────
router.get('/latest', async (req, res) => {
  try {
    const emp = await Employee.findOne().lean().sort({ createdAt: -1 });
    if (!emp) return res.status(404).json({ success: false, message: 'No employees yet' });
    return res.status(200).json({ success: true, employee: emp });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/employees/mobile-sync-status ──────────────────────
// Diagnostic — shows whether the HRMS backend can talk to the mobile
// backend's admin API. Useful when an employee says "Invalid credentials"
// after admin created their account.
router.get('/mobile-sync-status', async (req, res) => {
  const out = {
    mobileApiUrl: MOBILE_API,
    configured:   !!ADMIN_SECRET,
    reachable:    false,
    error:        null,
    mobileVersion: null,
    userCount:     null,
  };
  if (!ADMIN_SECRET) {
    out.error = 'MOBILE_ADMIN_SECRET is missing in HRMS .env. Add it and restart the HRMS backend.';
    return res.status(503).json(out);
  }
  try {
    const vr = await fetch(`${MOBILE_API}/api/auth/version`);
    if (vr.ok) {
      const v = await vr.json().catch(() => ({}));
      out.mobileVersion = v.version || 'unknown';
    }
    const ur = await fetch(`${MOBILE_API}/api/auth/admin/users?limit=1`, {
      headers: { 'x-admin-secret': ADMIN_SECRET },
    });
    if (ur.status === 401) {
      out.error = 'Mobile backend rejected MOBILE_ADMIN_SECRET — value is wrong. Check it matches the ADMIN_SECRET env var on Render.';
      return res.status(401).json(out);
    }
    if (!ur.ok) {
      out.error = `Mobile backend returned ${ur.status}`;
      return res.status(502).json(out);
    }
    const ud = await ur.json().catch(() => ({}));
    out.reachable = true;
    out.userCount = ud.total ?? null;
    return res.json(out);
  } catch (err) {
    out.error = err.message;
    return res.status(502).json(out);
  }
});

// ── POST /api/employees/import-from-mobile ───────────────────────
// Manual trigger for the migration that also runs automatically on startup.
router.post('/import-from-mobile', async (req, res) => {
  try {
    const result = await importMobileUsers();
    return res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    console.error('[IMPORT route] error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/employees/test-mobile-login ────────────────────────
//
// Diagnostic — given an email + password, actually attempts to log into
// the MOBILE backend (the exact same endpoint the mobile app hits) and
// reports back what the mobile server said. This lets us prove whether
// the mobile User record exists and the password matches, independent of
// the mobile app UI.
//
// Usage from any browser console or curl:
//   curl -X POST http://localhost:8001/api/employees/test-mobile-login \
//        -H "Content-Type: application/json" \
//        -d '{"email":"jane@example.com","password":"TheirPassword"}'
//
// Returns one of:
//   { ok: true,  loginStatus: 200, message: "Login works.", user: {...} }
//   { ok: false, loginStatus: 401, message: "Invalid credentials" }
//   { ok: false, mobileUserFound: false, message: "No mobile user with that email" }
router.post('/test-mobile-login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Provide { email, password }' });
  }
  if (!ADMIN_SECRET) {
    return res.status(503).json({ ok: false, message: 'MOBILE_ADMIN_SECRET not set on HRMS .env' });
  }

  try {
    // 1) Look up the user on the mobile backend via admin API.
    const lookup = await fetch(
      `${MOBILE_API}/api/auth/admin/users?q=${encodeURIComponent(email)}`,
      { headers: { 'x-admin-secret': ADMIN_SECRET } }
    );
    const lookupData = await lookup.json().catch(() => ({}));
    const matches = Array.isArray(lookupData.users)
      ? lookupData.users.filter((u) =>
          (u.email || '').toLowerCase() === email.toLowerCase()
        )
      : [];
    const mobileUserFound = matches.length > 0;

    // 2) Hit the same login endpoint the mobile app uses.
    const loginRes = await fetch(`${MOBILE_API}/api/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId: email, password }),
    });
    const loginData = await loginRes.json().catch(() => ({}));

    return res.json({
      ok:                loginRes.ok,
      loginStatus:       loginRes.status,
      mobileUserFound,
      mobileUserMatches: matches.map((u) => ({
        userId:    u.userId,
        email:     u.email,
        name:      u.name,
        status:    u.status,
        createdAt: u.createdAt,
        // NOTE: the admin /users list endpoint strips the password hash for
        // security, so we genuinely can't tell from here whether a hash is
        // stored. If you want to verify, the login attempt below is the
        // definitive test — 401 with mobileUserFound:true means a hash
        // IS stored, it just doesn't match what you typed.
      })),
      message:           loginData.message || (loginRes.ok ? 'Login works.' : `HTTP ${loginRes.status}`),
      loginResponse:     loginRes.ok ? { token: '✓ received', user: loginData.user } : loginData,
    });
  } catch (err) {
    return res.status(502).json({
      ok:      false,
      message: 'Could not reach mobile backend: ' + err.message,
    });
  }
});

// ── GET /api/employees/:id ──────────────────────────────────────
// NOTE: must come AFTER /latest, /mobile-sync-status, /import-from-mobile.
router.get('/:id', async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id).lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const { deptMap, desigMap, roleMap } = await loadLookupMaps();
    return res.status(200).json({ success: true, employee: resolveEmployee(emp, deptMap, desigMap, roleMap) });
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid employee id' });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/employees — create ────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;

    // Helpful breadcrumb when a personal field unexpectedly arrives empty.
    // Prints a one-liner with the four fields HR cares about so a later
    // "why is dob empty in the db?" can be answered from the server log.
    console.log('[EMPLOYEE] POST body:', JSON.stringify({
      employeeId: b.employeeId,
      department: b.department,
      designation: b.designation,
      dob: b.dob, gender: b.gender, bloodGroup: b.bloodGroup,
    }));

    // Resolve department: accept ObjectId OR name string. Capture BOTH the
    // ObjectId (for relational integrity) and the original name string
    // (for direct readability on the doc, so the user no longer sees the
    // raw 24-char hex when they open the record in MongoDB).
    let deptId = null;
    let deptName = '';
    if (b.department) {
      if (isObjectId(b.department)) {
        deptId = b.department;
        const found = await Department.findById(b.department).lean().catch(() => null);
        deptName = found?.name || '';
      } else {
        deptName = String(b.department).trim();
        const dept = await Department.findOne({ name: { $regex: new RegExp(`^${deptName}$`, 'i') } }).lean();
        deptId = dept ? dept._id : null;
        if (!deptId) {
          const newDept = await Department.create({ name: deptName });
          deptId = newDept._id;
        }
      }
    }

    // Resolve designation: accept ObjectId OR title string.
    let desigId = null;
    let desigTitle = '';
    if (b.designation) {
      if (isObjectId(b.designation)) {
        desigId = b.designation;
        const found = await Designation.findById(b.designation).lean().catch(() => null);
        desigTitle = found?.title || '';
      } else {
        desigTitle = String(b.designation).trim();
        const desig = await Designation.findOne({ title: { $regex: new RegExp(`^${desigTitle}$`, 'i') } }).lean();
        desigId = desig ? desig._id : null;
        if (!desigId) {
          const newDesig = await Designation.create({ title: desigTitle, dept: deptName || 'General' });
          desigId = newDesig._id;
        }
      }
    }

    const payload = {
      firstName:      b.firstName,
      lastName:       b.lastName,
      username:       b.username,
      password:       b.password || 'password123',
      email:          b.email,
      phone:          b.phone,
      address:        b.address || { street: b.street || '', city: b.city || '', state: b.state || '', zipCode: b.zipCode || '', country: b.country || '' },
      employeeId:     b.employeeId,
      department:     deptId,
      designation:    desigId,
      // Denormalised readable copies — written to the employee doc so the
      // record shows the actual dept / role the admin typed in instead of
      // a bare ObjectId. Kept in sync on edits below.
      departmentName:   deptName,
      designationTitle: desigTitle,
      employmentType: b.employmentType || '',
      joiningDate:    b.joiningDate,
      salary:         Number(b.salary) || 0,
      assignedTo:     b.assignedTo,
      // Petrol allowance opt-in (Jun 2026). MUST be passed through to
      // the Employee doc so the mobile backend's auto-bill cron sees
      // the flag — without this the New Employee form's toggle was
      // silently dropped, which is why PETROL TEST never got a row in
      // the allowances collection even though HR ticked his box.
      ...(typeof b.petrolEligible === 'boolean' ? { petrolEligible: b.petrolEligible } : {}),
      education:      b.education || { degree: b.degree || '', university: b.university || '', fieldOfStudy: b.fieldOfStudy || '', graduationYear: Number(b.graduationYear) || 2020 },
      // Personal fields — sent by the HRMS New Employee form, kept on the
      // employee record so the mobile profile screen can render them
      // (DOB / Gender / Blood Group). Without this they were silently
      // dropped and the mobile app rendered "Not set".
      dob:            (b.dob        || '').toString().trim(),
      gender:         (b.gender     || '').toString().trim(),
      bloodGroup:     (b.bloodGroup || '').toString().trim(),
      status:         b.status || 'Active',
      isActive:       true,
    };

    const employee = await Employee.create(payload);
    console.log(`[EMPLOYEE] Created: ${employee.employeeId} — ${employee.firstName} ${employee.lastName}`);

    // Mirror to mobile backend — AWAITED so we can report success/failure.
    let designationTitle = '';
    if (desigId) {
      try {
        const d = await Designation.findById(desigId).lean();
        if (d) designationTitle = d.title || '';
      } catch { /* non-fatal */ }
    } else if (b.designation && typeof b.designation === 'string') {
      designationTitle = b.designation;
    }
    // ─── UNIFIED DB ─────────────────────────────────────────────────
    // HRMS and Mobile now share the SAME `employees` collection in the
    // SAME database. The Employee.create() above already wrote the row
    // (with hashed password via the Employee pre-save hook). The mobile
    // app reads that exact row via its own User model (collection:
    // 'employees'), so the employee can log in immediately. No mirror
    // call needed — and the old mirror would have failed with a
    // duplicate-key 409 anyway.
    return res.status(201).json({
      success: true,
      message: 'Employee created. They can log into the mobile app with the same email + password.',
      data:    employee.toSafeObject(),
    });
  } catch (err) {
    console.error('[EMPLOYEE] Create error:', err.message);
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, message: 'Validation failed: ' + Object.values(err.errors).map(e => e.message).join(', ') });
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      return res.status(400).json({ success: false, message: `${field} already exists. Please use a different value.` });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/employees/:id — update ────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const bcrypt  = require('bcryptjs');
    const payload = { ...req.body };
    const newPasswordFromBody = req.body?.password;
    delete payload.password;
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    // accessRole on the Employee model is an ObjectId ref. The frontend
    // 'Convert to Manager' toggle used to send the string 'Manager' for
    // this field, which made Mongoose throw a CastError that surfaced
    // as a confusing 'Invalid employee id' to HR. Strip the field unless
    // it's a valid 24-char ObjectId; the role string field is the
    // canonical manager / employee flag now.
    if (payload.accessRole !== undefined && !isObjectId(String(payload.accessRole))) {
      delete payload.accessRole;
    }
    if (payload.role !== undefined) {
      const r = String(payload.role).toLowerCase().trim();
      payload.role = ['employee', 'manager', 'hr', 'admin'].includes(r) ? r : 'employee';
    }

    // If admin entered a new password in the edit form, hash and include
    // it in the update. findByIdAndUpdate skips the pre-save hook so we
    // must hash here. Unified-DB means this row IS what the mobile app
    // reads on login — one update, both sides see it.
    if (newPasswordFromBody && String(newPasswordFromBody).length >= 6) {
      payload.password = await bcrypt.hash(String(newPasswordFromBody), 10);
    }

    // Resolve department / designation strings → ObjectId, AND keep the
    // readable name in lockstep so the doc always shows both.
    if (payload.department != null) {
      if (isObjectId(payload.department)) {
        const found = await Department.findById(payload.department).lean().catch(() => null);
        if (found) payload.departmentName = found.name || '';
      } else if (typeof payload.department === 'string' && payload.department.trim()) {
        const name = payload.department.trim();
        let dept = await Department.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } }).lean();
        if (!dept) dept = await Department.create({ name });
        payload.department     = dept._id;
        payload.departmentName = name;
      }
    }
    if (payload.designation != null) {
      if (isObjectId(payload.designation)) {
        const found = await Designation.findById(payload.designation).lean().catch(() => null);
        if (found) payload.designationTitle = found.title || '';
      } else if (typeof payload.designation === 'string' && payload.designation.trim()) {
        const title = payload.designation.trim();
        let desig = await Designation.findOne({ title: { $regex: new RegExp(`^${title}$`, 'i') } }).lean();
        if (!desig) desig = await Designation.create({ title, dept: payload.departmentName || 'General' });
        payload.designation      = desig._id;
        payload.designationTitle = title;
      }
    }

    // If the email is being changed, capture the previous email and push
    // it onto `emailHistory` in the SAME update. This is the safety net:
    // even if a future edit silently fails, login by ANY of the older
    // emails still works (the mobile auth checks emailHistory on lookup).
    const updateOps = { $set: payload };
    if (payload.email) {
      const cur = await Employee.findById(req.params.id).select('email emailHistory').lean();
      if (cur && cur.email && String(cur.email).toLowerCase() !== String(payload.email).toLowerCase()) {
        updateOps.$addToSet = { emailHistory: String(cur.email).toLowerCase() };
      }
    }

    const employee = await Employee.findByIdAndUpdate(req.params.id, updateOps, { new: true, runValidators: false });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    return res.status(200).json({
      success: true,
      message: newPasswordFromBody
        ? 'Employee updated. New password will work on the mobile app immediately.'
        : 'Employee updated.',
      employee: employee.toSafeObject(),
    });
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid employee id' });
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'Duplicate value' });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/employees/:id — HARD delete + orphan cleanup ───────
router.delete('/:id', async (req, res) => {
  try {
    // Remove the row entirely so it never reappears anywhere. Mobile login
    // fails too because the shared `employees` collection no longer has
    // that user. Orphaned artifacts (attendance / leaves / payslips /
    // notifications / etc.) referencing this user are also purged so
    // nothing stale is shown in Reports / Approvals / Payroll.
    const employee = await Employee.findByIdAndDelete(req.params.id);
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });

    const db = mongoose.connection.db;
    const orphanCols = ['attendances', 'leaves', 'allowances', 'notifications',
                        'payslips', 'complaints', 'attendancerequests',
                        'locationpings', 'leaverequests'];
    const orphans = {};
    for (const name of orphanCols) {
      try {
        const r = await db.collection(name).deleteMany({ user: employee._id });
        orphans[name] = r.deletedCount || 0;
      } catch { /* collection may not exist — ignore */ }
    }

    return res.status(200).json({
      success: true,
      message: `Employee "${employee.firstName} ${employee.lastName}" permanently removed.`,
      orphanRowsDeleted: orphans,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/employees/backfill-names
 *
 * One-off migration: for every employee that has a `department` /
 * `designation` ObjectId but no `departmentName` / `designationTitle`,
 * resolve the referenced doc and stamp the readable copy onto the row.
 * Safe to re-run — only touches rows that are missing the readable field.
 */
router.post('/backfill-names', async (req, res) => {
  try {
    const rows = await Employee.find({}, { department: 1, designation: 1, departmentName: 1, designationTitle: 1 }).lean();
    let updated = 0;
    for (const r of rows) {
      const set = {};
      if (r.department && !r.departmentName) {
        const d = await Department.findById(r.department).lean().catch(() => null);
        if (d && d.name) set.departmentName = d.name;
      }
      if (r.designation && !r.designationTitle) {
        const d = await Designation.findById(r.designation).lean().catch(() => null);
        if (d && d.title) set.designationTitle = d.title;
      }
      if (Object.keys(set).length) {
        await Employee.updateOne({ _id: r._id }, { $set: set });
        updated += 1;
      }
    }
    res.json({ success: true, scanned: rows.length, updated });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
