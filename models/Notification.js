// HRMS-side Notification model — points at the SAME `notifications`
// collection the mobile backend writes to (Mongoose default pluralisation
// of "Notification" → "notifications"), so an HRMS insert lands in the
// employee's ERM Web + ERM Mobile notification bell.
//
// Schema is intentionally `strict: false` so the mobile backend's
// extra fields (employeeId sidecar, etc.) round-trip unchanged.
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user:       { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeId: { type: String, default: '', uppercase: true, trim: true },
    title:      { type: String, required: true },
    body:       { type: String, default: '' },
    type: {
      type: String,
      enum: ['leave', 'attendance', 'allowance', 'payslip', 'announcement', 'general'],
      default: 'general',
    },
    isRead: { type: Boolean, default: false },
    link:   { type: String, default: '' },
  },
  {
    collection: 'notifications',
    timestamps: true,
    strict: false,
  }
);

module.exports = mongoose.model('HrmsNotification', notificationSchema);
