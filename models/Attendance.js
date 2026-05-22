const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  employeeId:   { type: String, default: '' },
  employeeName: { type: String, required: true, trim: true },
  avatar:       { type: String, default: '' },
  color:        { type: String, default: '#4299E1' },
  date:         { type: String, required: true },   // "YYYY-MM-DD"
  checkIn:      { type: String, default: '--:--' },
  checkOut:     { type: String, default: '--:--' },
  workHours:    { type: String, default: '--' },
  status:       { type: String, enum: ['On Time', 'Late', 'Absent', 'Half Day'], default: 'On Time' },
  isActive:     { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Attendance', attendanceSchema);
