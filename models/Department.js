const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema({
  name:     { type: String, required: [true, 'Department name is required'], trim: true },
  manager:  { type: String, default: '', trim: true },
  budget:   { type: String, default: '', trim: true },
  color:    { type: String, default: '#A0AEC0' },
  status:   { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
  count:    { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Department', departmentSchema);
