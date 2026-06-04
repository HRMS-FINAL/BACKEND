// Manager directory — Jun 2026.
//
// A "Manager" entry is a (name, title) pair HR explicitly designates as a
// reporting-line target. The HRMS Add Employee + Employee List edit
// drawers populate their "Assigned To" dropdown from this collection
// (with the static MANAGERS list in Frontend/src/data/companyData.js as
// the seed fallback so existing employees keep their assignedTo values).
//
// When an entry's `email` matches an existing Employee row, the
// Manager-create route flips that employee's `role` to 'manager' so the
// person automatically gains ERM Web manager-side access.
const mongoose = require('mongoose');

const managerSchema = new mongoose.Schema(
  {
    name:  { type: String, required: true, trim: true },
    title: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

managerSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

module.exports = mongoose.model('Manager', managerSchema);
