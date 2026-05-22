// routes/attendanceRoutes.js — Attendance logs + Leave requests
const express      = require('express');
const router       = express.Router();
const Attendance   = require('../models/Attendance');
const LeaveRequest = require('../models/LeaveRequest');

// ─────────────────────────────────────────────
// ATTENDANCE LOGS
// ─────────────────────────────────────────────

// GET /api/attendance/logs?search=&date=YYYY-MM-DD
router.get('/logs', async (req, res) => {
  try {
    const { search, date } = req.query;
    const query = { isActive: true };
    if (date)   query.date = date;
    if (search) query.employeeName = { $regex: search, $options: 'i' };
    const logs = await Attendance.find(query).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/attendance/logs/:id
router.get('/logs/:id', async (req, res) => {
  try {
    const log = await Attendance.findById(req.params.id);
    if (!log) return res.status(404).json({ success: false, message: 'Log not found' });
    res.status(200).json({ success: true, data: log });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/attendance/logs — create
router.post('/logs', async (req, res) => {
  try {
    const { employeeId, employeeName, avatar, color, date, checkIn, checkOut, workHours, status } = req.body;
    if (!employeeId || !employeeName || !date) {
      return res.status(400).json({ success: false, message: 'employeeId, employeeName and date are required' });
    }
    const log = await Attendance.create({ employeeId, employeeName, avatar, color, date, checkIn, checkOut, workHours, status });
    res.status(201).json({ success: true, data: log, message: 'Attendance log created' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/attendance/logs/:id — update check-in/out/status
router.put('/logs/:id', async (req, res) => {
  try {
    const log = await Attendance.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!log) return res.status(404).json({ success: false, message: 'Log not found' });
    res.status(200).json({ success: true, data: log, message: 'Log updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/attendance/logs/:id — soft delete
router.delete('/logs/:id', async (req, res) => {
  try {
    const log = await Attendance.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!log) return res.status(404).json({ success: false, message: 'Log not found' });
    res.status(200).json({ success: true, message: 'Log deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/attendance/stats?date=YYYY-MM-DD
router.get('/stats', async (req, res) => {
  try {
    const date  = req.query.date || new Date().toISOString().split('T')[0];
    const logs  = await Attendance.find({ date });
    const total   = logs.length;
    const onTime  = logs.filter(l => l.status === 'On Time').length;
    const late    = logs.filter(l => l.status === 'Late').length;
    const absent  = logs.filter(l => l.status === 'Absent').length;
    const halfDay = logs.filter(l => l.status === 'Half Day').length;
    const pct = n => total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0%';
    res.status(200).json({ success: true, data: { date, total, onTime: { count: onTime, percentage: pct(onTime) }, late: { count: late, percentage: pct(late) }, absent: { count: absent, percentage: pct(absent) }, halfDay: { count: halfDay, percentage: pct(halfDay) } } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
// LEAVE REQUESTS
// ─────────────────────────────────────────────

// GET /api/attendance/leaves?search=&status=
router.get('/leaves', async (req, res) => {
  try {
    const { search, status } = req.query;
    const query = { isActive: true };
    if (status) query.status = status;
    if (search) query.employeeName = { $regex: search, $options: 'i' };
    const leaves = await LeaveRequest.find(query).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: leaves });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/attendance/leaves/:id
router.get('/leaves/:id', async (req, res) => {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });
    res.status(200).json({ success: true, data: leave });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/attendance/leaves — submit leave request
router.post('/leaves', async (req, res) => {
  try {
    const { employeeId, employeeName, avatar, color, type, fromDate, toDate, duration, reason } = req.body;
    if (!employeeId || !employeeName || !type || !fromDate || !toDate || !duration) {
      return res.status(400).json({ success: false, message: 'employeeId, employeeName, type, fromDate, toDate and duration are required' });
    }
    const leave = await LeaveRequest.create({ employeeId, employeeName, avatar, color, type, fromDate, toDate, duration, reason });
    res.status(201).json({ success: true, data: leave, message: 'Leave request submitted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/attendance/leaves/:id — approve / reject
router.put('/leaves/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be Pending, Approved or Rejected' });
    }
    const leave = await LeaveRequest.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });
    res.status(200).json({ success: true, data: leave, message: `Leave request ${status.toLowerCase()}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/attendance/leaves/:id — soft delete
router.delete('/leaves/:id', async (req, res) => {
  try {
    const leave = await LeaveRequest.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });
    res.status(200).json({ success: true, message: 'Leave request deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
