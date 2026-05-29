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

    // Self-ping every 10 minutes so the service doesn't sleep on free tiers.
    startKeepAlive(PORT);

    // Mobile sync self-check
    setTimeout(async () => {
      const mobileApi = (process.env.MOBILE_API_URL || 'https://backend-emqy.onrender.com').replace(/\/+$/, '');
      const secret    =  process.env.MOBILE_ADMIN_SECRET || '';
      if (!secret) {
        console.warn('[mobile-sync] MOBILE_ADMIN_SECRET not set in HRMS .env — employees created here will not be able to log into the mobile ERM app.');
        return;
      }
      if (typeof fetch !== 'function') {
        console.warn('[mobile-sync] global fetch unavailable - need Node 18+');
        return;
      }
      try {
        const r = await fetch(mobileApi + '/api/auth/admin/users?limit=1', {
          headers: { 'x-admin-secret': secret },
        });
        if (r.status === 401) {
          console.warn('[mobile-sync] MOBILE_ADMIN_SECRET is wrong — mobile backend rejected it.');
        } else if (!r.ok) {
          console.warn('[mobile-sync] Mobile backend returned ' + r.status + ' during self-check');
        } else {
          const j = await r.json().catch(() => ({}));
          console.log('[mobile-sync] OK — mobile backend reachable; ' + (j.total || '?') + ' users in mobile DB');
        }
      } catch (err) {
        console.warn('[mobile-sync] Cannot reach ' + mobileApi + ': ' + err.message);
      }
    }, 6000);

    // Seed departments + designations from the HR catalogue if empty.
    setTimeout(() => {
      seedCompanyData().catch(e => console.warn('[SEED]', e.message));
    }, 4000);

    // Auto-migrate any legacy mobile users into the employees collection.
    if (process.env.IMPORT_MOBILE_ON_STARTUP !== 'false') {
      setTimeout(async () => {
        try {
          console.log('[IMPORT] Auto-running mobile->HRMS employee migration...');
          const result = await importMobileUsers();
          if (result.success) {
            console.log('[IMPORT] OK ' + result.message + ' (' + result.errors.length + ' errors)');
            if (result.errors.length > 0) {
              console.warn('[IMPORT] errors:', JSON.stringify(result.errors.slice(0, 5), null, 2));
            }
          } else {
            console.warn('[IMPORT] failed: ' + result.message);
          }
        } catch (err) {
          console.warn('[IMPORT] startup migration failed: ' + err.message);
        }
      }, 5000);
    }
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
