// models/Employee.js
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const addressSchema = new mongoose.Schema(
  { street: { type: String, default: '' }, city: { type: String, default: '' },
    state:  { type: String, default: '' }, zipCode: { type: String, default: '' },
    country:{ type: String, default: '' } },
  { _id: false }
);

const educationSchema = new mongoose.Schema(
  {
    degree: {
      type: String, required: [true, 'Degree is required'],
      enum: { values: ['High School', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'PhD / Doctorate', 'Other Professional Certificate'], message: 'Invalid degree value' },
    },
    university:     { type: String, required: [true, 'University is required'], trim: true, minlength: 2 },
    fieldOfStudy:   { type: String, required: [true, 'Field of study is required'], trim: true },
    graduationYear: { type: Number, required: [true, 'Graduation year is required'], min: 1950, max: 2030 },
  },
  { _id: false }
);

const employeeSchema = new mongoose.Schema(
  {
    firstName:      { type: String, required: [true, 'First name is required'], trim: true, minlength: 2, maxlength: 40 },
    lastName:       { type: String, required: [true, 'Last name is required'],  trim: true, minlength: 1, maxlength: 40 },
    username:       { type: String, required: [true, 'Username is required'], trim: true, lowercase: true, unique: true, minlength: 3, maxlength: 30,
                      match: [/^[a-z0-9_.-]+$/, 'Username can only contain letters, numbers, dot, underscore and hyphen'] },
    password:       { type: String, required: [true, 'Password is required'], minlength: 6, select: false },
    email:          { type: String, required: [true, 'Email is required'], unique: true, lowercase: true, trim: true,
                      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email'] },
    // Every previous email this employee has had. We push the old value
    // onto this array whenever HR edits the email so login / forgot-password
    // by an OLD email keeps working. Indispensable when the HRMS edit
    // briefly silently-fails or when HR makes a typo and re-edits later.
    emailHistory:   { type: [String], default: [], index: true },
    phone:          { type: String, required: [true, 'Phone is required'], trim: true,
                      validate: { validator: v => /^\d{10,15}$/.test(v.replace(/[\s-]/g, '')), message: 'Phone must be at least 10 digits' } },
    address:        { type: addressSchema, default: () => ({}) },
    employeeId:     { type: String, unique: true, sparse: true, trim: true, uppercase: true },
    department:     { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: [true, 'Department is required'] },
    designation:    { type: mongoose.Schema.Types.ObjectId, ref: 'Designation', default: null },
    // Denormalised readable copies of the dept/designation, written
    // alongside the ObjectId references so the saved document shows the
    // actual name/title the admin selected (no need to JOIN to read it).
    // Kept in sync by the create/update routes.
    departmentName:   { type: String, default: '', trim: true },
    designationTitle: { type: String, default: '', trim: true },
    employmentType: { type: String, enum: ['Full-time', 'Part-time', 'Contract', 'Intern', ''], default: '' },
    joiningDate:    { type: Date, required: [true, 'Joining date is required'] },
    salary:         { type: Number, required: [true, 'Salary is required'], min: 0 },
    // assignedTo is OPTIONAL — top-level roles (Managing Director, CEO,
    // executive heads) have no manager above them, and Add Employee
    // needs to accept those rows too.
    assignedTo:     { type: String, default: '', trim: true },
    // Per-employee petrol-allowance opt-in (Jun 2026 HR brief). When
    // true, the petrol auto-bill computes amount = (GPS km on the day)
    // × ₹3.50 between check-in and check-out, and writes one allowance
    // row per workday. When false, this employee can't claim petrol.
    // Stays `undefined` for legacy rows so the department/name rules in
    // petrolGpsAllowlist.js still take effect until HR explicitly sets it.
    petrolEligible: { type: Boolean, default: undefined },
    education:      { type: educationSchema, required: true },
    status:         { type: String, enum: ['Active', 'Inactive', 'On Leave', 'Terminated'], default: 'Active' },
    isActive:       { type: Boolean, default: true },
    accessRole:     { type: mongoose.Schema.Types.ObjectId, ref: 'AccessRole', default: null },
    createdBy:      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Personal info shared with the mobile ERM app (same collection).
    dob:            { type: String, default: '', trim: true },   // ISO date string
    gender:         { type: String, default: '', trim: true },
    bloodGroup:     { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

// Auto-generate sequential employeeId if not supplied
employeeSchema.pre('validate', async function () {
  if (!this.employeeId) {
    const Employee = mongoose.model('Employee');
    const last = await Employee.findOne({}, { employeeId: 1 }).sort({ createdAt: -1 }).lean();
    let nextNum = 1001;
    if (last && last.employeeId) {
      const parts = last.employeeId.split('-');
      const n = parseInt(parts[parts.length - 1]);
      if (!isNaN(n)) nextNum = n + 1;
    }
    this.employeeId = `EMP-${nextNum}`;
  }
});

// Hash password before save
employeeSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

employeeSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

employeeSchema.set('toJSON',   { virtuals: true });
employeeSchema.set('toObject', { virtuals: true });

employeeSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model('Employee', employeeSchema);
