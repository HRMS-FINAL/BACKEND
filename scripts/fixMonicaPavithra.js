/**
 * Sets Monica's department to "Development" and Pavithra's to "HR".
 * Run from the Backend dir:
 *
 *   node scripts/fixMonicaPavithra.js
 *
 * Uses the live MONGO_URI from Backend/.env. Idempotent — if the dept rows
 * don't exist yet, it creates them; if the employees already point at the
 * right department, it's a no-op.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose   = require('mongoose');
const Employee   = require('../models/Employee');
const Department = require('../models/Department');

const ASSIGNMENTS = [
  { match: ['monica'],   deptName: 'Development' },
  { match: ['pavithra'], deptName: 'HR' },
];

async function ensureDept(name) {
  let d = await Department.findOne({ name, isActive: true });
  if (!d) d = await Department.create({ name });
  return d;
}

(async () => {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI not set in Backend/.env');
    process.exit(1);
  }
  console.log('Connecting...');
  await mongoose.connect(process.env.MONGO_URI);

  for (const { match, deptName } of ASSIGNMENTS) {
    const dept = await ensureDept(deptName);
    const matchedEmps = await Employee.find({
      $or: [
        { firstName: { $regex: new RegExp('^' + match[0] + '$', 'i') } },
        { lastName:  { $regex: new RegExp('^' + match[0] + '$', 'i') } },
        { email:     { $regex: new RegExp('^' + match[0],      'i') } },
      ],
    });
    if (matchedEmps.length === 0) {
      console.warn(`  No employee found matching "${match[0]}"`);
      continue;
    }
    for (const emp of matchedEmps) {
      await Employee.updateOne(
        { _id: emp._id },
        { $set: { department: dept._id } },
      );
      console.log(`  ${emp.firstName} ${emp.lastName} -> dept "${deptName}" (${dept._id})`);
    }
  }

  console.log('Done.');
  await mongoose.disconnect();
})().catch(err => { console.error('FAILED:', err.message); process.exit(1); });
