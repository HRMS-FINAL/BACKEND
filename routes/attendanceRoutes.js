// routes/attendanceRoutes.js — Attendance logs + Leave requests
const express      = require('express');
const router       = express.Router();
const Attendance   = require('../models/Attendance');
const LeaveRequest = require('../models/LeaveRequest');

// ─────────────────────────────────────────────
// MOBILE BACKEND PROXY CONFIG
// Mobile employees check in/out from the React Native app. The records live
// in the mobile backend's Attendance collection. We forward GET /logs and
// /stats requests there and reshape the response into the field names the
// existing HRMS Attendance.jsx page already expects — so no UI changes.
// ─────────────────────────────────────────────
const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-9rtc.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET =  process.env.MOBILE_ADMIN_SECRET || '';
const FETCH_TIMEOUT_MS = 30_000;

async function fwdMobile(path) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available — Node 18+ required.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(MOBILE_API + path, {
      signal:  controller.signal,
      headers: { 'x-admin-secret': ADMIN_SECRET },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map mobile-app status → HRMS UI status code.
 *
 * Jun 2026 — `permission` and `halfday` are now DISTINCT statuses (was
 * both mapped to "Half Day" earlier, which collapsed the policy meaning):
 *   • permission → employee filed a permission request for the day,
 *                  HR can approve/reject it. No LOP.
 *   • halfday    → employee checked out before 5:30 PM with no
 *                  permission request on file. Counts as 0.5 LOP once
 *                  the 2-per-month free quota is used.
 */
function mapStatus(s) {
  switch (String(s || '').toLowerCase()) {
    case 'present':    return 'On Time';
    case 'late':       return 'Late';
    case 'leave':      return 'Absent';
    case 'permission': return 'Permission';
    case 'absent':     return 'Absent';
    case 'halfday':    return 'Half Day';
    default:           return s || 'On Time';
  }
}

/** Format a Mongo Date → "09:05 AM". */
function fmtTime(d) {
  if (!d) return '--:--';
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '--:--';
    let h = dt.getHours();
    const m = dt.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ap}`;
  } catch { return '--:--'; }
}

/** Build "8h 25m" from check-in/out (or workedHours if present). */
function fmtWorked(att) {
  if (typeof att.workedHours === 'number' && att.workedHours > 0) {
    const h = Math.floor(att.workedHours);
    const m = Math.round((att.workedHours - h) * 60);
    return `${h}h ${m}m`;
  }
  if (att.checkIn && att.checkOut) {
    const ms = new Date(att.checkOut) - new Date(att.checkIn);
    if (ms > 0) {
      const totalMin = Math.floor(ms / 60000);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;
      return `${h}h ${m}m`;
    }
  }
  return '0h';
}

/** Initials + deterministic colour for the avatar tile. */
const PALETTE = ['#4299E1', '#48BB78', '#ED8936', '#9F7AEA', '#F56565', '#38B2AC', '#ECC94B'];
function colorFor(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initialsFor(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Reject 24-char hex ObjectId strings — they look like data but aren't
// readable. Used to strip raw refs that occasionally leak from the
// mobile-side User doc when populate didn't reach as deep as we needed.
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

/** Reshape a mobile attendance doc into the HRMS-UI shape. */
function reshapeMobileAttendance(att) {
  const fullName =
    att.user?.name ||
    [att.user?.firstName, att.user?.lastName].filter(Boolean).join(' ') ||
    'Unknown';
  // designation / department might arrive as: a populated object, a raw
  // ObjectId string, or already a human label. The denormalised
  // designationTitle / departmentName sidecar fields (stamped on every
  // employee row at create / update time) are the bullet-proof fallback.
  const role = safeLabel(att.user?.designation, att.user?.designationTitle);
  const dept = safeLabel(att.user?.department,  att.user?.departmentName);
  return {
    _id:          att._id,
    employeeId:   att.user?.employeeId || '',
    employeeName: fullName,
    avatar:       initialsFor(fullName),
    color:        colorFor(fullName),
    role,
    department:   dept,
    email:        att.user?.email       || '',
    date:         att.date,
    checkIn:      fmtTime(att.checkIn),
    checkOut:     fmtTime(att.checkOut),
    workHours:    fmtWorked(att),
    status:       mapStatus(att.status),
    autoCheckedOut: !!att.autoCheckedOut,
    lat:          att.checkInLat,
    lng:          att.checkInLng,
  };
}

// ─────────────────────────────────────────────
// ATTENDANCE LOGS  (now proxies to mobile backend)
// ─────────────────────────────────────────────

// GET /api/attendance/logs?date=YYYY-MM-DD&search=&month=&year=
router.get('/logs', async (req, res) => {
  // Fallback to local DB if proxy not configured — avoids breaking dev.
  if (!ADMIN_SECRET) {
    try {
      const { search, date } = req.query;
      const query = { isActive: true };
      if (date)   query.date = date;
      if (search) query.employeeName = { $regex: search, $options: 'i' };
      const logs = await Attendance.find(query).sort({ createdAt: -1 });
      return res.status(200).json({ success: true, data: logs, source: 'local' });
    } catch (err) {
      return res.status(500).json({ success: false, message: err.message });
    }
  }

  try {
    const q = new URLSearchParams();
    if (req.query.date)  q.set('date',  req.query.date);
    if (req.query.month) q.set('month', req.query.month);
    if (req.query.year)  q.set('year',  req.query.year);
    if (req.query.limit) q.set('limit', req.query.limit);
    const qs = q.toString() ? `?${q.toString()}` : '';

    const r    = await fwdMobile(`/api/attendance/admin/all${qs}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: data?.message || `Mobile API responded ${r.status}`,
      });
    }
    let items = Array.isArray(data.items) ? data.items.map(reshapeMobileAttendance) : [];

    // #399 — HR OVERRIDE OVERLAY.
    // Even after adminMarkStatus successfully sets hrOverride=true on the
    // mobile backend (or falls back to a local write), a subsequent
    // /attendance/logs proxy call can return the row still as Absent
    // for two reasons:
    //   (a) Render's read replica hasn't caught up with the write.
    //   (b) The mobile backend fell over and the local fallback wrote
    //       to the HRMS Attendance collection instead — but /logs
    //       here proxies to the mobile backend and never reads local.
    // Either way, HR clicks Mark Present, sees Present briefly, then
    // watches the row revert to Absent within 1-2 seconds.
    //
    // The overlay solves both cases: after proxying, we look up the
    // HRMS local Attendance collection for any row with hrOverride=true
    // for the same date, and force-overwrite the status in the response.
    // The local collection is our own source of truth for HR overrides.
    try {
      const overlayQuery = { hrOverride: true };
      if (req.query.date)          overlayQuery.date = req.query.date;
      else if (req.query.month && req.query.year) {
        // Date range would need month bounds; skip overlay for month
        // queries since they're rare and the mobile write is usually
        // caught up by the time HR looks at a whole month.
      }
      const overrides = await Attendance.find(overlayQuery)
        .select('employeeId date status hrOverrideStatus')
        .lean();
      if (overrides.length > 0) {
        const byKey = new Map();
        overrides.forEach(o => {
          const key = `${o.employeeId || ''}|${o.date || ''}`;
          if (key !== '|') byKey.set(key, o);
        });
        items = items.map(it => {
          const key = `${it.employeeId || ''}|${it.date || ''}`;
          const override = byKey.get(key);
          if (!override) return it;
          const forced = override.hrOverrideStatus || override.status || it.status;
          return { ...it, status: forced, _hrOverridden: true };
        });
      }
    } catch (overlayErr) {
      console.warn('[attendance/logs] overlay lookup failed (non-fatal):', overlayErr.message);
    }

    // Optional client-side text search across name/email/employeeId.
    if (req.query.search) {
      const s = String(req.query.search).toLowerCase();
      items = items.filter(it =>
        it.employeeName.toLowerCase().includes(s) ||
        it.email.toLowerCase().includes(s) ||
        it.employeeId.toLowerCase().includes(s)
      );
    }

    res.status(200).json({ success: true, data: items, source: 'mobile', total: items.length });
  } catch (err) {
    console.error('[attendance/logs proxy]', err.message);
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  }
});

// GET /api/attendance/logs/:id
router.get('/logs/:id', async (req, res) => {
  try {
    const log = await Attendance.findById(req.params.id);
    if (!log) return res.status(404).json({ success: false, message: 'Log not found' });
    res.status(200).json({ success: true, data: log });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/attendance/logs — create
router.post('/logs', async (req, res) => {
  try {
    const { employeeId, employeeName, avatar, color, date, checkIn, checkOut, workHours, status } = req.body;
    if (!employeeId || !employeeName || !date) {
      return res.status(400).json({ success: false, message: 'employeeId, employeeName and date are required' });
    }
    // Normalize date to YYYY-MM-DD with leading zeros (e.g. "2026-05-5" → "2026-05-05")
    const normalizedDate = new Date(date).toISOString().split('T')[0];
    const log = await Attendance.create({ employeeId, employeeName, avatar, color, date: normalizedDate, checkIn, checkOut, workHours, status });
    res.status(201).json({ success: true, data: log, message: 'Attendance log created' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/attendance/logs/:id — update check-in/out/status
router.put('/logs/:id', async (req, res) => {
  try {
    const log = await Attendance.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!log) return res.status(404).json({ success: false, message: 'Log not found' });
    res.status(200).json({ success: true, data: log, message: 'Log updated' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/attendance/logs/:id — soft delete
router.delete('/logs/:id', async (req, res) => {
  try {
    const log = await Attendance.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!log) return res.status(404).json({ success: false, message: 'Log not found' });
    res.status(200).json({ success: true, message: 'Log deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// #352d — PATCH /api/attendance/mark-status — HR manual override.
// Proxies to the mobile backend so HR can flip Absent → Present after
// an employee explains a late arrival. Body: { userId|employeeId, date,
// status, note? }.
router.patch('/mark-status', async (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ success: false, message: 'MOBILE_ADMIN_SECRET is not configured.' });
  }
  // #369 — Try mobile backend first. If it 404s (endpoint not deployed
  // yet) or times out, fall back to updating the local HRMS Attendance
  // collection so HR isn't blocked. Local write is best-effort — it
  // shows in the HRMS UI even if the mobile mirror stays stale.
  // #406 — Helper: also write the override into the HRMS local Attendance
  // collection so the /logs overlay ALWAYS finds it, even when the mobile
  // write succeeded but Render's read replica is still stale on the very
  // next /logs proxy call. Without this dual-write, HR would see the
  // status flicker back to Absent for 3-8 seconds after Mark Present.
  async function stampLocalOverride() {
    try {
      const { employeeId, userId, date, status = 'present', note = '' } = req.body || {};
      if (!date) return;
      const targetStatus = String(status).toLowerCase() === 'present'
        ? 'On Time'
        : String(status).charAt(0).toUpperCase() + String(status).slice(1);
      const query = { date };
      if (employeeId) query.employeeId = employeeId;
      if (userId)     query.userId     = userId;
      await Attendance.findOneAndUpdate(
        query,
        { $set: {
            status: targetStatus,
            hrOverride: true,
            hrOverrideStatus: targetStatus,
            hrOverrideNote: note,
            hrOverrideAt: new Date(),
        } },
        { new: true, upsert: true }
      );
    } catch (e) {
      console.warn('[mark-status] local mirror write failed (non-fatal):', e.message);
    }
  }

  try {
    const r = await fetch(`${MOBILE_API}/api/attendance/admin/mark-status`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body:    JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) {
      // #406 — Mirror the override into HRMS local so /logs overlay
      // catches Render's read-replica lag on the follow-up refresh.
      await stampLocalOverride();
      return res.json({ success: true, item: data.item, source: 'mobile+local' });
    }
    // Mobile failed — try local fallback (never block HR).
    console.warn('[attendance/mark-status] mobile responded', r.status, '— falling back to local update');
  } catch (err) {
    console.warn('[attendance/mark-status] mobile unreachable — falling back to local update:', err.message);
  }
  // Local fallback: update the HRMS Attendance record directly.
  try {
    const { employeeId, userId, date, status = 'present', note = '' } = req.body || {};
    const targetStatus = String(status).toLowerCase() === 'present'
      ? 'On Time'
      : String(status).charAt(0).toUpperCase() + String(status).slice(1);
    const query = { date };
    if (employeeId) query.employeeId = employeeId;
    if (userId)     query.userId     = userId;
    // #399 — Stamp hrOverride: true so the /logs overlay can find
    // this row later and force its status over any stale value the
    // mobile backend returns. Without this, the local fallback wrote
    // the status but the row was indistinguishable from a normal
    // record, and the next /logs proxy read was overwriting it.
    const item = await Attendance.findOneAndUpdate(
      query,
      { $set: {
          status: targetStatus,
          hrOverride: true,
          hrOverrideStatus: targetStatus,
          hrOverrideNote: note,
          hrOverrideAt: new Date(),
      } },
      { new: true, upsert: true }
    );
    if (!item) {
      return res.status(404).json({ success: false, message: 'No local attendance row for that employee/date.' });
    }
    return res.json({ success: true, item, source: 'local' });
  } catch (err) {
    console.error('[attendance/mark-status local fallback]', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/attendance/stats?date=YYYY-MM-DD
router.get('/stats', async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];

  // Re-use the proxy reader so stats and the table agree.
  async function readLogs() {
    if (!ADMIN_SECRET) {
      return (await Attendance.find({ date })).map(l => ({ status: l.status }));
    }
    const r = await fwdMobile(`/api/attendance/admin/all?date=${encodeURIComponent(date)}`);
    if (!r.ok) throw new Error(`Mobile API responded ${r.status}`);
    const data = await r.json().catch(() => ({}));
    return (data.items || []).map(reshapeMobileAttendance);
  }

  try {
    const logs    = await readLogs();
    const total   = logs.length;
    const onTime  = logs.filter(l => l.status === 'On Time').length;
    const late    = logs.filter(l => l.status === 'Late').length;
    const absent  = logs.filter(l => l.status === 'Absent').length;
    const halfDay = logs.filter(l => l.status === 'Half Day').length;
    const pct = n => total > 0 ? ((n / total) * 100).toFixed(1) + '%' : '0%';
    res.status(200).json({
      success: true,
      data: {
        date,
        total,
        onTime:  { count: onTime,  percentage: pct(onTime)  },
        late:    { count: late,    percentage: pct(late)    },
        absent:  { count: absent,  percentage: pct(absent)  },
        halfDay: { count: halfDay, percentage: pct(halfDay) },
      },
    });
  } catch (err) {
    console.error('[attendance/stats]', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
// DAILY ROUTE  (proxies to mobile backend)
// ─────────────────────────────────────────────
//
// Tiny in-memory LRU cache so when HR repeatedly clicks "View Route" on
// the Daily Routes / Allowance pages, we skip the round-trip to Render
// entirely for 60 seconds. Two HRMS users hitting the same row also
// share the cached response.
//
// Why two caches (frontend + here)
//   • Frontend cache fixes "same browser, same row, repeat click".
//   • This cache fixes "different browsers / users / tabs hitting the
//     same row within 60s" — typical during morning HR review when
//     multiple HRs are looking at yesterday's routes simultaneously.
const ROUTE_CACHE_TTL_MS = 60 * 1000;
const ROUTE_CACHE_MAX    = 500;          // bounded — eviction on overflow
const routeCache  = new Map();           // key → { body, fetchedAt }
const listCache   = new Map();           // key → { body, fetchedAt }

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > ROUTE_CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  // Touch to refresh LRU order.
  map.delete(key);
  map.set(key, hit);
  return hit.body;
}
function cacheSet(map, key, body) {
  if (map.size >= ROUTE_CACHE_MAX) {
    // Evict the oldest entry. Map insertion order = LRU order because
    // we re-insert on every hit (see cacheGet).
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, { body, fetchedAt: Date.now() });
}
// Two endpoints:
//   GET /api/attendance/daily-routes?date=YYYY-MM-DD
//     → table of every employee that day: km, checkIn/out, allowance flag.
//       Used by HRMS "Daily Routes" view to pick whose route to drill into.
//
//   GET /api/attendance/daily-route?employeeId=TES047&date=YYYY-MM-DD
//     → full polyline + total km + allowance from/to pins (if any).
//       Used by both the Allowance.jsx map view (one click on a row →
//       map of the actual path) AND the per-employee daily route view.
//
// Both forward to the mobile backend's admin endpoints with x-admin-secret
// so the HRMS frontend never needs to know the secret.

router.get('/daily-routes', async (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({
      success: false,
      message: 'MOBILE_ADMIN_SECRET is not configured on the HRMS server.',
    });
  }
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'date=YYYY-MM-DD required' });
    }
    // 60-sec cache hit avoids the entire Render round-trip.
    const cached = cacheGet(listCache, date);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }
    const r    = await fwdMobile(`/api/attendance/admin/daily-routes?date=${encodeURIComponent(date)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: data?.message || `Mobile API responded ${r.status}`,
      });
    }
    const body = { success: true, date, items: data.items || [], total: data.count || 0 };
    cacheSet(listCache, date, body);
    res.json(body);
  } catch (err) {
    console.error('[daily-routes proxy]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach the mobile backend. ' + err.message });
  }
});

router.get('/daily-route', async (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({
      success: false,
      message: 'MOBILE_ADMIN_SECRET is not configured on the HRMS server.',
    });
  }
  try {
    const date = String(req.query.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, message: 'date=YYYY-MM-DD required' });
    }
    const employeeId = String(req.query.employeeId || '').trim().toUpperCase();
    const userId     = String(req.query.userId     || '').trim();
    if (!employeeId && !userId) {
      return res.status(400).json({ success: false, message: 'employeeId or userId required' });
    }

    // 60-sec cache — most HR clicks land on the same (emp, date) pair
    // multiple times in a row (open, close, reopen, share link with
    // colleague). Skipping the Render round-trip cuts perceived
    // latency from 1-3 sec to sub-millisecond.
    const cacheKey = `${employeeId || 'u:' + userId}|${date}`;
    const cached   = cacheGet(routeCache, cacheKey);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    const q = new URLSearchParams();
    if (employeeId) q.set('employeeId', employeeId);
    if (userId)     q.set('userId',     userId);
    q.set('date', date);

    const r    = await fwdMobile(`/api/attendance/admin/daily-route?${q.toString()}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: data?.message || `Mobile API responded ${r.status}`,
      });
    }
    const body = { success: true, ...data };
    cacheSet(routeCache, cacheKey, body);
    res.json(body);
  } catch (err) {
    console.error('[daily-route proxy]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach the mobile backend. ' + err.message });
  }
});

// ─────────────────────────────────────────────
// LEAVE REQUESTS
// ─────────────────────────────────────────────

// GET /api/attendance/leaves?search=&status=
router.get('/leaves', async (req, res) => {
  try {
    const { search, status } = req.query;
    const query = { isActive: true };
    if (status) query.status = status;
    if (search) query.employeeName = { $regex: search, $options: 'i' };
    const leaves = await LeaveRequest.find(query).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: leaves });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/attendance/leaves/:id
router.get('/leaves/:id', async (req, res) => {
  try {
    const leave = await LeaveRequest.findById(req.params.id);
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });
    res.status(200).json({ success: true, data: leave });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/attendance/leaves — submit leave request
router.post('/leaves', async (req, res) => {
  try {
    const { employeeId, employeeName, avatar, color, type, fromDate, toDate, duration, reason } = req.body;
    if (!employeeId || !employeeName || !type || !fromDate || !toDate || !duration) {
      return res.status(400).json({ success: false, message: 'employeeId, employeeName, type, fromDate, toDate and duration are required' });
    }
    const leave = await LeaveRequest.create({ employeeId, employeeName, avatar, color, type, fromDate, toDate, duration, reason });
    res.status(201).json({ success: true, data: leave, message: 'Leave request submitted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/attendance/leaves/:id — approve / reject
router.put('/leaves/:id', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be Pending, Approved or Rejected' });
    }
    const leave = await LeaveRequest.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });
    res.status(200).json({ success: true, data: leave, message: `Leave request ${status.toLowerCase()}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/attendance/leaves/:id — soft delete
router.delete('/leaves/:id', async (req, res) => {
  try {
    const leave = await LeaveRequest.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!leave) return res.status(404).json({ success: false, message: 'Leave request not found' });
    res.status(200).json({ success: true, message: 'Leave request deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});



// ───────────────────────────────────────────────────────────────────
// ATTENDANCE REGULARISATION REQUESTS (proxy → mobile backend)
// ───────────────────────────────────────────────────────────────────
//
// HR pages this under "Attendance Requests" and acts on the rows from
// HRMS. The mobile backend owns the AttendanceRequest collection, so
// we just forward + return what it sends back.

// GET /api/attendance-requests?status=pending|approved|rejected|expired
router.get('/attendance-requests', async (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ success: false, message: 'MOBILE_ADMIN_SECRET is not configured.' });
  }
  try {
    const q = new URLSearchParams();
    if (req.query.status) q.set('status', String(req.query.status));
    if (req.query.limit)  q.set('limit',  String(req.query.limit));
    const qs = q.toString() ? `?${q.toString()}` : '';
    const r  = await fwdMobile(`/api/attendance/admin/requests${qs}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ success: false, message: data?.message || `Mobile API responded ${r.status}` });
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    // Reshape the mongoose-populated user into a flat row HR can render.
    // managerStatus (Jun 2026) lets the HR table show whether the
    // manager has weighed in yet — '' means Awaiting Manager (HR can
    // see it but typically waits for manager), 'Approved' means HR can
    // now finalize, 'Rejected' means the request is already closed.
    const out = items.map((it) => ({
      _id:        it._id,
      id:         it.user?.employeeId || String(it._id).slice(-6),
      date:       it.date,
      requestType:it.requestType || 'regularize',
      reason:     it.reason || '',
      status:     it.status || 'pending',
      hrComment:  it.hrComment || '',
      reviewedAt: it.reviewedAt || null,
      reviewedBy: it.reviewedBy || '',
      managerStatus:   it.managerStatus   || '',
      managerStatusBy: it.managerStatusBy || '',
      managerStatusAt: it.managerStatusAt || null,
      managerComment:  it.managerComment  || '',
      createdAt:  it.createdAt,
      employeeId: it.user?.employeeId || '',
      employeeName:
        it.user?.name ||
        ((it.user?.firstName || '') + ' ' + (it.user?.lastName || '')).trim() ||
        '—',
      email:      it.user?.email || '',
      designation:it.user?.designationTitle || it.user?.designation || '',
      department: it.user?.departmentName  || it.user?.department  || '',
    }));
    res.json({ success: true, items: out });
  } catch (err) {
    console.error('[attendance-requests proxy GET]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach the mobile backend. ' + err.message });
  }
});

// PATCH /api/attendance-requests/:id  { status, hrComment?, reviewedBy? }
router.patch('/attendance-requests/:id', async (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({ success: false, message: 'MOBILE_ADMIN_SECRET is not configured.' });
  }
  try {
    const r = await fetch(`${MOBILE_API}/api/attendance/admin/requests/${encodeURIComponent(req.params.id)}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
      body:    JSON.stringify(req.body || {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ success: false, message: data?.message || `Mobile API responded ${r.status}` });
    }
    res.json({ success: true, item: data.item });
  } catch (err) {
    console.error('[attendance-requests proxy PATCH]', err.message);
    res.status(502).json({ success: false, message: 'Could not reach the mobile backend. ' + err.message });
  }
});

module.exports = router;
