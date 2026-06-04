// routes/authRoutes.js — Sign in / Sign up / Forgot Password (OTP)
//
// Public endpoints:
//   POST /api/auth/register        — create account
//   POST /api/auth/login           — sign in with email + password
//   POST /api/auth/send-otp        — email a 6-digit OTP for password reset
//   POST /api/auth/verify-otp      — exchange OTP for a short-lived reset token
//   POST /api/auth/reset-password  — set new password using reset token
//   POST /api/auth/authenticate    — legacy smart sign-in / sign-up
//   POST /api/auth/check-email     — does an account exist for this email?
//   GET  /api/auth/me              — current logged-in user (JWT required)
//
const express       = require('express');
const router        = express.Router();
const bcrypt        = require('bcryptjs');
const User          = require('../models/User');
const generateToken = require('../utils/generateToken');
const { protect }   = require('../middleware/authMiddleware');
const { sendOtpEmail } = require('../utils/emailService');

const OTP_TTL_MS = 10 * 60 * 1000;  // 10 min

// ── HRMS access policy (Jun 2026) ───────────────────────────────────────
// HRMS login is now restricted to exactly these two HR / admin accounts.
// Anyone else hitting /login, /send-otp, /reset-password gets 403. Self-
// service signup has been removed — there is no /register UI anymore.
// Both seed accounts are created at boot with the default ADMINTESCO
// password; HR can change it via Forgot Password → OTP → New Password.
const ALLOWED_EMAILS = [
  'tescostructures@gmail.com',
  'hr@tescostructures.in',
];
const SEED_PASSWORD = 'ADMINTESCO';

function isAllowed(email) {
  return ALLOWED_EMAILS.includes(String(email || '').toLowerCase().trim());
}

// One-shot: ensure both whitelisted accounts exist + are active. Called
// once on require() so the very first /login attempt after a fresh deploy
// already has a user document to authenticate against.
async function seedHrmsAccounts() {
  try {
    for (const email of ALLOWED_EMAILS) {
      const existing = await User.findOne({ email });
      if (existing) {
        // Make sure they stay active even if HR was deactivated by mistake.
        if (!existing.isActive) {
          existing.isActive = true;
          await existing.save();
        }
        // Optional admin escape hatch — set SEED_RESET_PWD=1 on the
        // backend env once if HR locks themselves out, then unset.
        if (/^(1|true|yes)$/i.test(process.env.SEED_RESET_PWD || '')) {
          existing.password = SEED_PASSWORD;
          await existing.save();
          console.log('[auth.seed] reset password for', email);
        }
        continue;
      }
      await User.create({
        name:  email === 'hr@tescostructures.in' ? 'HR Admin' : 'Tesco Structures',
        email,
        password: SEED_PASSWORD,
        role:  'admin',
        isActive: true,
      });
      console.log('[auth.seed] created HRMS account', email);
    }
  } catch (e) {
    console.warn('[auth.seed] failed:', e.message);
  }
}
// Best-effort — fires after Mongo is connected (the app boots before
// connection completes, so we wait one tick).
setTimeout(seedHrmsAccounts, 3000);


function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// POST /api/auth/check-email — only allowlisted HR / admin emails respond.
router.post('/check-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    if (!isAllowed(email)) {
      return res.status(403).json({ success: false, message: 'This email is not authorised to access HRMS.' });
    }
    const user = await User.findOne({ email: email.toLowerCase() }).select('_id name email');
    return res.status(200).json({
      success: true,
      exists: !!user,
      next: 'signin',
      user: user ? { name: user.name, email: user.email } : null,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/register — DISABLED (Jun 2026). Self-service signup is
// gone. HRMS access is restricted to the two seeded HR / admin accounts.
router.post('/register', async (req, res) => {
  return res.status(403).json({
    success: false,
    message: 'Self-service signup is disabled. Contact your administrator for HRMS access.',
  });
});
router.post('/register_DISABLED', async (req, res) => {
  try {
    const { name, email, password, role, phone } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }
    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'An account with this email already exists. Please sign in instead.' });
    }
    const user  = await User.create({
      name:  name.trim(),
      email: email.toLowerCase().trim(),
      password,
      role:  role || 'employee',
      phone: phone || '',
    });
    const token = generateToken(user._id, user.role);
    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      token,
      user: user.toSafeObject(),
    });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/login — sign in
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }
    if (!isAllowed(email)) {
      return res.status(403).json({ success: false, message: 'This email is not authorised to access HRMS.' });
    }
    const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
    if (!user) return res.status(401).json({ success: false, message: 'Account not yet provisioned. Contact your administrator.' });
    if (!user.isActive) return res.status(403).json({ success: false, message: 'Account deactivated. Contact admin.' });
    const ok = await user.matchPassword(password);
    if (!ok) return res.status(401).json({ success: false, message: 'Incorrect password. Please try again.' });
    user.lastLogin = new Date();
    await user.save();
    const token = generateToken(user._id, user.role);
    return res.status(200).json({
      success: true,
      message: 'Sign in successful.',
      token,
      user: user.toSafeObject(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/authenticate — legacy smart sign-in/sign-up wrapper
router.post('/authenticate', async (req, res) => {
  try {
    const { email, password, name, role, phone } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });

    const existing = await User.findOne({ email: email.toLowerCase() }).select('+password');

    if (existing) {
      if (name) {
        return res.status(400).json({ success: false, message: 'An account with this email already exists. Please sign in instead.' });
      }
      if (!existing.isActive) return res.status(403).json({ success: false, message: 'Account deactivated. Contact admin.' });
      const match = await existing.matchPassword(password);
      if (!match) return res.status(401).json({ success: false, message: 'Incorrect password. Please try again.' });
      existing.lastLogin = new Date();
      await existing.save();
      const token = generateToken(existing._id, existing.role);
      return res.status(200).json({ success: true, message: 'Sign in successful', token, user: existing.toSafeObject() });
    }

    if (!name) return res.status(400).json({ success: false, message: 'No account found with this email. Please sign up first.' });
    const newUser = await User.create({ name: name.trim(), email: email.toLowerCase(), password, role: role || 'employee', phone: phone || '' });
    const token   = generateToken(newUser._id, newUser.role);
    return res.status(201).json({ success: true, message: 'Account created successfully', token, user: newUser.toSafeObject() });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/send-otp — start a forgot-password flow
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    if (!isAllowed(email)) {
      return res.status(403).json({ success: false, message: 'This email is not authorised to access HRMS.' });
    }
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Account not yet provisioned. Contact your administrator.' });
    }
    const otp = genOtp();
    user.otp        = otp;
    user.otpExpires = new Date(Date.now() + OTP_TTL_MS);
    await user.save();
    const sent = await sendOtpEmail({ to: user.email, otp, name: user.name });
    return res.status(200).json({
      success: true,
      message: sent
        ? 'OTP sent to your email. Check your inbox (and spam).'
        : 'OTP generated. Email service is not configured — check the server console for the code.',
      delivered: sent,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/verify-otp — exchange OTP for a short-lived reset token
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    if (!email || !otp) return res.status(400).json({ success: false, message: 'Email and OTP are required.' });
    const user = await User.findOne({ email: email.toLowerCase() }).select('+otp +otpExpires');
    if (!user) return res.status(404).json({ success: false, message: 'No account found.' });
    if (!user.otp || !user.otpExpires) return res.status(400).json({ success: false, message: 'No OTP requested. Please request one first.' });
    if (user.otpExpires < new Date()) return res.status(400).json({ success: false, message: 'OTP has expired. Request a new one.' });
    if (String(user.otp) !== String(otp).trim()) return res.status(401).json({ success: false, message: 'Incorrect OTP.' });
    // OTP verified — issue a base64 reset token tied to this user, valid
    // for another 10 min. We clear the OTP so it can't be reused.
    user.otp        = undefined;
    user.otpExpires = undefined;
    await user.save();
    const resetToken = Buffer.from(String(user._id) + ':' + Date.now()).toString('base64');
    return res.status(200).json({ success: true, message: 'OTP verified. Set a new password.', resetToken });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/reset-password — finish the forgot-password flow
router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, password } = req.body || {};
    if (!resetToken || !password) return res.status(400).json({ success: false, message: 'Token and new password are required.' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

    let userId, issuedAt;
    try {
      const raw = Buffer.from(resetToken, 'base64').toString('utf8');
      const parts = raw.split(':');
      userId   = parts[0];
      issuedAt = parts[1] ? parseInt(parts[1], 10) : 0;
    } catch {
      return res.status(400).json({ success: false, message: 'Invalid reset token.' });
    }
    if (!issuedAt || Date.now() - issuedAt > OTP_TTL_MS) {
      return res.status(400).json({ success: false, message: 'Reset token has expired. Start the forgot-password flow again.' });
    }
    const salt   = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);
    const user = await User.findByIdAndUpdate(userId, { password: hashed }, { new: true });
    if (!user) return res.status(400).json({ success: false, message: 'Invalid reset token.' });
    const token = generateToken(user._id, user.role);
    return res.status(200).json({
      success: true,
      message: 'Password reset successfully. You are now logged in.',
      token,
      user: user.toSafeObject(),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// LEGACY: POST /api/auth/forgot-password — kept so existing UI still works
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ success: false, message: 'Email is required.' });
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(404).json({ success: false, message: 'No account found with this email. Please sign up first.' });
    const otp = genOtp();
    user.otp        = otp;
    user.otpExpires = new Date(Date.now() + OTP_TTL_MS);
    await user.save();
    const sent = await sendOtpEmail({ to: user.email, otp, name: user.name });
    return res.status(200).json({
      success:   true,
      message:   sent ? 'OTP sent to your email.' : 'OTP generated. Email not configured — see server console.',
      delivered: sent,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json({ success: true, user: user.toSafeObject() });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});


// POST /api/auth/change-password — logged-in user changes their own password.
// Header: Authorization: Bearer <jwt>   Body: { oldPassword, newPassword }
router.post('/change-password', protect, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, message: 'oldPassword and newPassword are required.' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters.' });
    }
    const user = await User.findById(req.user.id).select('+password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    const ok = await user.matchPassword(oldPassword);
    if (!ok) return res.status(401).json({ success: false, message: 'Current password is incorrect.' });
    user.password = newPassword;            // hashed by the pre('save') hook
    await user.save();
    return res.status(200).json({ success: true, message: 'Password updated successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
