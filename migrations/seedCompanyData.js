/**
 * Seed the Departments and Designations collections with Tesco Structures'
 * actual catalogue (the list HR provided). Idempotent — only creates rows
 * that don't already exist by name.
 *
 * Designations stay roughly in the order HR listed them so the dropdowns
 * read naturally. Each designation maps to a department for the join.
 *
 * Wired into server.js startup right after the mobile import.
 */

const Department  = require('../models/Department');
const Designation = require('../models/Designation');

// One row per department the catalogue implies. The manager column is the
// person from HR's printed roster who heads that department; null = no
// matching Head/Manager in the source list.
// DEPARTMENTS seed list emptied for go-live (Jun 2026).
// HR manages departments via the HRMS UI; this file is no longer the
// source of truth. Kept as an empty array so the unused seedCompanyData
// function (boot call disabled in server.js) is still a clean no-op.
const DEPARTMENTS = [];

// [title, departmentName]. Duplicates by title are skipped at insert time.
// DESIGNATIONS seed list emptied for go-live (Jun 2026).
const DESIGNATIONS = [];

async function ensureDepartments() {
  let created = 0;
  let updated = 0;
  for (const { name, manager } of DEPARTMENTS) {
    const exists = await Department.findOne({ name }).lean();
    if (!exists) {
      try {
        await Department.create({ name, manager: manager || '' });
        created++;
      } catch (e) {
        if (e.code !== 11000) console.warn(`[seed] dept "${name}":`, e.message);
      }
    } else if (manager && exists.manager !== manager) {
      // Keep the manager column in sync with the catalogue. This also
      // corrects any earlier mistake (e.g. Development had been assigned
      // Sinduja before HR confirmed Vivek heads Development).
      await Department.updateOne({ _id: exists._id }, { $set: { manager } });
      updated++;
    }
  }
  return created + updated;
}

async function ensureDesignations() {
  let created = 0;
  for (const [title, dept] of DESIGNATIONS) {
    const exists = await Designation.findOne({ title }).lean();
    if (!exists) {
      try {
        await Designation.create({ title, dept });
        created++;
      } catch (e) {
        if (e.code !== 11000) console.warn(`[seed] desig "${title}":`, e.message);
      }
    }
  }
  return created;
}

async function seedCompanyData() {
  try {
    const d = await ensureDepartments();
    const g = await ensureDesignations();
    if (d || g) {
      console.log(`[SEED] Catalogue topped up: +${d} departments, +${g} designations.`);
    } else {
      console.log('[SEED] Catalogue already complete (no rows added).');
    }
    return { success: true, departmentsAdded: d, designationsAdded: g };
  } catch (err) {
    console.warn('[SEED] seedCompanyData failed:', err.message);
    return { success: false, message: err.message };
  }
}

module.exports = { seedCompanyData, DEPARTMENTS, DESIGNATIONS };
