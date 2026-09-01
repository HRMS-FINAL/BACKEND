// routes/reportRoutes.js — Attendance report (mobile backend as source of truth)
const express      = require('express');
const router       = express.Router();
const Attendance   = require('../models/Attendance');
const Employee     = require('../models/Employee');
const LeaveRequest = require('../models/LeaveRequest');
const Department   = require('../models/Department');
const Designation  = require('../models/Designation');

const COLORS = ['#4CAA17','#9F7AEA','#4299E1','#ECC94B','#FC8181','#48BB78','#ED64A6','#667EEA'];
const isObjId  = v => v && /^[a-f0-9]{24}$/i.test(String(v));

const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-9rtc.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET =  process.env.MOBILE_ADMIN_SECRET || '';
const FETCH_TIMEOUT_MS = 45_000;

async function fwdMobile(path) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available — Node 18+ required.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(MOBILE_API + path, {
      signal:  controller.signal,
      headers: { 'x-admin-secret': ADMIN_SECRET },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * List the calendar months (1-based) that a [startDate, endDate] window
 * touches. The canonical summary the ERM app uses is computed PER MONTH
 * (attendanceController.computeMonthlySummary), so the report walks each
 * month in range and sums the per-employee counts.
 */
function monthsInRange(startDate, endDate) {
  const out = [];
  const s = new Date(`${startDate}T00:00:00`);
  const e = new Date(`${endDate}T00:00:00`);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || s > e) return out;
  for (let d = new Date(s.getFullYear(), s.getMonth(), 1); d <= e; d.setMonth(d.getMonth() + 1)) {
    out.push({ month: d.getMonth() + 1, year: d.getFullYear() });
  }
  return out;
}

/**
 * Fetch the CANONICAL per-employee monthly summary for one month from the
 * mobile backend's bulk endpoint (#494). Each item is the EXACT object
 * computeMonthlySummary produces — the same numbers the ERM attendance
 * cards and the Manager team report display:
 *   { userId, employeeId, name, present, late, absent, permission,
 *     halfday, leave, holiday, workdaysElapsed }
 */
async function fetchCanonicalMonth(month, year) {
  if (!ADMIN_SECRET) return [];
  const r = await fwdMobile(`/api/attendance/admin/summary-all?month=${month}&year=${year}`);
  if (!r.ok) return [];
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j.items) ? j.items : [];
}

// GET /api/reports/attendance?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//
// #494 — REWRITTEN to be a thin projection over ERM's canonical counts.
// Previously this route re-derived present/late/absent/permission in HRMS
// with its own status mapping + absent sweep + permission heuristic, so its
// numbers drifted from what the ERM app + Manager team report showed. Now the
// per-employee counts come straight from computeMonthlySummary (via the bulk
// admin endpoint); HRMS only:
//   1. drives the ROW SET off its own employee directory (one row per active
//      employee → no missing / duplicate employees), and
//   2. computes the LOP / ½-LOP columns (which ERM doesn't have) on top of the
//      canonical counts, applying the monthly free-allowance policy per month.
//
// NOTE: the canonical summary is month-grained (ERM has no partial-month
// concept). The Reports UI's Quick Select always picks whole calendar months,
// and the default range is 1st-of-month→today (the current month, which
// computeMonthlySummary already caps at today), so the common cases are exact.
router.get('/attendance', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    const [allEmployees, depts, desigs] = await Promise.all([
      Employee.find({ isActive: { $ne: false } }).lean(),
      Department.find({}).lean(),
      Designation.find({}).lean(),
    ]);

    // #509 — Exclude terminated / resigned / inactive employees from the
    // Attendance Report entirely. We can't rely on isActive alone: some legacy
    // terminated rows still carry isActive:true, so we also drop by status.
    const employees = allEmployees.filter((e) => {
      const s = String(e.status || '').toLowerCase().trim();
      return !(e.isActive === false || s === 'terminated' || s === 'resigned' || s === 'inactive');
    });

    const deptMap  = Object.fromEntries(depts.map(d  => [String(d._id), d.name]));
    const desigMap = Object.fromEntries(desigs.map(d => [String(d._id), d.title]));
    const getDept  = v => !v ? '—' : (isObjId(v) ? (deptMap[String(v)]  || '—') : String(v));
    const getDesig = v => !v ? '—' : (isObjId(v) ? (desigMap[String(v)] || '—') : String(v));

    // ── Pull the canonical monthly summaries for every month in range ──
    // (parallel across months) and accumulate per employeeId. Raw counts are
    // additive across months; LOP / ½-LOP are computed PER MONTH (so each
    // month gets its own free 1-CL + 2-permission allowance) and then summed.
    const months  = monthsInRange(startDate, endDate);
    const perMonth = await Promise.all(months.map(m => fetchCanonicalMonth(m.month, m.year)));

    const acc = {}; // employeeId(upper) → accumulated canonical counts + LOP
    const ensure = (k) => (acc[k] ||= {
      present: 0, late: 0, absent: 0, permission: 0, halfday: 0, leave: 0,
      lop: 0, halfLop: 0,
    });
    for (const items of perMonth) {
      for (const it of items) {
        const key = String(it.employeeId || '').trim().toUpperCase();
        if (!key) continue;
        const a = ensure(key);
        a.present    += Number(it.present)    || 0;
        a.late       += Number(it.late)       || 0;
        a.absent     += Number(it.absent)     || 0;
        a.permission += Number(it.permission) || 0;
        a.halfday    += Number(it.halfday)    || 0;
        a.leave      += Number(it.leave)      || 0;

        // ── LOP policy (HR, per calendar month) ──────────────────────────
        //   • 1 approved-leave day/month is free; each extra = 1 LOP.
        //   • 2 permissions/month are free; each extra = 0.5 (½) LOP.
        //   • Lates accumulate: every 6 = 1 LOP, a remainder of ≥3 = ½ LOP.
        //   • Each raw Absent day = 1 LOP. A half-day = ½… already ½ LOP.
        const leave = Number(it.leave) || 0;
        const perm  = Number(it.permission) || 0;
        const late  = Number(it.late) || 0;
        const half  = Number(it.halfday) || 0;
        const absent = Number(it.absent) || 0;
        const excessLeaves = Math.max(0, leave - 1);
        const excessPerms  = Math.max(0, perm - 2);
        const lateFullLop  = Math.floor(late / 6);
        const lateHalfLop  = (late % 6 >= 3) ? 1 : 0;
        a.lop     += excessLeaves + absent + lateFullLop + half;
        a.halfLop += excessPerms + lateHalfLop;
      }
    }

    // ── Build one row per HRMS employee (single source of the row set) ──
    // Counts come from `acc` keyed by employeeId; identity / department /
    // designation / manager / status come from the HRMS directory. An
    // employee with no attendance in range simply shows zeros.
    const rows = employees.map(emp => {
      const key = String(emp.employeeId || '').trim().toUpperCase();
      const c = acc[key] || { present: 0, late: 0, absent: 0, permission: 0, halfday: 0, leave: 0, lop: 0, halfLop: 0 };
      const fullName =
        emp.name ||
        [emp.firstName, emp.lastName].filter(Boolean).join(' ').trim() ||
        'Unknown';
      const initials = fullName.split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().slice(0, 2) || '??';
      return {
        employeeId:   emp.employeeId || '',
        employeeName: fullName,
        avatar:       initials,
        color:        emp.color || COLORS[(fullName.charCodeAt(0) || 0) % COLORS.length],
        department:   getDept(emp.department),
        designation:  getDesig(emp.designation),
        manager:      emp.assignedTo || '—',
        status:       emp.status     || 'Active',
        // #516 — Present INCLUDES Late days. A late arrival is still a present
        // day, so the Present column = on-time present + late. Late keeps its
        // own column for reporting. `presentOnTime` stays the disjoint on-time
        // count so charts can show on-time vs late without double-counting.
        present:       c.present + c.late,
        presentOnTime: c.present,
        late:          c.late,
        absent:        c.absent,
        permission:    c.permission,
        halfDay:       c.halfday,
        leavedays:     c.leave,
        lop:           c.lop,
        halfLop:       c.halfLop,
      };
    });

    const totalPresent       = rows.reduce((s, r) => s + r.present,       0);
    const totalPresentOnTime = rows.reduce((s, r) => s + r.presentOnTime, 0);
    const totalLate          = rows.reduce((s, r) => s + r.late,          0);
    const totalAbsent        = rows.reduce((s, r) => s + r.absent,        0);
    const totalPermission    = rows.reduce((s, r) => s + r.permission,    0);
    const totalHalfDay       = rows.reduce((s, r) => s + r.halfDay,       0);
    const totalLeavedays     = rows.reduce((s, r) => s + r.leavedays,     0);

    return res.status(200).json({
      success: true,
      data: {
        startDate, endDate,
        totalEmployees: rows.length,
        summary: {
          totalPresent, totalPresentOnTime,
          totalLate, totalAbsent,
          totalPermission, totalHalfDay, totalLeavedays,
        },
        rows,
      },
    });
  } catch (err) {
    console.error('[REPORT] error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
