const mongoose = require('mongoose');

const leaveRequestSchema = new mongoose.Schema({
  employeeId:   { type: String, default: '' },
  employeeName: { type: String, required: true, trim: true },
  avatar:       { type: String, default: '' },
  color:        { type: String, default: '#4299E1' },
  type:         { type: String, required: true, enum: ['Sick Leave', 'Annual Leave', 'Casual Leave', 'Permission (2h)', 'Maternity Leave', 'Other'] },
  fromDate:     { type: String, required: true },
  toDate:       { type: String, required: true },
  duration:     { type: String, required: true },
  reason:       { type: String, default: '' },
  status:       { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
  isActive:     { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('LeaveRequest', leaveRequestSchema);
