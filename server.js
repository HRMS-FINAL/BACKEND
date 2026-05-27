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

// ─── CORS ────────────────────────────────────────────────────────────
// Allowed origins are pulled from the CORS_ORIGINS env var (comma-
// separated) so we can change them per environment without a code
// change. In development the env var is usually unset and we fall
// through to allowing all origins, which keeps `npm run dev` simple.
//
// Production setup: in your Render service env, add
//   CORS_ORIGINS=https://your-frontend.com,https://www.your-frontend.com
// Every entry must include the scheme (https://) and NO trailing slash.
//
// `credentials: true` lets the browser send cookies/auth headers if you
// ever switch from JWT-in-localStorage to httpOnly cookies later.
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // No origin = same-origin / curl / Postman / server-to-server — allow.
    if (!origin) return callback(null, true);
    // Empty allowlist in dev → allow everything so localhost works.
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS: origin not allowed → ' + origin), false);
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
