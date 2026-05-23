/**
 * Live tracking proxy — HRMS web app calls this to get every employee's
 * current GPS location, derived from the mobile app's 2-minute pings.
 *
 *   GET /api/live-tracking
 *       → { success, office: {lat,lng,radiusM,name}, data: [ {employee + status + lat/lng} ] }
 *
 * Uses MOBILE_ADMIN_SECRET (set in Backend/.env). Falls back to a clear
 * 503 if not configured so the page doesn't silently show nothing.
 */
const express = require('express');
const router  = express.Router();

const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-emqy.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET =  process.env.MOBILE_ADMIN_SECRET || '';
const FETCH_TIMEOUT_MS = 20_000;

router.get('/', async (req, res) => {
  if (!ADMIN_SECRET) {
    return res.status(503).json({
      success: false,
      message: 'MOBILE_ADMIN_SECRET is not configured on the HRMS backend.',
    });
  }
  if (typeof fetch !== 'function') {
    return res.status(503).json({ success: false, message: 'Node 18+ required.' });
  }
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`${MOBILE_API}/api/attendance/admin/live-locations`, {
      headers: { 'x-admin-secret': ADMIN_SECRET },
      signal:  ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        success: false,
        message: data?.message || `Mobile API responded ${r.status}`,
      });
    }
    res.json(data);
  } catch (err) {
    res.status(502).json({
      success: false,
      message: 'Could not reach the mobile backend. ' + err.message,
    });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
