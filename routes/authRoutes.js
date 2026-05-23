// routes/authRoutes.js — Login / Register / Password Reset
const express       = require('express');
const router        = express.Router();
const bcrypt        = require('bcryptjs');
const User          = require('../models/User');
const generateToken = require('../utils/generateToken');
const { protect }   = require('../middleware/authMiddleware');

// POST /api/auth/check-email
router.post('/check-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    const user = await User.findOne({ email: email.toLowerCase() }).select('_id name email');
    return res.status(200).json({ success: true, exists: !!user, next: user ? 'signin' : 'signup', user: user ? { name: user.name, email: user.email } : null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/authenticate — smart signin / signup
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

    // New user signup
    if (!name) return res.status(400).json({ success: false, message: 'No account found with this email. Please sign up first.' });
    const newUser = await User.create({ name: name.trim(), email: email.toLowerCase(), password, role: role || 'employee', phone: phone || '' });
    const token   = generateToken(newUser._id, newUser.role);
    return res.status(201).json({ success: true, message: 'Account created successfully', token, user: newUser.toSafeObject() });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/forgot-password
// Works with ANY email:
//   - if account exists → return reset token
//   - if account does NOT exist → create it with a temp password, return reset token so user can set their own password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // Auto-create account so any email can use forgot password
      const displayName = email.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      user = await User.create({
        name:     displayName,
        email:    email.toLowerCase(),
        password: 'temp_' + Date.now(),
        role:     'employee',
      });
    }

    const resetToken = Buffer.from(String(user._id)).toString('base64');
    return res.status(200).json({ success: true, message: 'Email verified. Set your new password below.', resetToken });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { resetToken, password } = req.body;
    if (!resetToken || !password) return res.status(400).json({ success: false, message: 'Token and new password are required' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });

    const userId = Buffer.from(resetToken, 'base64').toString('utf8');
    const salt   = await bcrypt.genSalt(10);
    const hashed = await bcrypt.hash(password, salt);

    const user = await User.findByIdAndUpdate(userId, { password: hashed }, { new: true });
    if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });

    const token = generateToken(user._id, user.role);
    return res.status(200).json({ success: true, message: 'Password set successfully. You are now logged in.', token, user: user.toSafeObject() });
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

module.exports = router;
