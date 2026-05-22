// routes/reportRoutes.js — Attendance report with all employees
const express      = require('express');
const router       = express.Router();
const Attendance   = require('../models/Attendance');
const Employee     = require('../models/Employee');
const LeaveRequest = require('../models/LeaveRequest');
const Department   = require('../models/Department');
const Designation  = require('../models/Designation');

const COLORS = ['#4CAA17','#9F7AEA','#4299E1','#ECC94B','#FC8181','#48BB78','#ED64A6','#667EEA'];
const isObjId  = v => v && /^[a-f0-9]{24}$/i.test(String(v));

// GET /api/reports/attendance?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/attendance', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'startDate and endDate are required (YYYY-MM-DD)' });
    }

    // Fetch all data in parallel
    const [logs, leaveReqs, employees, depts, desigs] = await Promise.all([
      Attendance.find({ isActive: true, date: { $gte: startDate, $lte: endDate } }),
      LeaveRequest.find({ isActive: true, status: 'Approved', fromDate: { $lte: endDate }, toDate: { $gte: startDate } }),
      Employee.find({ isActive: { $ne: false } }).lean(),
      Department.find({}).lean(),
      Designation.find({}).lean(),
    ]);

    const deptMap  = Object.fromEntries(depts.map(d  => [String(d._id), d.name]));
    const desigMap = Object.fromEntries(desigs.map(d => [String(d._id), d.title]));

    const getDept  = v => !v ? '—' : (isObjId(v) ? (deptMap[String(v)]  || '—') : String(v));
    const getDesig = v => !v ? '—' : (isObjId(v) ? (desigMap[String(v)] || '—') : String(v));

    // Pre-seed ALL employees — everyone appears in the report
    const grouped      = {};
    const empByEmpId   = {};
    const empByMongoId = {};

    employees.forEach(e => {
      const key      = e.employeeId || String(e._id);
      const fullName = e.name || `${e.firstName || ''} ${e.lastName || ''}`.trim() || 'Unknown';
      const initials = fullName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
      grouped[key] = {
        employeeId:   e.employeeId || '',
        employeeName: fullName,
        avatar:       initials,
        color:        e.color || COLORS[fullName.charCodeAt(0) % COLORS.length],
        empDoc:       e,
        present: 0, late: 0, absent: 0, halfDay: 0, leavedays: 0,
      };
      if (e.employeeId) empByEmpId[String(e.employeeId)] = e;
      empByMongoId[String(e._id)] = e;
    });

    // Overlay attendance logs
    logs.forEach(log => {
      let key = log.employeeId && grouped[log.employeeId] ? log.employeeId : null;
      if (!key && log.employee) {
        const emp = empByMongoId[String(log.employee)];
        if (emp) key = emp.employeeId || String(emp._id);
      }
      if (!key) {
        key = log.employeeId || log.employeeName;
        if (key && !grouped[key]) grouped[key] = { employeeId: log.employeeId || '', employeeName: log.employeeName || '', avatar: '', color: '#4299E1', empDoc: null, present: 0, late: 0, absent: 0, halfDay: 0, leavedays: 0 };
      }
      if (!key || !grouped[key]) return;
      const g = grouped[key];
      if      (log.status === 'On Time')  g.present++;
      else if (log.status === 'Late')     g.late++;
      else if (log.status === 'Absent')   g.absent++;
      else if (log.status === 'Half Day') g.halfDay++;
    });

    // Overlay approved leave days
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
    const rows = Object.values(grouped).map(g => {
      const emp = g.empDoc;
      return {
        employeeId:   g.employeeId,
        employeeName: g.employeeName,
        avatar:       g.avatar,
        color:        g.color,
        department:   emp ? getDept(emp.department)   : '—',
        designation:  emp ? getDesig(emp.designation) : '—',
        manager:      emp?.assignedTo || '—',
        status:       emp?.status     || 'Active',
        present:      g.present,
        late:         g.late,
        absent:       g.absent,
        halfDay:      g.halfDay,
        leavedays:    g.leavedays,
        lop:          Math.max(0, g.absent - g.leavedays),
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
