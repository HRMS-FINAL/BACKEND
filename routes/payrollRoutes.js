/**
 * Payroll routes — HRMS-side proxy to the mobile backend's payslip admin API.
 *
 * HR uses the HRMS Payroll page to upload an attendance report (xlsx/csv) or
 * type figures directly. We forward the resulting payslip(s) to the mobile
 * backend so the employee can see them in the mobile ERM app and the
 * "Send to Employee" action becomes a real delivery, not just a toast.
 *
 * Also exposes a helper that auto-generates payslip drafts for a given month
 * from the attendance counts so HR doesn't have to fill every box by hand.
 */

const express  = require('express');
const router   = express.Router();
const multer   = (() => { try { return require('multer'); } catch { return null; } })();
const XLSX     = (() => { try { return require('xlsx');   } catch { return null; } })();

const Employee     = require('../models/Employee');
const Department   = require('../models/Department');
const Designation  = require('../models/Designation');
const { parseReport } = require('../utils/payrollReportParser');

const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-9rtc.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET =  process.env.MOBILE_ADMIN_SECRET || '';
const FETCH_TIMEOUT_MS = 45_000;

function configReady(res) {
  if (!ADMIN_SECRET) {
    res.status(503).json({
      success: false,
      message: 'MOBILE_ADMIN_SECRET is not configured on the HRMS server.',
    });
    return false;
  }
  return true;
}

async function fwd(path, init = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available — Node 18+ required.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(MOBILE_API + path, {
      ...init,
      signal:  controller.signal,
      headers: {
        ...(init.headers || {}),
        'x-admin-secret': ADMIN_SECRET,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ─────────────────────────────────────────────
// POST /api/payroll/push        — push a single payslip
// Body: { employeeId | email, month, year, monthLabel?, earnings, deductions, status?, paidVia? }
// ─────────────────────────────────────────────
router.post('/push', express.json(), async (req, res) => {
  if (!configReady(res)) return;
  try {
    const r = await fwd('/api/payslip/admin/upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ success: false, message: data?.message || `Mobile API ${r.status}` });
    }
    res.json({ success: true, payslip: data.payslip });
  } catch (err) {
    console.error('[payroll/push]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach the mobile backend. ' + err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/payroll/list?month=&year=  — list payslips already published
// ─────────────────────────────────────────────
router.get('/list', async (req, res) => {
  if (!configReady(res)) return;
  try {
    const q = new URLSearchParams();
    if (req.query.month) q.set('month', req.query.month);
    if (req.query.year)  q.set('year',  req.query.year);
    const qs = q.toString() ? `?${q.toString()}` : '';
    const r = await fwd(`/api/payslip/admin/list${qs}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ success: false, message: data?.message || `Mobile API ${r.status}` });
    }
    res.json({ success: true, items: data.items || [], count: data.count || 0 });
  } catch (err) {
    console.error('[payroll/list]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach the mobile backend. ' + err.message });
  }
});

/**
 * Shared generator: read mobile attendance for {month, year}, aggregate per
 * employee, build payslip numbers, and upsert each to the mobile backend.
 * Returns the same shape the /generate-from-attendance route does.
 */
async function generatePayslipsForMonth({ month, year, employees: ctcOverrides, onlyUserIds }) {
  const m = parseInt(month, 10);
  const y = parseInt(year,  10);
  if (!m || m < 1 || m > 12) {
    return { status: 400, body: { success: false, message: 'month (1-12) required' } };
  }
  if (!y) {
    return { status: 400, body: { success: false, message: 'year required' } };
  }

  try {
    // 1) Pull attendance for the month from the mobile backend.
    const ar = await fwd(`/api/attendance/admin/all?month=${m}&year=${y}&limit=5000`);
    if (!ar.ok) {
      const j = await ar.json().catch(() => ({}));
      return { status: ar.status, body: { success: false, message: j?.message || `Mobile API ${ar.status}` } };
    }
    const att = await ar.json().catch(() => ({ items: [] }));

    // 2) Aggregate per employee.
    const byEmp = {};
    (att.items || []).forEach(it => {
      const empId = it.user?.employeeId || (it.user?._id ? String(it.user._id) : '');
      if (!empId) return;
      if (!byEmp[empId]) {
        byEmp[empId] = {
          employeeId: it.user?.employeeId || '',
          userId:     it.user?._id ? String(it.user._id) : '',
          email:      it.user?.email || '',
          name:       it.user?.name || [it.user?.firstName, it.user?.lastName].filter(Boolean).join(' '),
          present: 0, late: 0, absent: 0, halfDay: 0, leave: 0,
        };
      }
      const s = String(it.status || '').toLowerCase();
      if      (s === 'present')    byEmp[empId].present++;
      else if (s === 'late')       byEmp[empId].late++;
      else if (s === 'absent')     byEmp[empId].absent++;
      else if (s === 'leave')      byEmp[empId].leave++;
      else if (s === 'permission' || s === 'halfday') byEmp[empId].halfDay++;
    });

    // 3) Optional CTC overrides supplied by the client.
    const ctcOverride = {};
    if (Array.isArray(ctcOverrides)) {
      ctcOverrides.forEach(e => {
        if (e?.employeeId && e?.ctc != null) ctcOverride[e.employeeId] = Number(e.ctc) || 0;
      });
    }

    // 4) Look up CTC from the Employee collection where available.
    const empIds = Object.keys(byEmp);
    const employees = await Employee.find({
      $or: [
        { employeeId: { $in: empIds } },
        { _id:        { $in: empIds.filter(id => /^[a-f0-9]{24}$/i.test(id)) } },
      ],
    }).lean();
    const empByEmpId   = Object.fromEntries(employees.map(e => [String(e.employeeId || ''), e]));
    const empByMongoId = Object.fromEntries(employees.map(e => [String(e._id), e]));

    // 5) For each employee, derive payslip numbers and push to mobile.
    const results = [];
    for (const key of Object.keys(byEmp)) {
      const row = byEmp[key];
      // Skip employees who haven't requested a payslip for this month
      // when an explicit allow-list is supplied.
      if (onlyUserIds && onlyUserIds.length > 0 && !onlyUserIds.includes(String(row.userId))) continue;
      const emp = empByEmpId[row.employeeId] || empByMongoId[row.userId] || {};
      const ctc = Number(ctcOverride[row.employeeId] ?? emp.salary ?? 50000);

      const daysInMonth = new Date(y, m, 0).getDate();
      const lopDays     = Math.max(0, row.absent - row.leave); // unapproved absence
      const perDay      = ctc / daysInMonth;

      // Official Tesco Structures payslip model — ONLY Basic + DA and HRA as
      // earnings, ONLY PF + Professional Tax as deductions. No Conveyance /
      // Special / Performance / TDS. Full monthly salary split 50/50 (not
      // prorated). PF + Professional Tax come from the employee record (0 if
      // unset). Net = Total Earnings - Total Deductions.
      const basic = Math.round(ctc / 2);   // Basic + DA
      const hra   = ctc - basic;           // HRA (keeps basic + hra === ctc)

      const earnings = {
        basicSalary:      basic,
        hraAllowance:     hra,
        performanceBonus: 0,
        otherEarnings:    0,
      };
      const totalGross = basic + hra;
      const pf = Number(emp.pf ?? emp.providentFund ?? 0) || 0;
      const pt = Number(emp.professionalTax ?? emp.profTax ?? 0) || 0;
      // NOTE: lopDays above is still computed from attendance (LOP counting is
      // unchanged), but — matching the official payslip — it is NOT applied as a
      // monetary deduction, so net = Total Earnings - (PF + Professional Tax).
      const deductions = {
        incomeTax:       0,     // no TDS
        providentFund:   pf,    // PF
        healthInsurance: 0,
        lopDeduction:    0,
        otherDeductions: pt,    // Professional Tax
      };

      const body = {
        employeeId: row.employeeId || undefined,
        userId:     row.userId     || undefined,
        email:      row.email      || undefined,
        month: m,
        year:  y,
        monthLabel: `${MONTH_NAMES[m]} ${y}`,
        earnings,
        deductions,
      };

      try {
        const r = await fwd('/api/payslip/admin/upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const d = await r.json().catch(() => ({}));
        results.push({
          employeeId: row.employeeId,
          name:       row.name,
          ok:         r.ok,
          netPay:     d?.payslip?.netPay,
          message:    r.ok ? 'ok' : (d?.message || `mobile ${r.status}`),
        });
      } catch (e) {
        results.push({ employeeId: row.employeeId, name: row.name, ok: false, message: e.message });
      }
    }

    const generated = results.filter(r => r.ok).length;
    return {
      status: 200,
      body:   { success: true, generated, total: results.length, results },
    };
  } catch (err) {
    console.error('[payroll generator]', err);
    return { status: 500, body: { success: false, message: err.message } };
  }
}

// ─────────────────────────────────────────────
// POST /api/payroll/generate-from-attendance
// Body: { month, year, employees? }
// ─────────────────────────────────────────────
router.post('/generate-from-attendance', express.json(), async (req, res) => {
  if (!configReady(res)) return;
  const out = await generatePayslipsForMonth({
    month:     req.body?.month,
    year:      req.body?.year,
    employees: req.body?.employees,
  });
  res.status(out.status).json(out.body);
});

// ─────────────────────────────────────────────
// POST /api/payroll/upload-attendance
// Multipart upload of an xlsx/csv. Server reads the month/year from the
// query string, ignores the file contents past row counts (the source of
// truth is the mobile attendance anyway), and then runs the same generator.
// This keeps the existing HR "Upload Report" UX feeling identical, but the
// numbers come from the canonical attendance data — not whatever's in the
// uploaded file.
// ─────────────────────────────────────────────
const upload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }) : null;

// If multer isn't installed we still need to drain the request stream,
// otherwise the connection stalls waiting for the multipart body. We don't
// look at the contents — month/year arrive on the query string.
function drainBody(req, res, next) {
  if (!req.readable) return next();
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 15 * 1024 * 1024) req.destroy(); // safety cap
  });
  req.on('end',   () => next());
  req.on('error', () => next());
}

router.post(
  '/upload-attendance',
  upload ? upload.single('file') : drainBody,
  async (req, res) => {
    if (!configReady(res)) return;
    const m = parseInt(req.body?.month || req.query?.month, 10);
    const y = parseInt(req.body?.year  || req.query?.year,  10);
    if (!m || !y) {
      return res.status(400).json({
        success: false,
        message: 'month and year are required (form field or query string)',
      });
    }
    if (!multer) {
      console.warn('[payroll/upload-attendance] multer not installed — running generator without parsing the file. Run `npm install` in the HRMS backend to enable file parsing.');
    }
    // PULL-BASED FLOW: do NOT auto-push payslips for every employee on
    // upload. Instead, only fulfill the employees who have *requested*
    // a payslip for {month, year} (rows in the Payslip collection with
    // status='pending'). HR can still send individual payslips via the
    // per-row "Send to Employee" button.
    let onlyUserIds = [];
    try {
      const listR = await fwd(`/api/payslip/admin/list?month=${m}&year=${y}`);
      if (listR.ok) {
        const listJ = await listR.json().catch(() => ({}));
        onlyUserIds = (listJ.items || [])
          .filter(p => p.status === 'pending')
          .map(p => String(p.user?._id || p.user || ''))
          .filter(Boolean);
      }
    } catch { /* fall through */ }
    if (onlyUserIds.length === 0) {
      return res.status(200).json({
        success: true,
        generated: 0,
        total: 0,
        message: 'Upload acknowledged. No employees have requested a payslip for this month yet — nothing to push. Use "Send to Employee" on a row to push manually.',
        uploadedFileName: req.file?.originalname || null,
        uploadedSize:     req.file?.size || 0,
      });
    }
    const out = await generatePayslipsForMonth({ month: m, year: y, onlyUserIds });
    res.status(out.status).json({
      ...out.body,
      uploadedFileName: req.file?.originalname || null,
      uploadedSize:     req.file?.size || 0,
    });
  }
);

// ─────────────────────────────────────────────
// POST /api/payroll/parse-report
// Multipart upload of an Employee OR Labour report. Parses the file, auto-
// detects the format from the header row, matches each row to an existing
// Employee, computes the per-type payslip numbers + validation flags, and
// returns a PREVIEW. Nothing is pushed — HR reviews first, then commits.
// Body/query: month, year, (optional) type = 'employee' | 'labour'
// ─────────────────────────────────────────────
router.post(
  '/parse-report',
  upload ? upload.single('file') : drainBody,
  async (req, res) => {
    const m = parseInt(req.body?.month || req.query?.month, 10);
    const y = parseInt(req.body?.year  || req.query?.year,  10);
    if (!m || !y) {
      return res.status(400).json({ success: false, message: 'month and year are required.' });
    }
    if (!multer) {
      return res.status(503).json({ success: false, message: 'File uploads are disabled on the HRMS server (multer not installed). Run `npm install` in the backend.' });
    }
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ success: false, message: 'No file was received. Please choose an .xlsx or .csv report.' });
    }
    const forceType = (req.body?.type || req.query?.type || '').toLowerCase();
    try {
      // Pull every employee once for name / employeeId matching.
      const employees = await Employee.find({}, {
        firstName: 1, lastName: 1, employeeId: 1, email: 1, salary: 1,
        pf: 1, professionalTax: 1, departmentName: 1, designationTitle: 1,
      }).lean();

      const preview = parseReport(req.file.buffer, {
        employees, month: m, year: y,
        forceType: (forceType === 'employee' || forceType === 'labour') ? forceType : undefined,
      });
      const code = preview.success ? 200 : (preview.unknownFormat ? 422 : 400);
      return res.status(code).json({
        ...preview,
        uploadedFileName: req.file.originalname || null,
        uploadedSize:     req.file.size || 0,
      });
    } catch (err) {
      console.error('[payroll/parse-report]', err);
      return res.status(500).json({ success: false, message: 'Failed to parse the report. ' + err.message });
    }
  }
);

// ─────────────────────────────────────────────
// POST /api/payroll/commit-report
// JSON: { month, year, reportType, rows: [ { employeeId?, userId?, email?,
//         earnings, deductions, name? } ] }
// Pushes each reviewed-and-approved payslip to the mobile backend. The rows
// are exactly the `push` objects returned by /parse-report, so preview,
// downloaded PDF and stored record all carry identical values.
// ─────────────────────────────────────────────
router.post('/commit-report', express.json({ limit: '2mb' }), async (req, res) => {
  if (!configReady(res)) return;
  const m = parseInt(req.body?.month, 10);
  const y = parseInt(req.body?.year,  10);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!m || !y) return res.status(400).json({ success: false, message: 'month and year are required.' });
  if (!rows.length) return res.status(400).json({ success: false, message: 'No payslip rows to commit.' });

  const monthLabel = `${MONTH_NAMES[m]} ${y}`;
  const results = [];
  for (const row of rows) {
    if (!row || (!row.employeeId && !row.userId && !row.email)) {
      results.push({ name: row?.name || '(unknown)', ok: false, message: 'row has no employee identifier' });
      continue;
    }
    const body = {
      employeeId: row.employeeId || undefined,
      userId:     row.userId     || undefined,
      email:      row.email      || undefined,
      month: m, year: y, monthLabel,
      earnings:   row.earnings   || {},
      deductions: row.deductions || {},
    };
    try {
      const r = await fwd('/api/payslip/admin/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      results.push({
        employeeId: row.employeeId, name: row.name, ok: r.ok,
        netPay: d?.payslip?.netPay,
        message: r.ok ? 'ok' : (d?.message || `mobile ${r.status}`),
      });
    } catch (e) {
      results.push({ employeeId: row.employeeId, name: row.name, ok: false, message: e.message });
    }
  }

  const generated = results.filter(r => r.ok).length;
  res.json({ success: true, generated, total: results.length, results });
});

module.exports = router;
