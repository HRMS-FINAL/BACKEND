/**
 * Allowance routes - proxy to the Tesco ERM mobile backend.
 *
 * Employees submit petrol/travel allowance requests from the mobile app,
 * which stores them in the mobile backend's MongoDB. The HRMS web app
 * forwards the request via this proxy and reshapes the response into the
 * exact field shape the existing HRMS Allowance.jsx page expects:
 *
 *   { id, empName, from, to, distance, amount, status, date }
 *
 * The HRMS frontend doesn't change UI - only its data source flips from
 * hardcoded mock arrays to this endpoint.
 *
 * Required env vars on the HRMS backend (.env):
 *   MOBILE_API_URL        e.g. https://backend-9rtc.onrender.com
 *   MOBILE_ADMIN_SECRET   same value as ADMIN_SECRET on the mobile backend
 */

const express = require('express');
const router  = express.Router();

const MOBILE_API      = (process.env.MOBILE_API_URL    || 'https://backend-9rtc.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET    =  process.env.MOBILE_ADMIN_SECRET || '';
const FETCH_TIMEOUT_MS = 30000;

/* Helpers */
function titleCaseStatus(s) {
  if (!s) return 'Pending';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
function shortId(_id, type) {
  const prefix = type === 'petrol' ? 'REQ' : 'TRV';
  return `${prefix}-${String(_id).slice(-6).toUpperCase()}`;
}

/** Pick the most readable employee ID + display name from a populated user. */
function pickEmpId(u) {
  return (u && (u.employeeId || u.userId)) || '';
}
function pickEmpName(u) {
  if (!u) return '';
  if (u.name && String(u.name).trim()) return u.name;
  const fn = u.firstName || '';
  const ln = u.lastName  || '';
  return (fn + ' ' + ln).trim();
}

// Reject 24-char hex ObjectId strings - they look like data but aren't readable.
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

// dd-mm-yyyy - matches the HRMS-wide date format.
function fmtDDMMYYYY(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

function reshape(a) {
  const dateStr = fmtDDMMYYYY(a.date);
  const empId   = pickEmpId(a.user);
  const empName = pickEmpName(a.user) || '-';
  const role = safeLabel(a.user && a.user.designation, a.user && a.user.designationTitle);
  const dept = safeLabel(a.user && a.user.department,  a.user && a.user.departmentName);
  return {
    _id:        a._id,
    id:         empId || shortId(a._id, a.type),
    employeeId: empId,
    empName:    empName,
    empId:      empId,
    from:     a.fromLocation || '',
    to:       a.toLocation   || '',
    distance: Number(a.distance) || 0,
    distanceSource: a.distanceSource || 'manual',
    fromLat:  typeof a.fromLat === 'number' ? a.fromLat : null,
    fromLng:  typeof a.fromLng === 'number' ? a.fromLng : null,
    toLat:    typeof a.toLat   === 'number' ? a.toLat   : null,
    toLng:    typeof a.toLng   === 'number' ? a.toLng   : null,
    amount:   Number(a.amount)   || 0,
    approvedAmount: Number(a.approvedAmount) || 0,
    rejectedAmount: Number(a.rejectedAmount) || 0,
    amountComment:  a.amountComment || '',
    status:   titleCaseStatus(a.status),
    managerStatus: (function () {
      const m = String(a.managerStatus || '').trim().toLowerCase();
      if (m === 'approved') return 'Approved';
      if (m === 'rejected') return 'Rejected';
      return '';
    })(),
    managerStatusBy: a.managerStatusBy || '',
    managerStatusAt: a.managerStatusAt || null,
    date:     dateStr,
    type:     a.type,
    purpose:  a.purpose   || '',
    transport:a.transport || '',
    notes:    a.notes     || '',
    employee: {
      userId:      (a.user && a.user.userId)      || empId,
      employeeId:  empId,
      name:        empName,
      email:       (a.user && a.user.email)       || '',
      designation: role,
      department:  dept,
    },
    hrComment:  a.hrComment  || '',
    reviewedAt: a.reviewedAt || null,
    createdAt:  a.createdAt  || null,
  };
}

function configReady(res) {
  if (!ADMIN_SECRET) {
    res.status(503).json({
      success: false,
      message: 'MOBILE_ADMIN_SECRET is not configured on the HRMS server. ' +
               'Set it in .env to enable mobile allowance sync.',
    });
    return false;
  }
  return true;
}

async function fwd(path, init) {
  init = init || {};
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available - Node 18+ required.');
  }
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, FETCH_TIMEOUT_MS);
  try {
    return await fetch(MOBILE_API + path, Object.assign({}, init, {
      signal:  controller.signal,
      headers: Object.assign({}, init.headers || {}, { 'x-admin-secret': ADMIN_SECRET }),
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/allowances
 */
router.get('/', async (req, res) => {
  if (!configReady(res)) return;
  try {
    const q = new URLSearchParams();
    if (req.query.type)   q.set('type',   req.query.type);
    if (req.query.status) q.set('status', req.query.status);
    if (req.query.limit)  q.set('limit',  req.query.limit);
    const qs = q.toString() ? `?${q.toString()}` : '';

    const r    = await fwd(`/api/allowance/admin/all${qs}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: (data && data.message) || `Mobile API responded ${r.status}`,
      });
    }
    const reshaped = (Array.isArray(data.items) ? data.items : []).map(reshape);
    // #302 — Classify each row defensively. The strict `=== 'petrol'`
    // / `=== 'travel'` checks here previously dropped rows whose mobile
    // backend wrote the type in mixed case ("Petrol", "TRAVEL") or with
    // extra whitespace, AND silently mis-sorted any row where `type`
    // was missing entirely. The result was HR seeing the same list under
    // both cards, or one tab being empty. Now we lowercase + trim, fall
    // back to structural fingerprints (auto-billed petrol rows have
    // `gpsKm` / `distance` derived from live-tracking; travel rows have
    // `purpose` set), and stamp a canonical _kind for the frontend.
    const classify = (x) => {
      const t = String(x?.type || '').toLowerCase().trim();
      if (t === 'petrol' || t.includes('petrol')) return 'petrol';
      if (t === 'travel' || t.includes('travel')) return 'travel';
      // Structural fallback. Petrol-from-GPS rows always have a numeric
      // `distance` AND no employee-entered purpose (the auto-biller
      // stamps purpose: 'Daily Commute' but never collects fromLat etc.).
      // Travel rows always have a `purpose` or `fromLat`/`toLat`.
      if (x?.fromLat || x?.toLat || x?.fromLng || x?.toLng) return 'travel';
      if (x?.purpose && x.purpose !== 'Daily Commute')      return 'travel';
      if (typeof x?.distance === 'number' && x.distance > 0) return 'petrol';
      return 'travel';   // safer to surface in Travel than to lose
    };
    const petrol = [];
    const travel = [];
    for (const r of reshaped) {
      const kind = classify(r);
      const stamped = { ...r, _kind: kind };
      if (kind === 'petrol') petrol.push(stamped);
      else                   travel.push(stamped);
    }
    console.log(`[allowances] returning petrol=${petrol.length} travel=${travel.length} (total=${reshaped.length})`);
    res.json({
      success: true,
      petrol,
      travel,
      summary: data.summary || {},
      total:   reshaped.length,
    });
  } catch (err) {
    console.error('[allowance proxy GET]', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  }
});

/**
 * PATCH /api/allowances/:id
 */
router.patch('/:id', async (req, res) => {
  if (!configReady(res)) return;
  try {
    const body = req.body || {};
    const payload = {};
    if (body.status     !== undefined) payload.status     = String(body.status).toLowerCase();
    if (body.hrComment  !== undefined) payload.hrComment  = String(body.hrComment);
    if (body.reviewedBy !== undefined) payload.reviewedBy = String(body.reviewedBy);
    if (body.approvedAmount !== undefined) payload.approvedAmount = Number(body.approvedAmount);
    if (body.amountComment  !== undefined) payload.amountComment  = String(body.amountComment);

    const r = await fwd(`/api/allowance/admin/${encodeURIComponent(req.params.id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: (data && data.message) || `Mobile API responded ${r.status}`,
      });
    }
    res.json({
      success: true,
      allowance: data.allowance ? reshape(data.allowance) : null,
    });
  } catch (err) {
    console.error('[allowance proxy PATCH]', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  }
});

/**
 * POST /api/allowances/backfill-petrol
 * Body: { date, from, to, userId, dryRun }
 *
 * Retroactively creates the petrol Allowance row for every petrol-eligible
 * employee who checked in/out on the given date(s) but is missing a row.
 * Forwards to the mobile backend POST /api/admin/backfill-petrol.
 */
router.post('/backfill-petrol', async (req, res) => {
  if (!configReady(res)) return;
  try {
    const body = req.body || {};
    const payload = {};
    if (body.date)   payload.date   = String(body.date);
    if (body.from)   payload.from   = String(body.from);
    if (body.to)     payload.to     = String(body.to);
    if (body.userId) payload.userId = String(body.userId);
    if (body.dryRun !== undefined) payload.dryRun = body.dryRun;

    const r = await fwd('/api/admin/backfill-petrol', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json(Object.assign(
        { success: false, message: (data && data.message) || `Mobile API responded ${r.status}` },
        data || {}
      ));
    }
    res.json(Object.assign({ success: true }, data || {}));
  } catch (err) {
    console.error('[allowance proxy POST backfill]', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  }
});

module.exports = router;
