// routes/authRoutes.js — Login / Register
const express       = require('express');
const router        = express.Router();
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
      if (!existing.isActive) return res.status(403).json({ success: false, message: 'Account deactivated. Contact admin.' });
      const match = await existing.matchPassword(password);
      if (!match) return res.status(401).json({ success: false, message: 'Invalid credentials' });
      existing.lastLogin = new Date();
      await existing.save();
      const token = generateToken(existing._id, existing.role);
      return res.status(200).json({ success: true, message: 'Sign in successful', token, user: existing.toSafeObject() });
    }

    // New user signup
    if (!name) return res.status(400).json({ success: false, message: 'Name is required for new accounts', redirect: 'signup' });
    const newUser = await User.create({ name, email: email.toLowerCase(), password, role: role || 'employee', phone: phone || '' });
    const token   = generateToken(newUser._id, newUser.role);
    return res.status(201).json({ success: true, message: 'Account created', token, user: newUser.toSafeObject() });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'Email already exists' });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/auth/me — get current user
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
