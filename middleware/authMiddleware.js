// middleware/authMiddleware.js — JWT verification + role authorization
const jwt  = require('jsonwebtoken');
const User = require('../models/User');

/**
 * ADMIN ALLOWLIST
 *
 * Only these three emails (case-insensitive) have edit / create / delete
 * permissions on the HRMS. Every other authenticated user lands in view-
 * only mode — they can still browse the dashboard, employees, reports
 * etc., but every POST / PUT / PATCH / DELETE returns 403.
 *
 * Overridable via the HRMS_ADMIN_EMAILS env var (comma-separated). If
 * the var is set, that list REPLACES the defaults — useful for staging
 * environments that want different admins.
 */
const DEFAULT_ADMIN_EMAILS = [
  'tescodigitals26@gmail.com',
  'tescostructures@gmail.com',
  'hr@tescostructures.in',
];
const ADMIN_EMAILS = (process.env.HRMS_ADMIN_EMAILS
  ? process.env.HRMS_ADMIN_EMAILS.split(',')
  : DEFAULT_ADMIN_EMAILS
).map((e) => e.trim().toLowerCase()).filter(Boolean);

/** Returns true if the supplied email matches the admin allowlist. */
exports.isAdminEmail = (email) =>
  !!email && ADMIN_EMAILS.includes(String(email).trim().toLowerCase());

/** The whole allowlist — used by the auth routes to stamp `isAdmin` on
    the user payload returned to the client, so the React app can hide /
    disable write controls. */
exports.ADMIN_EMAILS = ADMIN_EMAILS;

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

    req.user = {
      id:      user._id,
      role:    user.role,
      email:   user.email,
      isAdmin: exports.isAdminEmail(user.email),
    };
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError')  return res.status(401).json({ success: false, message: 'Invalid token' });
    if (error.name === 'TokenExpiredError')  return res.status(401).json({ success: false, message: 'Token has expired, please log in again' });
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }
};

/**
 * requireAdmin — gate write operations to the email allowlist.
 *
 * Use as the SECOND middleware after `protect`. Returns 403 with a clear
 * read-only message so the frontend can show "Contact HR" or similar
 * instead of a generic "not authorised". Some routes don't use the JWT
 * middleware (the mobile admin-secret proxy paths) — for those we fall
 * back to checking the request body or a custom header sent by the HRMS
 * frontend.
 */
exports.requireAdmin = (req, res, next) => {
  // Path 1 — protect() already ran and set req.user.isAdmin.
  if (req.user && req.user.isAdmin) return next();

  // Path 2 — route bypassed protect() (e.g. department/designation CRUD
  // currently has no JWT layer). The HRMS frontend sends the signed-in
  // user's email in `x-admin-email` so we can still gate writes.
  const headerEmail = req.headers['x-admin-email'];
  if (headerEmail && exports.isAdminEmail(headerEmail)) return next();

  return res.status(403).json({
    success: false,
    code:    'READ_ONLY',
    message: 'Read-only mode: only the configured HR admins can make changes. ' +
             'Sign in with an admin account to edit.',
  });
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
