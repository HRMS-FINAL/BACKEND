/**
 * Complaint routes — proxy to the Tesco ERM mobile backend.
 *
 * Mobile employees file complaints via the mobile app, which writes them
 * to the mobile backend's MongoDB. The HRMS web app (this server) doesn't
 * have its own complaints collection — instead these routes forward the
 * request to the mobile backend's admin API and reshape the response into
 * the format the HRMS ComplainRegister.jsx page expects.
 *
 * That means:
 *   • Zero schema duplication — single source of truth is the mobile DB
 *   • HRMS frontend keeps calling http://localhost:8001/api/... (no CORS)
 *   • The admin secret stays SERVER-SIDE (env var, never sent to browser)
 *
 * Required env vars on the HRMS backend:
 *   MOBILE_API_URL        e.g. https://backend-emqy.onrender.com
 *   MOBILE_ADMIN_SECRET   same value as ADMIN_SECRET on the mobile backend
 */

const express = require('express');
const router  = express.Router();

const MOBILE_API     = (process.env.MOBILE_API_URL    || 'https://backend-emqy.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET   =  process.env.MOBILE_ADMIN_SECRET || '';
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Reshape the mobile complaint document into the HRMS ComplainRegister
 * page's expected shape. The page renders fields: id, subject, priority
 * (Title-Case), date (YYYY-MM-DD), status (Title-Case), description.
 */
function priorityLabel(p) {
  if (!p) return 'Low';
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}
function statusLabel(s) {
  if (!s) return 'Open';
  if (s === 'in-progress') return 'In Progress';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Reject 24-char hex ObjectId strings — they look like data but aren't
// readable. Used to strip raw refs that occasionally leak from the
// mobile-side User doc when populate doesn't reach as deep as we need.
const isHexId = (s) => typeof s === 'string' && /^[a-f0-9]{24}$/i.test(s.trim());
function safeLabel(value, sidecar) {
  if (value && typeof value === 'object') {
    const t = value.title || value.name || '';
    if (t && !isHexId(t)) return t;
  }
  if (typeof value === 'string' && value && !isHexId(value)) return value;
  if (sidecar && typeof sidecar === 'string' && !isHexId(sidecar)) return sidecar;
  return '';
}

function reshape(c) {
  const created = c.createdAt ? new Date(c.createdAt) : new Date();
  const dateStr = isNaN(created.getTime())
    ? ''
    : created.toISOString().split('T')[0];
  const empId =
    (c.user?.employeeId || c.user?.userId) || '';
  const empName =
    c.user?.name ||
    ((c.user?.firstName || '') + ' ' + (c.user?.lastName || '')).trim() ||
    '';
  // Resolve designation / department to human labels — reject raw
  // ObjectIds, fall back to denormalised sidecar fields if necessary.
  const role = safeLabel(c.user?.designation, c.user?.designationTitle);
  const dept = safeLabel(c.user?.department,  c.user?.departmentName);
  return {
    _id:         c._id,                              // real Mongo id (used for PATCH)
    id:          empId || ('FB-' + String(c._id).slice(-6).toUpperCase()),
    employeeId:  empId,
    empId,
    employeeName: empName,
    subject:     c.subject  || '',
    description: c.description || '',
    priority:    priorityLabel(c.priority),
    status:      statusLabel(c.status),
    date:        dateStr,
    employee: {
      userId:      c.user?.userId      || empId,
      employeeId:  empId,
      name:        empName,
      email:       c.user?.email       || '',
      designation: role,                              // resolved title (no ObjectIds)
      department:  dept,                              // resolved dept name
    },
    hrResponse:   c.hrResponse  || '',
    respondedAt:  c.respondedAt || null,
    createdAt:    c.createdAt   || null,
  };
}

/** Helper — guard against missing config so we return a clear 503. */
function configReady(res) {
  if (!ADMIN_SECRET) {
    res.status(503).json({
      success: false,
      message: 'MOBILE_ADMIN_SECRET is not configured on the HRMS server. ' +
               'Set it in the backend .env to enable mobile complaints sync.',
    });
    return false;
  }
  return true;
}

// fetch in Node 18+. If older, this will throw on first call — surface clearly.
async function fwd(path, init = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available — Node 18+ required.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(MOBILE_API + path, {
      ...init,
      signal:  controller.signal,
      headers: {
        ...(init.headers || {}),
        'x-admin-secret': ADMIN_SECRET,
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/complaints
 * List ALL complaints from mobile backend, reshaped for the HRMS UI.
 * Optional query params: ?status=open|in-progress|resolved|closed
 *                        ?priority=low|medium|high|critical
 *                        ?limit=200
 */
router.get('/', async (req, res) => {
  if (!configReady(res)) return;
  try {
    const q = new URLSearchParams();
    if (req.query.status)   q.set('status',   req.query.status);
    if (req.query.priority) q.set('priority', req.query.priority);
    if (req.query.limit)    q.set('limit',    req.query.limit);
    const qs = q.toString() ? `?${q.toString()}` : '';

    const r    = await fwd(`/api/complaint/admin/all${qs}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: data?.message || `Mobile API responded ${r.status}`,
      });
    }
    const items   = Array.isArray(data.items) ? data.items.map(reshape) : [];
    const summary = data.summary || { total: items.length };
    res.json({ success: true, items, summary, total: summary.total ?? items.length });
  } catch (err) {
    console.error('[complaints proxy GET]', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  }
});

/**
 * PATCH /api/complaints/:id
 * Body: { status?, priority?, hrResponse? }
 * Forwards to PATCH /api/complaint/admin/:id on the mobile backend, which
 * also fires the in-app notification to the employee.
 *
 * Accepts either canonical lowercase values OR the Title-Case strings the
 * HRMS UI uses ("Resolved", "In Progress") and normalises before forwarding.
 */
router.patch('/:id', async (req, res) => {
  if (!configReady(res)) return;
  try {
    const body = req.body || {};
    const payload = {};
    if (body.status   !== undefined) {
      payload.status = String(body.status).toLowerCase().replace(/\s+/g, '-');
    }
    if (body.priority !== undefined) {
      payload.priority = String(body.priority).toLowerCase();
    }
    if (body.hrResponse !== undefined) {
      payload.hrResponse = String(body.hrResponse);
    }

    const r = await fwd(`/api/complaint/admin/${encodeURIComponent(req.params.id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: data?.message || `Mobile API responded ${r.status}`,
      });
    }
    res.json({
      success: true,
      complaint: data.complaint ? reshape(data.complaint) : null,
    });
  } catch (err) {
    console.error('[complaints proxy PATCH]', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  }
});

module.exports = router;
