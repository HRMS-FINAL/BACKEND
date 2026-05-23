/**
 * Keep-alive ping for the HRMS backend.
 *
 * Render's free tier (and similar PaaS plans) put the service to sleep
 * after ~15 minutes of inactivity, and the first request after that takes
 * ~30s to wake. While the server is asleep, the HRMS frontend's
 * /api/employees / /api/announcements / /api/complaints calls time out,
 * which makes the lists look empty.
 *
 * This module schedules a self-ping every 10 minutes — well under the
 * 15-minute idle threshold — so the API stays warm.
 *
 * Uses setInterval rather than node-cron so we don't pull in another
 * dependency. The frequency / target URL can be overridden via env vars:
 *   PING_URL              full URL (overrides everything)
 *   RENDER_EXTERNAL_URL   auto-set by Render — used as base
 *   KEEP_ALIVE=false      disable the ping
 *   KEEP_ALIVE_MINUTES=10 interval (default 10 minutes)
 */

function resolveTarget(port) {
  if (process.env.PING_URL) {
    return process.env.PING_URL.replace(/\/$/, '');
  }
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  }
  return `http://localhost:${port}`;
}

/**
 * Start the keep-alive interval.
 * @param {number} port - The port the API is listening on (for local fallback).
 */
function startKeepAlive(port = 8000) {
  if (process.env.KEEP_ALIVE === 'false') {
    console.log('[keepAlive] disabled via KEEP_ALIVE=false');
    return;
  }
  if (typeof fetch !== 'function') {
    console.warn('[keepAlive] global fetch not available (Node <18) — skipping');
    return;
  }

  const base        = resolveTarget(port);
  const selfTarget  = `${base}/`;
  const mobileBase  = (process.env.MOBILE_API_URL || '').replace(/\/+$/, '');
  // We ping the mobile backend's /api/health (cheap, ungated) so it
  // doesn't go to sleep either. That removes the 30-second cold-start
  // the user was seeing on the HRMS complaints / leaves / allowances
  // pages — the very first hit after idle no longer triggers a wake-up
  // delay because the mobile backend was kept warm by these pings.
  const mobileTarget = mobileBase ? `${mobileBase}/api/health` : null;
  const minutes      = Math.max(1, parseInt(process.env.KEEP_ALIVE_MINUTES, 10) || 10);
  const intervalMs   = minutes * 60 * 1000;

  console.log(`[keepAlive] scheduled every ${minutes} min → ${selfTarget}`);
  if (mobileTarget) {
    console.log(`[keepAlive] also pinging mobile backend → ${mobileTarget}`);
  } else {
    console.warn('[keepAlive] MOBILE_API_URL not set — mobile backend will NOT be kept warm');
  }

  async function pingOne(url) {
    const startedAt = Date.now();
    try {
      const res = await fetch(url, { method: 'GET' });
      const ms = Date.now() - startedAt;
      if (res.ok) {
        console.log(`[keepAlive] ✔ ${res.status} ${url} (${ms}ms)`);
      } else {
        console.warn(`[keepAlive] ⚠ ${res.status} ${url} (${ms}ms)`);
      }
    } catch (err) {
      console.warn(`[keepAlive] ✖ ${url} failed: ${err.message}`);
    }
  }

  const ping = async () => {
    // Hit both targets in parallel so a slow one doesn't block the other.
    await Promise.all([
      pingOne(selfTarget),
      mobileTarget ? pingOne(mobileTarget) : Promise.resolve(),
    ]);
  };

  // Fire one ping ~5s after startup (was 30s) so the mobile backend wakes
  // up BEFORE the HRMS admin actually clicks Complaints / Leave / etc.
  setTimeout(ping, 5_000);
  setInterval(ping, intervalMs);
}

module.exports = { startKeepAlive };
