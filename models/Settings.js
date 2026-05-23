/**
 * Settings — single-document collection for company-wide configuration.
 * There is always exactly ONE row (key: 'global'). Reads upsert it with
 * defaults if it doesn't exist, so the frontend never gets a 404.
 */
const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true, index: true },

    company: {
      name:       { type: String, default: 'Tesco Structures' },
      address:    { type: String, default: '' },
      phone:      { type: String, default: '' },
      email:      { type: String, default: '' },
      website:    { type: String, default: '' },
      logoUrl:    { type: String, default: '' },
      gstNumber:  { type: String, default: '' },
      panNumber:  { type: String, default: '' },
    },

    workingHours: {
      start:        { type: String, default: '09:30' },
      end:          { type: String, default: '18:30' },
      breakMinutes: { type: Number, default: 60 },
      // Mon=1 .. Sun=7
      workingDays:  { type: [Number], default: [1, 2, 3, 4, 5] },
    },

    leavePolicy: {
      annualLeave:       { type: Number, default: 12 },
      sickLeave:         { type: Number, default: 6  },
      casualLeave:       { type: Number, default: 6  },
      permissionPerMonth:{ type: Number, default: 2  },
      permissionHours:   { type: Number, default: 2  },
      carryForward:      { type: Boolean,default: false },
    },

    payroll: {
      cycle:        { type: String, enum: ['Monthly', 'Bi-monthly', 'Weekly'], default: 'Monthly' },
      payDay:       { type: Number, default: 1 },       // day-of-month
      currency:     { type: String, default: 'INR' },
      pfPercent:    { type: Number, default: 12 },
      professionalTax:{ type: Number, default: 200 },
      tdsPercent:   { type: Number, default: 10 },
    },

    notifications: {
      email:           { type: Boolean, default: true },
      inApp:           { type: Boolean, default: true },
      announcement:    { type: Boolean, default: true },
      attendanceAlerts:{ type: Boolean, default: true },
    },

    branding: {
      primaryColor:   { type: String, default: '#4CAA17' },
      secondaryColor: { type: String, default: '#1E293B' },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
