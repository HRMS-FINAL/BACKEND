const mongoose = require('mongoose');

const designationSchema = new mongoose.Schema({
  title:     { type: String, required: [true, 'Designation title is required'], trim: true },
  dept:      { type: String, default: '', trim: true },
  minSalary: { type: Number, default: 0 },
  maxSalary: { type: Number, default: 0 },
  color:     { type: String, default: '#A0AEC0' },
  count:     { type: Number, default: 0 },
  isActive:  { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Designation', designationSchema);
