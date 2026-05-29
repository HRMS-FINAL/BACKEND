// routes/dashboardRoutes.js — Dashboard stats
const express    = require('express');
const router     = express.Router();
const Employee   = require('../models/Employee');
const Leave      = require('../models/LeaveRequest');
const Department = require('../models/Department');

const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-emqy.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET =  process.env.MOBILE_ADMIN_SECRET || '';

// GET /api/dashboard/attendance-today
// Returns today's live attendance pulled from the mobile backend
// (counts of present / late / leave / permission / absent) for the
// dashboard "Attendance & Leave" widget. Falls back to {success:false}
// without crashing if the mobile backend is unreachable.
router.get('/attendance-today', async (req, res) => {
  if (!ADMIN_SECRET || typeof fetch !== 'function') {
    return res.status(200).json({
      success: false,
      message: 'Mobile attendance unavailable (admin secret missing or Node < 18).',
    });
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch(MOBILE_API + '/api/attendance/admin/all?date=' + today, {
      headers: { 'x-admin-secret': ADMIN_SECRET },
    });
    if (!r.ok) {
      return res.status(200).json({ success: false, message: 'Mobile API ' + r.status });
    }
    const j = await r.json().catch(() => ({}));
    const items = j.items || [];

    const totalEmployees = await Employee.countDocuments({ isActive: { $ne: false } });
    const present    = items.filter(a => a.status === 'present').length;
    const late       = items.filter(a => a.status === 'late').length;
    const leave      = items.filter(a => a.status === 'leave').length;
    const permission = items.filter(a => a.status === 'permission' || a.status === 'halfday').length;
    const checkedIn  = items.filter(a => !!a.checkIn).length;
    const absent     = Math.max(0, totalEmployees - checkedIn - leave);

    const logs = items.slice(0, 10).map(a => ({
      name: a.user && a.user.name
        ? a.user.name
        : ((a.user && (a.user.firstName || '')) + ' ' + (a.user && (a.user.lastName || ''))).trim(),
      employeeId: (a.user && a.user.employeeId) || '',
      checkIn:  a.checkIn  ? new Date(a.checkIn ).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—',
      checkOut: a.checkOut ? new Date(a.checkOut).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—',
      status:   a.status || 'present',
    }));

    return res.status(200).json({
      success: true,
      data: { date: today, totalEmployees, present, late, leave, permission, absent, recent: logs },
    });
  } catch (err) {
    console.error('[dashboard/attendance-today]', err.message);
    return res.status(200).json({ success: false, message: err.message });
  }
});

// GET /api/dashboard/stats — All stats in one call
router.get('/stats', async (req, res) => {
  try {
    const now              = new Date();
    const startOfToday     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday       = new Date(startOfToday); endOfToday.setDate(endOfToday.getDate() + 1);
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfThisWeek    = new Date(now); endOfThisWeek.setDate(now.getDate() + (7 - now.getDay()));

    const [
      totalEmployees, activeEmployees,
      employeesLastMonth, activeLastMonth,
      onLeaveToday, onLeaveThisWeek,
      pendingApprovals, pendingLastWeek,
      pendingPermissions, pendingPermissionsLastWeek,
      byDepartmentRaw, byStatusRaw, byEmploymentTypeRaw,
      recentEmployees, recentLeaves,
    ] = await Promise.all([
      Employee.countDocuments({ isActive: { $ne: false } }),
      Employee.countDocuments({ status: 'Active', isActive: { $ne: false } }),
      Employee.countDocuments({ createdAt: { $lt: startOfThisMonth }, isActive: { $ne: false } }),
      Employee.countDocuments({ status: 'Active', isActive: { $ne: false }, createdAt: { $lt: startOfThisMonth } }),
      Leave.countDocuments({ status: 'Approved', fromDate: { $lte: endOfToday.toISOString().slice(0,10) }, toDate: { $gte: startOfToday.toISOString().slice(0,10) } }),
      Leave.countDocuments({ status: 'Approved', fromDate: { $lte: endOfThisWeek.toISOString().slice(0,10) }, toDate: { $gte: startOfToday.toISOString().slice(0,10) } }),
      Leave.countDocuments({ status: 'Pending' }),
      Leave.countDocuments({ status: 'Pending', createdAt: { $lt: new Date(now - 7 * 86400000) } }),
      Leave.countDocuments({ status: 'Pending', type: /permission/i }),
      Leave.countDocuments({ status: 'Pending', type: /permission/i, createdAt: { $lt: new Date(now - 7 * 86400000) } }),
      Employee.aggregate([{ $match: { isActive: { $ne: false } } }, { $group: { _id: '$department', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Employee.aggregate([{ $match: { isActive: { $ne: false } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      Employee.aggregate([{ $match: { isActive: { $ne: false } } }, { $group: { _id: '$employmentType', count: { $sum: 1 } } }]),
      Employee.find().sort({ createdAt: -1 }).limit(5).select('firstName lastName email employeeId department designation createdAt').lean(),
      Leave.find().sort({ createdAt: -1 }).limit(5).lean(),
    ]);

    const pctChange = (cur, prev) => prev === 0 ? (cur > 0 ? 100 : 0) : +(((cur - prev) / prev) * 100).toFixed(1);
    const colors    = ['#4CAA17','#4299E1','#9F7AEA','#ECC94B','#38B2AC','#ED8936','#E53E3E','#A0AEC0'];

    // Resolve any department ObjectIds → readable names. Plain-string
    // department values pass through; orphaned ObjectIds show as 'Unassigned'.
    const depts   = await Department.find({}).lean();
    const deptMap = Object.fromEntries(depts.map(d => [String(d._id), d.name]));
    const byDepartment = byDepartmentRaw.map((d, i) => {
      const k = String(d._id || '');
      const isObjId = /^[a-f0-9]{24}$/i.test(k);
      const name = isObjId ? (deptMap[k] || 'Unassigned') : (k || 'Unassigned');
      return { name, value: d.count, color: colors[i % colors.length] };
    });

    return res.status(200).json({
      success: true,
      stats: {
        cards: {
          totalEmployees: { label: 'Total Employees', value: totalEmployees, trend: (pctChange(totalEmployees, employeesLastMonth) >= 0 ? '+' : '') + pctChange(totalEmployees, employeesLastMonth) + '%', up: pctChange(totalEmployees, employeesLastMonth) >= 0, sub: 'vs last month' },
          activeStaff:    { label: 'Active Staff',    value: activeEmployees, trend: (pctChange(activeEmployees, activeLastMonth) >= 0 ? '+' : '') + pctChange(activeEmployees, activeLastMonth) + '%', up: true, sub: 'currently working' },
          onLeave:        { label: 'On Leave',        value: onLeaveToday, trend: String(onLeaveThisWeek - onLeaveToday), up: false, sub: 'this week' },
          // Renamed Pending → Permission so HR sees at-a-glance how many
          // permission requests are awaiting action.  Trend = delta over
          // the same window as the other cards.
          permission:     { label: 'Permission',      value: pendingPermissions, trend: ((pendingPermissions - pendingPermissionsLastWeek) >= 0 ? '+' : '') + (pendingPermissions - pendingPermissionsLastWeek), up: (pendingPermissions - pendingPermissionsLastWeek) >= 0, sub: 'requests pending' },
        },
        byDepartment,
        byStatus:         byStatusRaw.map(s => ({ status: s._id || 'Unknown', count: s.count })),
        byEmploymentType: byEmploymentTypeRaw.map(t => ({ type: t._id || 'Unknown', count: t.count })),
        recentEmployees,
        recentLeaves,
        counts: { totalEmployees, activeEmployees, onLeaveToday, onLeaveThisWeek, pendingApprovals, pendingPermissions },
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[DASHBOARD] Stats error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/dashboard/summary — quick counts
router.get('/summary', async (req, res) => {
  try {
    const [totalEmployees, totalLeaves, approvedLeaves, pendingLeaves, rejectedLeaves] = await Promise.all([
      Employee.countDocuments({ isActive: { $ne: false } }),
      Leave.countDocuments(),
      Leave.countDocuments({ status: 'Approved' }),
      Leave.countDocuments({ status: 'Pending' }),
      Leave.countDocuments({ status: 'Rejected' }),
    ]);
    return res.status(200).json({
      success: true,
      summary: { totalEmployees, totalLeaves, approvedLeaves, pendingLeaves, rejectedLeaves },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
