/**
 * Wipe every row in the access_roles collection so HR can start fresh.
 * Run from the Backend dir:
 *
 *   node scripts/wipeAccessRoles.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose   = require('mongoose');
const AccessRole = require('../models/AccessRole');

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set in Backend/.env');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const before = await AccessRole.countDocuments();
  const r = await AccessRole.deleteMany({});
  const after = await AccessRole.countDocuments();
  console.log(`Wiped access roles. before=${before} deleted=${r.deletedCount || 0} after=${after}`);
  await mongoose.disconnect();
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
