/**
 * Keep-alive self-pinger
 * ─────────────────────────────────────────────────────────────────────
 * Render's free tier suspends a web service after ~15 min of zero
 * inbound HTTP traffic and takes 30-60 s to spin back up. That cold
 * start lands on the user when they hit the app first thing in the
 * morning, which feels broken.
 *
 * This module hits the service's own `/api/_health` endpoint every
 * 14 minutes (just under Render's idle timeout) so the dyno stays
 * warm 24/7. We use the `RENDER_EXTERNAL_URL` env var Render injects
 * automatically; if it's missing (local dev) the pinger is a no-op.
 *
 * Why not a cron-job.org / GitHub Actions ping?
 *   - That's a fine alternative, but self-pinging means there's
 *     nothing to forget to renew or rotate. One env var (already set
 *     by Render) is all it takes.
 */
const PING_PATH       = '/api/_health';
const PING_INTERVAL_MS = 14 * 60 * 1000;   // 14 minutes

function start() {
  const url = (process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL || '').trim();
  if (!url) {
    console.log('[keepAlive] No RENDER_EXTERNAL_URL set — self-ping disabled.');
    return;
  }
  const target = url.replace(/\/$/, '') + PING_PATH;
  const ping = async () => {
    try {
      const res = await fetch(target);
      console.log(`[keepAlive] ping ${target} → ${res.status} @ ${new Date().toISOString()}`);
    } catch (err) {
      console.warn('[keepAlive] ping failed:', err.message);
    }
  };
  // Initial delay so we don't ping ourselves during boot.
  setTimeout(() => {
    ping();
    setInterval(ping, PING_INTERVAL_MS);
  }, 60_000);
  console.log(`[keepAlive] ✓ self-ping enabled — every ${PING_INTERVAL_MS / 60000} min → ${target}`);
}

module.exports = { start };
