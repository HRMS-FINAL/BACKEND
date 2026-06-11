/**
 * Notification feed for the HRMS top-bar bell.
 *
 * Aggregates four live sources into one chronologically-sorted feed:
 *
 *   1. Leave / permission requests   (via /api/leave-requests proxy → mobile)
 *   2. Allowance requests            (via /api/allowances     proxy → mobile)
 *   3. Complaints                    (via /api/complaints     proxy → mobile)
 *   4. Announcements                 (local HRMS DB)
 *
 * Each event becomes one notification: type, title, time (relative), an
 * ISO `timestamp` for client-side sorting, and a flag `read` so the bell
 * shows an unread dot when anything was created since the user last
 * acknowledged the feed (the frontend tracks "last read" in localStorage).
 *
 * The endpoint never returns any hardcoded sample data — if there are no
 * requests, the array is empty.
 *
 * No new schema is introduced; everything is computed on demand. That
 * means the feed stays correct even when employees create or HR resolves
 * items from the mobile app, with no extra sync logic.
 */

const express = require('express');
const router  = express.Router();

const Announcement = require('../models/Announcement');

const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-9rtc.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET =  process.env.MOBILE_ADMIN_SECRET || '';
const FETCH_TIMEOUT_MS = 20_000;

/* ─── Helpers ───────────────────────────────────────────────────────── */

function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  if (diff < 60_000)        return 'Just now';
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)} hour${Math.floor(diff / 3_600_000) === 1 ? '' : 's'} ago`;
  if (diff < 604_800_000)   return `${Math.floor(diff / 86_400_000)} day${Math.floor(diff / 86_400_000) === 1 ? '' : 's'} ago`;
  return d.toISOString().split('T')[0];
}

function pickEmpName(u) {
  if (!u) return 'an employee';
  if (u.name && String(u.name).trim()) return u.name;
  const fn = u.firstName || '';
  const ln = u.lastName  || '';
  const joined = (fn + ' ' + ln).trim();
  return joined || u.email || 'an employee';
}

async function fwd(path) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available — Node 18+ required.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(MOBILE_API + path, {
      signal:  controller.signal,
      headers: { 'x-admin-secret': ADMIN_SECRET },
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Source pullers ────────────────────────────────────────────────── */

async function fetchLeaveNotifs() {
  if (!ADMIN_SECRET) return [];
  const data = await fwd('/api/leave/admin/all?limit=50');
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .filter((it) => it.createdAt)
    .map((it) => {
      const name = pickEmpName(it.user);
      const isPerm = it.requestType === 'permission';
      return {
        id:        `leave-${it._id}`,
        type:      isPerm ? 'permission' : 'leave',
        title:     isPerm
          ? `Permission request from ${name}`
          : `Leave request from ${name}`,
        timestamp: it.createdAt,
        time:      relTime(it.createdAt),
        status:    it.status || 'pending',
        nav:       'leave-permission-request',
      };
    });
}

async function fetchAllowanceNotifs() {
  if (!ADMIN_SECRET) return [];
  const data = await fwd('/api/allowance/admin/all?limit=50');
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .filter((it) => it.createdAt)
    .map((it) => {
      const name = pickEmpName(it.user);
      const label = it.type === 'petrol' ? 'Petrol' : 'Travel';
      return {
        id:        `allow-${it._id}`,
        type:      'allowance',
        title:     `${label} allowance request from ${name}`,
        timestamp: it.createdAt,
        time:      relTime(it.createdAt),
        status:    it.status || 'pending',
        nav:       'allowance',
      };
    });
}

async function fetchComplaintNotifs() {
  if (!ADMIN_SECRET) return [];
  const data = await fwd('/api/complaint/admin/all?limit=50');
  const items = Array.isArray(data?.items) ? data.items : [];
  return items
    .filter((it) => it.createdAt)
    .map((it) => {
      const name = pickEmpName(it.user);
      const subj = it.subject ? `: ${it.subject}` : '';
      return {
        id:        `cmpl-${it._id}`,
        type:      'complaint',
        title:     `Complaint from ${name}${subj}`,
        timestamp: it.createdAt,
        time:      relTime(it.createdAt),
        status:    it.status || 'open',
        nav:       'complain-register',
      };
    });
}

async function fetchAnnouncementNotifs(viewerEmail) {
  try {
    const docs = await Announcement.find({})
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    // Suppress self-notifications — if HR posted the announcement
    // themselves, don't show it back to them on their own bell.
    // Match by postedByEmail (canonical) and fall back to postedBy name.
    const me = String(viewerEmail || '').trim().toLowerCase();
    const filtered = (docs || []).filter((d) => {
      if (!me) return true;
      const author = String(d.postedByEmail || '').trim().toLowerCase();
      if (author && author === me) return false;
      // Defensive name-based suppression — every HRMS announcement is
      // posted by HR, so drop anything whose postedBy matches the HRMS
      // admin display ("HR Admin", "Tesco Structures") when the viewer
      // is themselves an HRMS admin email.
      const isHrmsAdmin =
        me === 'tescostructures@gmail.com' ||
        me === 'hr@tescostructures.in'   ||
        me === 'tescodigitals26@gmail.com';
      if (isHrmsAdmin) return false;
      return true;
    });
    return filtered.map((d) => ({
      id:        `ann-${d._id}`,
      type:      'announcement',
      title:     d.title ? `New announcement: ${d.title}` : 'New announcement posted',
      timestamp: d.createdAt,
      time:      relTime(d.createdAt),
      status:    'posted',
      nav:       'announcements',
    }));
  } catch {
    return [];
  }
}

/* ─── Routes ────────────────────────────────────────────────────────── */

/**
 * GET /api/notifications
 *
 * Query:
 *   ?since=<ISO timestamp>   only items newer than this (used to count
 *                            unread items in the bell)
 *   ?limit=N                 cap the list (default 30)
 *
 * Response:
 *   {
 *     success: true,
 *     items:   [{ id, type, title, time, timestamp, status, nav, read }],
 *     unread:  <number>,
 *     total:   <number>
 *   }
 */
router.get('/', async (req, res) => {
  try {
    const since = req.query.since ? new Date(req.query.since) : null;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || '30', 10), 200));

    const [leave, allow, cmpl, ann] = await Promise.all([
      fetchLeaveNotifs(),
      fetchAllowanceNotifs(),
      fetchComplaintNotifs(),
      fetchAnnouncementNotifs(req.headers['x-admin-email']),
    ]);

    let merged = [...leave, ...allow, ...cmpl, ...ann].filter((n) => n.timestamp);
    merged.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Mark each item as read/unread relative to the supplied cursor.
    if (since && !isNaN(since.getTime())) {
      merged = merged.map((n) => ({
        ...n,
        read: new Date(n.timestamp) <= since,
      }));
    } else {
      merged = merged.map((n) => ({ ...n, read: false }));
    }

    const trimmed = merged.slice(0, limit);
    const unread  = merged.filter((n) => !n.read).length;

    res.json({
      success: true,
      items:   trimmed,
      unread,
      total:   merged.length,
    });
  } catch (err) {
    console.error('[notifications] failed:', err.message);
    // Soft-fail: empty feed, so the bell never shows stale hardcoded data.
    res.json({ success: true, items: [], unread: 0, total: 0 });
  }
});

module.exports = router;
