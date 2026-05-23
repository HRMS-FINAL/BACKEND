/**
 * Wipe stale rows that pollute the HRMS Reports and Approvals pages:
 *   • attendances        — old local-DB attendance rows (mobile is the source of truth)
 *   • leaverequests      — HRMS-side leave/permission requests
 *   • attendancerequests — regularize / late-justification / missing-checkout
 *
 * The mobile-backed collections (real check-ins, real leave docs from the
 * mobile app) are NOT touched.
 *
 *   node scripts/wipeStaleData.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set in Backend/.env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const targets = ['attendances', 'leaverequests', 'attendancerequests'];
  const out = {};
  for (const name of targets) {
    try {
      const before = await db.collection(name).countDocuments();
      const r = await db.collection(name).deleteMany({});
      out[name] = { before, deleted: r.deletedCount || 0 };
    } catch (e) {
      out[name] = { error: e.message };
    }
  }
  console.log(JSON.stringify(out, null, 2));
  await mongoose.disconnect();
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
