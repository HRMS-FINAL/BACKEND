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

const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-emqy.onrender.com').replace(/\/+$/, '');
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
 * Fetch every attendance row in [startDate, endDate] from the mobile backend,
 * spanning month boundaries if necessary. Returns an array of raw mobile docs
 * each with { user (populated), date, checkIn, checkOut, status, ... }.
 */
async function fetchMobileAttendanceRange(startDate, endDate) {
  if (!ADMIN_SECRET) return [];
  const start = new Date(startDate);
  const end   = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) return [];

  const months = new Set();
  for (let d = new Date(start.getFullYear(), start.getMonth(), 1);
       d <= end;
       d.setMonth(d.getMonth() + 1)) {
    months.add(`${d.getFullYear()}-${d.getMonth() + 1}`);
  }

  const all = [];
  for (const key of months) {
    const [y, m] = key.split('-');
    const r = await fwdMobile(`/api/attendance/admin/all?month=${m}&year=${y}&limit=5000`);
    if (!r.ok) continue;
    const j = await r.json().catch(() => ({}));
    (j.items || []).forEach(it => {
      // date is "YYYY-MM-DD"; keep rows inside the requested window.
      if (it.date >= startDate && it.date <= endDate) all.push(it);
    });
  }
  return all;
}

// GET /api/reports/attendance?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/attendance', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    // Pull data in parallel.
    const [mobileLogs, localLogs, leaveReqs, employees, depts, desigs] = await Promise.all([
      fetchMobileAttendanceRange(startDate, endDate),
      Attendance.find({ isActive: true, date: { $gte: startDate, $lte: endDate } }).lean().catch(() => []),
      LeaveRequest.find({ isActive: true, status: 'Approved', fromDate: { $lte: endDate }, toDate: { $gte: startDate } }).lean().catch(() => []),
      Employee.find({ isActive: { $ne: false } }).lean(),
      Department.find({}).lean(),
      Designation.find({}).lean(),
    ]);

    const deptMap  = Object.fromEntries(depts.map(d  => [String(d._id), d.name]));
    const desigMap = Object.fromEntries(desigs.map(d => [String(d._id), d.title]));
    const getDept  = v => !v ? '—' : (isObjId(v) ? (deptMap[String(v)]  || '—') : String(v));
    const getDesig = v => !v ? '—' : (isObjId(v) ? (desigMap[String(v)] || '—') : String(v));

    // Employee lookup maps (by employeeId and by Mongo _id, both shared).
    const empByEmpId   = {};
    const empByMongoId = {};
    employees.forEach(e => {
      if (e.employeeId) empByEmpId[String(e.employeeId)] = e;
      empByMongoId[String(e._id)] = e;
    });

    const grouped = {}; // keyed by employeeId or fallback

    // ── Aggregate mobile attendance ──────────────────────────────
    mobileLogs.forEach(log => {
      const fullName =
        log.user?.name ||
        [log.user?.firstName, log.user?.lastName].filter(Boolean).join(' ') ||
        'Unknown';
      const empId = log.user?.employeeId || '';
      const empDoc =
        (empId && empByEmpId[String(empId)]) ||
        (log.user?._id && empByMongoId[String(log.user._id)]) ||
        null;
      const key = empId || (log.user?._id ? String(log.user._id) : fullName);

      if (!grouped[key]) {
        const initials = fullName.split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().slice(0, 2);
        grouped[key] = {
          employeeId:   empId || empDoc?.employeeId || '',
          employeeName: fullName,
          avatar:       initials || '??',
          color:        empDoc?.color || COLORS[(fullName.charCodeAt(0) || 0) % COLORS.length],
          empDoc:       empDoc,
          present: 0, late: 0, absent: 0, halfDay: 0, leavedays: 0,
        };
      }
      const g = grouped[key];
      const s = String(log.status || '').toLowerCase();
      if      (s === 'present')    g.present++;
      else if (s === 'late')       g.late++;
      else if (s === 'absent')     g.absent++;
      else if (s === 'leave')      g.absent++; // counted via overlay too, but absent is the raw bucket
      else if (s === 'permission' || s === 'halfday') g.halfDay++;
    });

    // ── Merge any legacy local-DB logs (only if mobile didn't already cover) ──
    localLogs.forEach(log => {
      const key = log.employeeId || log.employeeName || String(log._id);
      if (grouped[key]) return;
      const fullName = log.employeeName || 'Unknown';
      const empDoc = (log.employeeId && empByEmpId[String(log.employeeId)]) || null;
      const initials = fullName.split(' ').filter(Boolean).map(n => n[0]).join('').toUpperCase().slice(0, 2);
      grouped[key] = {
        employeeId:   log.employeeId || empDoc?.employeeId || '',
        employeeName: fullName,
        avatar:       log.avatar || initials,
        color:        log.color  || empDoc?.color || COLORS[(fullName.charCodeAt(0) || 0) % COLORS.length],
        empDoc:       empDoc,
        present: 0, late: 0, absent: 0, halfDay: 0, leavedays: 0,
      };
      const g = grouped[key];
      if      (log.status === 'On Time')  g.present++;
      else if (log.status === 'Late')     g.late++;
      else if (log.status === 'Absent')   g.absent++;
      else if (log.status === 'Half Day') g.halfDay++;
    });

    // Overlay approved leave days (only for employees already in grouped)
    leaveReqs.forEach(lr => {
      let key = lr.employeeId && grouped[lr.employeeId] ? lr.employeeId : null;
      if (!key && lr.employee) { const emp = empByMongoId[String(lr.employee)]; if (emp) key = emp.employeeId || String(emp._id); }
      if (!key && lr.employeeName) key = Object.keys(grouped).find(k => grouped[k].employeeName === lr.employeeName) || null;
      if (!key || !grouped[key]) return;
      const from = new Date(Math.max(new Date(lr.fromDate), new Date(startDate)));
      const to   = new Date(Math.min(new Date(lr.toDate),   new Date(endDate)));
      grouped[key].leavedays += Math.max(0, Math.ceil((to - from) / 86400000) + 1);
    });

    // Build rows
    //
    // LOP policy (set by HR on 2026-05-28):
    //   • 1 CL/month is free; every extra approved-leave day is 1 LOP.
    //   • 2 permissions/month are free; each extra permission costs 0.5 LOP.
    //   • Lates accumulate: every 3 lates = 0.5 LOP, every 6 lates = 1 LOP.
    //   • A raw 'Absent' day (no approved leave on file) is 1 LOP.
    //
    // We split the result into two display columns:
    //   • lop       — whole-day LOP equivalents
    //   • halfLop   — half-day LOP equivalents (each = 0.5 of a day)
    const rows = Object.values(grouped).map(g => {
      const emp = g.empDoc;
      const excessLeaves = Math.max(0, g.leavedays - 1);
      const excessPerms  = Math.max(0, g.halfDay   - 2);
      const lateFullLop  = Math.floor(g.late / 6);
      const lateHalfLop  = (g.late % 6 >= 3) ? 1 : 0;
      const lopDays      = excessLeaves + g.absent + lateFullLop;
      const halfLopDays  = excessPerms + lateHalfLop;
      return {
        employeeId:   g.employeeId,
        employeeName: g.employeeName,
        avatar:       g.avatar,
        color:        g.color,
        department:   emp ? getDept(emp.department)   : '—',
        designation:  emp ? getDesig(emp.designation) : '—',
        manager:      emp?.assignedTo || '—',
        status:       emp?.status     || 'Active',
        // For UI counts: Late is ALSO counted as present (employee did
        // come in, just after the 10:01 AM cutoff).
        present:      g.present + g.late,
        late:         g.late,
        absent:       g.absent,
        halfDay:      g.halfDay,
        leavedays:    g.leavedays,
        lop:          lopDays,
        halfLop:      halfLopDays,
      };
    });

    const totalPresent   = rows.reduce((s, r) => s + r.present,   0);
    const totalLate      = rows.reduce((s, r) => s + r.late,      0);
    const totalAbsent    = rows.reduce((s, r) => s + r.absent,    0);
    const totalHalfDay   = rows.reduce((s, r) => s + r.halfDay,   0);
    const totalLeavedays = rows.reduce((s, r) => s + r.leavedays, 0);

    return res.status(200).json({
      success: true,
      data: {
        startDate, endDate,
        totalEmployees: rows.length,
        summary: { totalPresent, totalLate, totalAbsent, totalHalfDay, totalLeavedays },
        rows,
      },
    });
  } catch (err) {
    console.error('[REPORT] error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
