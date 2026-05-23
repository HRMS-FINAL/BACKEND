/**
 * One-shot cleanup:
 *   - Deletes ALL Departments
 *   - Deletes ALL Designations
 *   - Deletes ALL Access Roles
 *   - Deletes ALL Employees EXCEPT Monica and Pavithra (case-insensitive name match)
 *   - Wipes orphaned attendance / leave / allowance / notification / payslip
 *     / complaint / attendancerequest / locationping rows that point at the
 *     deleted employees.
 *
 * Usage from the Backend directory:
 *   node scripts/cleanup.js              # actually does the wipe
 *   node scripts/cleanup.js --dry-run    # shows what would happen, no writes
 *
 * Reads MONGO_URI from .env in the parent directory.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const KEEP = ['monica', 'pavithra'];      // names to keep (lowercase)
const DRY  = process.argv.includes('--dry-run');

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set in Backend/.env');
    process.exit(1);
  }
  console.log(`Connecting to MongoDB${DRY ? ' (DRY RUN)' : ''}...`);
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  // ── Initial counts ───────────────────────────────────────────────
  const COLS = ['employees', 'departments', 'designations', 'accessroles',
                'attendances', 'leaves', 'allowances', 'notifications',
                'payslips', 'complaints', 'attendancerequests', 'locationpings'];
  const counts = {};
  for (const n of COLS) {
    try { counts[n] = await db.collection(n).countDocuments(); }
    catch { counts[n] = '—'; }
  }
  console.log('\nBefore:');
  Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));

  // ── Identify keep vs delete employees ────────────────────────────
  const allEmps = await db.collection('employees').find({}).toArray();
  const isKeep = (e) => {
    const hay = [e.firstName, e.lastName, e.name, e.username, e.email,
                 (e.firstName && e.lastName ? `${e.firstName} ${e.lastName}` : '')]
      .filter(Boolean).map(s => String(s).toLowerCase()).join(' | ');
    return KEEP.some(k => hay.includes(k));
  };
  const keep   = allEmps.filter(isKeep);
  const remove = allEmps.filter(e => !isKeep(e));

  console.log(`\nEmployees: ${allEmps.length} total, keep ${keep.length}, delete ${remove.length}`);
  console.log('  Keeping:');
  keep.forEach(e => console.log(`    - ${e.firstName || ''} ${e.lastName || ''} <${e.email}>`));
  console.log('  Deleting (first 10 shown):');
  remove.slice(0, 10).forEach(e => console.log(`    - ${e.firstName || ''} ${e.lastName || ''} <${e.email}>`));
  if (remove.length > 10) console.log(`    ...and ${remove.length - 10} more`);

  if (DRY) {
    console.log('\nDRY RUN — no changes made. Re-run without --dry-run to apply.');
    await mongoose.disconnect();
    return;
  }

  // ── Wipe catalogue collections ───────────────────────────────────
  const wipes = {};
  for (const col of ['departments', 'designations', 'accessroles']) {
    try {
      const r = await db.collection(col).deleteMany({});
      wipes[col] = r.deletedCount || 0;
    } catch (e) {
      wipes[col] = `skip: ${e.message}`;
    }
  }

  // ── Delete employees + orphaned data ─────────────────────────────
  const deleteIds = remove.map(e => e._id);
  const empResult = await db.collection('employees').deleteMany({ _id: { $in: deleteIds } });
  wipes.employees = empResult.deletedCount || 0;

  const orphans = {};
  for (const col of ['attendances', 'leaves', 'allowances', 'notifications',
                     'payslips', 'complaints', 'attendancerequests', 'locationpings']) {
    try {
      const r = await db.collection(col).deleteMany({ user: { $in: deleteIds } });
      orphans[col] = r.deletedCount || 0;
    } catch (e) {
      orphans[col] = `skip: ${e.message}`;
    }
  }

  // ── Final counts ─────────────────────────────────────────────────
  const after = {};
  for (const n of COLS) {
    try { after[n] = await db.collection(n).countDocuments(); }
    catch { after[n] = '—'; }
  }
  console.log('\nAfter:');
  Object.entries(after).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
  console.log('\nDeleted:');
  Object.entries({ ...wipes, ...orphans }).forEach(([k, v]) => console.log(`  ${k.padEnd(20)} ${v}`));
  console.log('\nDone.');
  await mongoose.disconnect();
})().catch(err => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
