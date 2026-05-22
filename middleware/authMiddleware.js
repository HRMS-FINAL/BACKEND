// middleware/authMiddleware.js — JWT verification + role authorization
const jwt  = require('jsonwebtoken');
const User = require('../models/User');

/**
 * protect — verify JWT token, attach req.user
 */
exports.protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authorized — no token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user    = await User.findById(decoded.id);

    if (!user)          return res.status(401).json({ success: false, message: 'Token is valid but user no longer exists' });
    if (!user.isActive) return res.status(403).json({ success: false, message: 'Account has been deactivated' });

    req.user = { id: user._id, role: user.role, email: user.email };
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError')  return res.status(401).json({ success: false, message: 'Invalid token' });
    if (error.name === 'TokenExpiredError')  return res.status(401).json({ success: false, message: 'Token has expired, please log in again' });
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }
};

/**
 * authorize(...roles) — restrict to specific roles
 * Usage: router.delete('/:id', protect, authorize('admin', 'hr'), handler)
 */
exports.authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Role '${req.user?.role}' is not authorized to access this resource`,
      });
    }
    next();
  };
};
