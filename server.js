// Load .env only in development - on Render, env vars are injected by the platform
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express        = require('express');
const cors           = require('cors');
const morgan         = require('morgan');
const connectDB      = require('./config/db');
const { startKeepAlive } = require('./keepAlive');
const { importMobileUsers } = require('./migrations/importFromMobile');
const { seedCompanyData }   = require('./migrations/seedCompanyData');

const app = express();

// ─── CORS — manual middleware ────────────────────────────────────────
// Earlier versions used `app.use(cors())` from the `cors` npm package,
// but on Render's edge a tiny subset of OPTIONS preflight requests were
// landing in the 404 handler before the package's middleware finished
// attaching headers. Result: browsers saw "No 'Access-Control-Allow-
// Origin' header" and blocked every request from the Vercel frontend.
//
// This manual implementation is bulletproof because:
//   1. It sets the headers as the very FIRST thing on every request,
//      before any other middleware can run or fail.
//   2. It short-circuits OPTIONS preflight with a 204 immediately, so
//      Express never routes preflights through the rest of the stack.
//   3. It echoes the actual Origin header back (required for
//      credentials: true — wildcard `*` is forbidden when credentials
//      are sent).
//
// Optional tightening: set CORS_ORIGINS=https://a.com,https://b.com on
// the Render env to restrict to specific origins. If unset, every
// origin is reflected (open mode, fine while you're shipping).
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))   // tolerate trailing slashes in the env var
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin.replace(/\/+$/, ''));
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      // Echo whatever the browser asked for in Access-Control-Request-
      // Headers; fall back to the explicit list of headers our frontend
      // is known to send. Echoing means we never have to update this
      // file when the frontend starts using a new header.
      req.headers['access-control-request-headers'] ||
        'Content-Type, Authorization, X-Admin-Email, X-Admin-Secret, X-Requested-With'
    );
    res.setHeader('Access-Control-Max-Age', '600');
  }
  // Short-circuit preflight here so it never falls through to the
  // global write-gate, the routes, or the 404 handler — any of which
  // could strip our headers or return a non-204 status.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// 12 MB ceiling — Announcement attachments are stored inline as base64
// (max ~5 MB per file, ~6 MB after base64 inflation, plus a few attachments).
// Other endpoints don't approach this, so the larger limit is harmless.
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(morgan('dev'));

// Health check
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'HRM Backend API is running',
    timestamp: new Date().toISOString(),
  });
});

// ─── Diagnostic — read-only, no auth ─────────────────────────────────
// Surfaces exactly what's in the DB so an empty-screen problem can be
// triaged in one click instead of guessing between "DB connection
// broken", "collection wiped", or "filter hiding everything".
//
// For each major collection it returns:
//   • totalAll       — every doc, regardless of soft-delete state
//   • visibleActive  — what the normal HRMS UI sees (isActive !== false)
//
// If totalAll is 0, the DB is empty / wrong cluster / connection broken.
// If totalAll > 0 but visibleActive is 0, a soft-delete migration hid them.
// If both are high but the frontend shows zero, the issue is on the
// frontend / proxy side, not the DB.
// Health probe — used by the keepAlive self-ping (see keepAlive.js).
app.get('/api/_health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/_diag', async (req, res) => {
  const mongoose = require('mongoose');
  const out = {
    success: true,
    timestamp: new Date().toISOString(),
    env: {
      hasMongoUri:        Boolean(process.env.MONGO_URI),
      hasMobileSecret:    Boolean(process.env.MOBILE_ADMIN_SECRET),
      mobileApi:          process.env.MOBILE_API_URL || null,
      corsRestricted:     Boolean(process.env.CORS_ORIGINS),
      nodeEnv:            process.env.NODE_ENV || null,
    },
    mongo: {
      readyState:   mongoose.connection.readyState,
      readyLabel:   ['disconnected','connected','connecting','disconnecting'][mongoose.connection.readyState] || 'unknown',
      host:         mongoose.connection.host || null,
      name:         mongoose.connection.name || null,
    },
    collections: {},
  };
  // Each entry is [model name, file path]. Wrap in try so a single
  // broken model doesn't take down the whole diagnostic.
  const checks = [
    ['Employee',     './models/Employee'],
    ['Department',   './models/Department'],
    ['Designation',  './models/Designation'],
    ['Asset',        './models/Asset'],
    ['Attendance',   './models/Attendance'],
    ['LeaveRequest', './models/LeaveRequest'],
    ['Announcement', './models/Announcement'],
  ];
  for (const [label, path] of checks) {
    try {
      const M = require(path);
      const [totalAll, visibleActive] = await Promise.all([
        M.countDocuments({}),
        M.countDocuments({ isActive: { $ne: false } }),
      ]);
      out.collections[label] = { totalAll, visibleActive };
    } catch (e) {
      out.collections[label] = { error: e.message };
    }
  }
  res.status(200).json(out);
});

// ════════════════════════════════════════════════════════════════════════
// GLOBAL ADMIN WRITE GATE
//
// Only the three configured admin emails can mutate HRMS data. We enforce
// this at the server level so every write endpoint is protected by
// default — far safer than threading `requireAdmin` through dozens of
// route handlers and missing one.
//
// Skipped:
//   • GET / OPTIONS / HEAD  — read-only, anyone can view
//   • /api/auth/*           — login / signup / forgot-password are open
//   • /api/notifications    — read-only feed, GET-only anyway
//   • /api/dashboard        — read-only
//
// For every other POST / PUT / PATCH / DELETE the request must carry
// either a JWT belonging to an admin OR the `x-admin-email` header
// matching the allowlist. Non-admins receive a 403 with code READ_ONLY,
// which the frontend turns into a friendly "view-only mode" notice.
// ════════════════════════════════════════════════════════════════════════
const { isAdminEmail } = require('./middleware/authMiddleware');
const READ_ONLY_PATH_ALLOWLIST = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/notifications(\/|$)/,
];

app.use((req, res, next) => {
  // Anyone can read or run the preflight.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Auth endpoints + read-only collections stay open for write too
  // (login is a POST, send-otp is a POST, etc.).
  if (READ_ONLY_PATH_ALLOWLIST.some((re) => re.test(req.path))) return next();

  // Admin email may come from the JWT (set later by `protect` on a few
  // routes) OR — and this is the path the HRMS frontend uses — from the
  // `x-admin-email` header which the React app attaches to every request
  // after a successful login.
  const headerEmail = req.headers['x-admin-email'];
  if (headerEmail && isAdminEmail(headerEmail)) return next();

  // A few routes use the mobile admin secret (the HRMS backend talking to
  // its own mobile-side admin endpoints). Those are server-to-server, so
  // we trust them too.
  if (req.headers['x-admin-secret']) return next();

  return res.status(403).json({
    success: false,
    code:    'READ_ONLY',
    message: 'View-only mode: only HR admins can make changes. Sign in with an admin account to edit.',
  });
});

// Routes
app.use('/api/auth',              require('./routes/authRoutes'));
app.use('/api/dashboard',         require('./routes/dashboardRoutes'));
app.use('/api/departments',       require('./routes/departmentRoutes'));
app.use('/api/designations',      require('./routes/designationRoutes'));
app.use('/api/managers',          require('./routes/managerRoutes'));
app.use('/api/employees',         require('./routes/employeeRoutes'));
app.use('/api/attendance',        require('./routes/attendanceRoutes'));
app.use('/api/reports',           require('./routes/reportRoutes'));
app.use('/api/access-management', require('./routes/accessManagementRoutes'));
app.use('/api/announcements',     require('./routes/announcementRoutes'));
app.use('/api/assets',            require('./routes/assetRoutes'));
app.use('/api/complaints',        require('./routes/complaintRoutes'));
app.use('/api/leave-requests',    require('./routes/leaveRequestRoutes'));
app.use('/api/allowances',        require('./routes/allowanceRoutes'));
app.use('/api/payroll',           require('./routes/payrollRoutes'));
app.use('/api/admin',             require('./routes/adminCleanupRoutes'));
app.use('/api/settings',          require('./routes/settingsRoutes'));
app.use('/api/live-tracking',     require('./routes/liveTrackingRoutes'));
app.use('/api/notifications',     require('./routes/notificationRoutes'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found: ' + req.method + ' ' + req.originalUrl });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 8000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log('\nHRM Backend running on port ' + PORT + ' [' + (process.env.NODE_ENV || 'development') + ']');
    console.log('  API base: http://localhost:' + PORT + '/api\n');

        // Self-ping every 10 minutes so the service doesn't sleep on
    // Render's free tier. Skipped automatically in dev (RENDER_EXTERNAL_URL
    // is unset), enabled in production via Render's injected env var.
    startKeepAlive(PORT);

    // One-shot import + seed. The import-from-mobile job runs once on
    // startup to copy any new mobile users into the local Employee model;
    // the seed populates default departments / designations on first
    // boot so an empty install still has dropdown choices in HRMS.
    importMobileUsers().catch((e) => console.error('[import] failed:', e.message));
    seedCompanyData().catch((e) => console.error('[seed] failed:', e.message));
  });
}).catch((err) => {
  console.error('Could not start HRM Backend:', err.message);
  process.exit(1);
});
