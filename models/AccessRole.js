// models/AccessRole.js — Access Management (previously Role)
const mongoose = require('mongoose');

const MODULES  = ['dashboard', 'employees', 'payroll', 'attendance', 'performance', 'settings', 'live_tracking'];

const permissionSchema = new mongoose.Schema(
  Object.fromEntries(MODULES.map(m => [m, {
    view:   { type: Boolean, default: false },
    create: { type: Boolean, default: false },
    edit:   { type: Boolean, default: false },
    delete: { type: Boolean, default: false },
  }])),
  { _id: false }
);

const accessRoleSchema = new mongoose.Schema({
  name:        { type: String, required: [true, 'Role name is required'], trim: true },
  description: { type: String, default: '', trim: true },
  color:       { type: String, default: '#4CAA17' },
  members:     { type: Number, default: 0 },
  permissions: { type: permissionSchema, default: () => ({}) },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('AccessRole', accessRoleSchema);
