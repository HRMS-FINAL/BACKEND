// routes/dashboardRoutes.js — Dashboard stats
const express  = require('express');
const router   = express.Router();
const Employee = require('../models/Employee');
const Leave    = require('../models/LeaveRequest');

// GET /api/dashboard/stats — All stats in one call
router.get('/stats', async (req, res) => {
  try {
    const now             = new Date();
    const startOfToday    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday      = new Date(startOfToday); endOfToday.setDate(endOfToday.getDate() + 1);
    const startOfThisMonth= new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfThisWeek   = new Date(now); endOfThisWeek.setDate(now.getDate() + (7 - now.getDay()));

    const [
      totalEmployees, activeEmployees,
      employeesLastMonth, activeLastMonth,
      onLeaveToday, onLeaveThisWeek,
      pendingApprovals, pendingLastWeek,
      byDepartmentRaw, byStatusRaw, byEmploymentTypeRaw,
      recentEmployees, recentLeaves,
    ] = await Promise.all([
      Employee.countDocuments(),
      Employee.countDocuments({ status: 'Active' }),
      Employee.countDocuments({ createdAt: { $lt: startOfThisMonth } }),
      Employee.countDocuments({ status: 'Active', createdAt: { $lt: startOfThisMonth } }),
      Leave.countDocuments({ status: 'Approved', fromDate: { $lte: endOfToday.toISOString().slice(0,10) }, toDate: { $gte: startOfToday.toISOString().slice(0,10) } }),
      Leave.countDocuments({ status: 'Approved', fromDate: { $lte: endOfThisWeek.toISOString().slice(0,10) }, toDate:  { $gte: startOfToday.toISOString().slice(0,10) } }),
      Leave.countDocuments({ status: 'Pending' }),
      Leave.countDocuments({ status: 'Pending', createdAt: { $lt: new Date(now - 7*86400000) } }),
      Employee.aggregate([{ $group: { _id: '$department', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Employee.aggregate([{ $group: { _id: '$status',     count: { $sum: 1 } } }]),
      Employee.aggregate([{ $group: { _id: '$employmentType', count: { $sum: 1 } } }]),
      Employee.find().sort({ createdAt: -1 }).limit(5).select('firstName lastName email employeeId department designation createdAt').lean(),
      Leave.find().sort({ createdAt: -1 }).limit(5).lean(),
    ]);

    const pctChange = (cur, prev) => prev === 0 ? (cur > 0 ? 100 : 0) : +(((cur - prev) / prev) * 100).toFixed(1);
    const colors    = ['#4CAA17','#4299E1','#9F7AEA','#ECC94B','#38B2AC','#ED8936','#E53E3E','#A0AEC0'];

    return res.status(200).json({
      success: true,
      stats: {
        cards: {
          totalEmployees: { label: 'Total Employees', value: totalEmployees, trend: `${pctChange(totalEmployees, employeesLastMonth) >= 0 ? '+' : ''}${pctChange(totalEmployees, employeesLastMonth)}%`, up: pctChange(totalEmployees, employeesLastMonth) >= 0, sub: 'vs last month' },
          activeStaff:    { label: 'Active Staff',    value: activeEmployees, trend: `${pctChange(activeEmployees, activeLastMonth) >= 0 ? '+' : ''}${pctChange(activeEmployees, activeLastMonth)}%`, up: true, sub: 'currently working' },
          onLeave:        { label: 'On Leave',        value: onLeaveToday, trend: `${onLeaveThisWeek - onLeaveToday}`, up: false, sub: 'this week' },
          pending:        { label: 'Pending',         value: pendingApprovals, trend: `${pendingApprovals - pendingLastWeek >= 0 ? '+' : ''}${pendingApprovals - pendingLastWeek}`, up: (pendingApprovals - pendingLastWeek) >= 0, sub: 'approvals needed' },
        },
        byDepartment:     byDepartmentRaw.map((d, i) => ({ name: d._id || 'Unassigned', value: d.count, color: colors[i % colors.length] })),
        byStatus:         byStatusRaw.map(s => ({ status: s._id || 'Unknown', count: s.count })),
        byEmploymentType: byEmploymentTypeRaw.map(t => ({ type: t._id || 'Unknown', count: t.count })),
        recentEmployees,
        recentLeaves,
        counts: { totalEmployees, activeEmployees, onLeaveToday, onLeaveThisWeek, pendingApprovals },
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
      Employee.countDocuments(),
      Leave.countDocuments(),
      Leave.countDocuments({ status: 'Approved' }),
      Leave.countDocuments({ status: 'Pending' }),
      Leave.countDocuments({ status: 'Rejected' }),
    ]);
    return res.status(200).json({ success: true, summary: { totalEmployees, totalLeaves, approvedLeaves, pendingLeaves, rejectedLeaves }, generatedAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
