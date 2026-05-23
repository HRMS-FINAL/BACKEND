const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name:     { type: String, required: [true, 'Name is required'], trim: true, minlength: 2, maxlength: 60 },
    email:    { type: String, required: [true, 'Email is required'], unique: true, lowercase: true, trim: true,
                match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email'] },
    password: { type: String, required: [true, 'Password is required'], minlength: 6, select: false },
    role:     { type: String, enum: ['admin', 'hr', 'employee'], default: 'employee' },
    phone:    { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true },
    lastLogin:{ type: Date, default: null },
    resetPasswordToken:  { type: String,  select: false },
    resetPasswordExpire: { type: Date,    select: false },
    // 6-digit OTP for forgot-password. Cleared after successful reset.
    otp:        { type: String, select: false },
    otpExpires: { type: Date,   select: false },
  },
  { timestamps: true }
);

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

userSchema.methods.matchPassword = async function (entered) {
  return bcrypt.compare(entered, this.password);
};

userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.__v;
  // Stamp `isAdmin` so the React app can hide / disable Save / Delete
  // buttons for non-admin sign-ins (view-only mode).
  try {
    const { isAdminEmail } = require('../middleware/authMiddleware');
    obj.isAdmin = isAdminEmail(this.email);
  } catch {
    obj.isAdmin = false;
  }
  return obj;
};

module.exports = mongoose.model('User', userSchema);
