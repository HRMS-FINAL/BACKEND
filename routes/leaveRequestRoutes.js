/**
 * Leave-request routes — proxy to the Tesco ERM mobile backend.
 *
 * Mobile employees file leave/permission via the mobile app, which writes
 * them to the mobile backend's MongoDB. The HRMS web app (this server)
 * forwards the request to the mobile backend's admin API and reshapes the
 * response into the EXACT field shape the existing HRMS pages expect:
 *
 *   { id, name, role, dept, type, duration, date, requestedAt,
 *     status, managerStatus, avatar, color, reason }
 *
 * That way the HRMS LeavePermissionRequest.jsx and LeavePermission.jsx
 * pages don't change UI / data shape — they just swap the mock array for
 * a fetch.
 *
 * Required env vars on the HRMS backend (.env):
 *   MOBILE_API_URL        e.g. https://backend-emqy.onrender.com
 *   MOBILE_ADMIN_SECRET   same value as ADMIN_SECRET on the mobile backend
 */

const express = require('express');
const router  = express.Router();

const MOBILE_API      = (process.env.MOBILE_API_URL    || 'https://backend-emqy.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET    =  process.env.MOBILE_ADMIN_SECRET || '';
const FETCH_TIMEOUT_MS = 30_000;

/* ─── Helpers ───────────────────────────────────────────────────────── */
const PALETTE = [
  '#4299E1', '#9F7AEA', '#4CAA17', '#ECC94B', '#FC8181',
  '#48BB78', '#ED8936', '#38B2AC', '#D53F8C', '#667EEA',
];
function colorFor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initialsFrom(name) {
  return String(name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  // dd-mm-yyyy — matches the HRMS-wide date format.
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  const hh    = d.getHours();
  const mm    = String(d.getMinutes()).padStart(2, '0');
  const ampm  = hh >= 12 ? 'PM' : 'AM';
  const hh12  = hh % 12 === 0 ? 12 : hh % 12;
  return `${fmtDate(iso)} at ${hh12}:${mm} ${ampm}`;
}
function titleCaseStatus(s) {
  if (!s) return 'Pending';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Reshape a mobile leave/permission document into the HRMS leave-request
 * shape used by LeavePermissionRequest.jsx.
 *
 * Notes:
 *   - The mobile backend has no "manager" tier — managerStatus comes back
 *     EMPTY so the HRMS UI shows Approve/Reject buttons in the Manager
 *     Status column. HR (acting as Manager) ticks one, which gates
 *     whether the Status column's HR Approve/Reject buttons appear.
 *   - 'role' uses designation; 'dept' falls back to 'Mobile' since the
 *     mobile User schema doesn't store department.
 */
// Reject 24-char hex ObjectId strings — they look like data but aren't
// readable. Used to strip raw refs that leak from the mobile-side User
// doc when populate didn't reach as deep as we needed.
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

function reshape(d) {
  const isPermission = d.requestType === 'permission';
  // Prefer the company's actual employee ID + the populated user name.
  const empId =
    (d.user?.employeeId || d.user?.userId) || '';
  const name =
    d.user?.name ||
    ((d.user?.firstName || '') + ' ' + (d.user?.lastName || '')).trim() ||
    '—';
  // Designation / department from the populated user. Reject raw
  // ObjectIds and prefer the denormalised sidecar fields if present.
  const roleLabel = safeLabel(d.user?.designation, d.user?.designationTitle);
  const deptLabel = safeLabel(d.user?.department,  d.user?.departmentName);

  // type: e.g. 'Sick Leave' or 'Permission (2h)'
  let type;
  let duration;
  let dateStr;
  if (isPermission) {
    const hrs = Number(d.durationHours || 0);
    type     = `Permission (${hrs}h)`;
    duration = `${hrs} Hour${hrs === 1 ? '' : 's'}`;
    dateStr  = d.date
      ? `${fmtDate(d.date)} (${d.startTime || '--'} - ${d.endTime || '--'})`
      : '';
  } else {
    type     = d.leaveType || 'Leave';
    const dc = Number(d.daysCount || 1);
    duration = d.isHalfDay
      ? 'Half Day'
      : `${dc} Day${dc === 1 ? '' : 's'}`;
    dateStr  = (d.endDate && d.endDate !== d.startDate)
      ? `${fmtDate(d.startDate)} - ${fmtDate(d.endDate)}`
      : fmtDate(d.startDate);
  }

  const seed = empId || d.user?._id || d._id;
  return {
    _id:           d._id,                              // real mongo id
    id:            empId || String(d._id).slice(-6),   // visible ID = company emp ID
    employeeId:    empId,
    empId,
    name,
    employeeName:  name,
    role:          roleLabel,                          // resolved designation title (no ObjectIds)
    dept:          deptLabel || 'Mobile',              // resolved dept name; fall back to "Mobile" tag
    type,
    duration,
    date:          dateStr,
    requestedAt:   fmtDateTime(d.createdAt),
    status:        titleCaseStatus(d.status),          // Pending / Approved / Rejected
    // Empty string by default. Frontend's Manager Status column treats
    // anything other than 'Approved' / 'Rejected' as "not yet acted on"
    // and renders Approve + Reject buttons. titleCaseStatus would have
    // normalised empty → 'Pending' which would *look* like an active
    // value to the frontend, so we map by hand:
    managerStatus: (() => {
      const m = String(d.managerStatus || '').trim().toLowerCase();
      if (m === 'approved') return 'Approved';
      if (m === 'rejected') return 'Rejected';
      return '';                                        // → Approve/Reject buttons show
    })(),
    avatar:        initialsFrom(name),
    color:         colorFor(seed),
    reason:        d.reason || '',
    // Surface employee details for any future UI needs
    employee: {
      _id:         d.user?._id        || null,
      userId:      d.user?.userId     || empId,
      employeeId:  empId,
      name,
      email:       d.user?.email       || '',
      designation: roleLabel,                          // resolved title
      department:  deptLabel,                          // resolved dept
    },
    // Raw fields preserved if any other page wants them
    requestType:   d.requestType,
    hrComment:     d.hrComment   || '',
    reviewedAt:    d.reviewedAt  || null,
    createdAt:     d.createdAt   || null,
    // Raw ISO dates — needed by the Employee Master report so it can
    // count overlap with the picked date range. Without these the
    // report's "On Leave" + "Leave Days" tiles always read 0 because
    // the formatted `date` string can't be compared lexically.
    startDate:     d.startDate || '',
    endDate:       d.endDate   || '',
    permissionDate: d.date     || '',     // permission rows use this
    leaveType:     d.leaveType || d.permissionType || '',
  };
}

function configReady(res) {
  if (!ADMIN_SECRET) {
    res.status(503).json({
      success: false,
      message: 'MOBILE_ADMIN_SECRET is not configured on the HRMS server. ' +
               'Set it in .env to enable mobile leave/permission sync.',
    });
    return false;
  }
  return true;
}

async function fwd(path, init = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available — Node 18+ required.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(MOBILE_API + path, {
      ...init,
      signal:  controller.signal,
      headers: {
        ...(init.headers || {}),
        'x-admin-secret': ADMIN_SECRET,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /api/leave-requests
 *   ?type=leave|permission     (optional)
 *   ?status=pending|approved|rejected (optional, default pending if not set)
 *   ?limit=200
 */
router.get('/', async (req, res) => {
  if (!configReady(res)) return;
  try {
    const q = new URLSearchParams();
    if (req.query.type)   q.set('type',   req.query.type);
    if (req.query.status) q.set('status', req.query.status);
    if (req.query.limit)  q.set('limit',  req.query.limit);
    const qs = q.toString() ? `?${q.toString()}` : '';

    const r    = await fwd(`/api/leave/admin/all${qs}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: data?.message || `Mobile API responded ${r.status}`,
      });
    }
    const items   = Array.isArray(data.items) ? data.items.map(reshape) : [];
    const summary = data.summary || {};
    res.json({ success: true, items, summary, total: items.length });
  } catch (err) {
    console.error('[leave-requests proxy GET]', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  }
});

/**
 * PATCH /api/leave-requests/:id
 * Body: { managerStatus?, status?, message?, managerNote?, hrNote? }
 * Forwards the approval / rejection decision to the mobile backend.
 */
router.patch('/:id', async (req, res) => {
  if (!configReady(res)) return;
  try {
    const payload = req.body || {};
    const r = await fwd('/api/leave/admin/' + encodeURIComponent(req.params.id), {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: data?.message || ('Mobile API responded ' + r.status),
      });
    }
    res.json({
      success: true,
      leave: data.leave ? reshape(data.leave) : null,
    });
  } catch (err) {
    console.error('[leave-requests proxy PATCH]', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  }
});

module.exports = router;
