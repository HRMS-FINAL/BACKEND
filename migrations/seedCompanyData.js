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
const DEPARTMENTS = [
  { name: 'Management',           manager: 'Vimal Kumar' },
  { name: 'Sales',                manager: 'Saleem Khan' },
  { name: 'Execution',            manager: 'Vishnu K' },
  { name: 'Business Development', manager: 'Anish Kumar' },
  { name: 'Design',               manager: 'Gopinath' },
  { name: 'Engineering',          manager: 'Sinduja' },
  { name: 'Marketing',            manager: 'Durga Devi' },
  { name: 'HR',                   manager: 'Pavithra B' },
  { name: 'Project Management',   manager: 'Suresh' },
  { name: 'Development',          manager: 'Vivek' },
  { name: 'Accounts',             manager: 'Vimal M' },
];

// [title, departmentName]. Duplicates by title are skipped at insert time.
const DESIGNATIONS = [
  ['Managing Director',           'Management'],
  ['Sales head',                  'Sales'],
  ['Execution Head',              'Execution'],
  ['Business Development Head',   'Business Development'],
  ['Business Development manager','Business Development'],
  ['Business Development Associate','Business Development'],
  ['Design Head',                 'Design'],
  ['Design Manager',              'Design'],
  ['Design Engineer',             'Design'],
  ['Designer Engineer',           'Design'],
  ['Senior Engineer',             'Engineering'],
  ['Site Engineer',               'Engineering'],
  ['Structural Engineer',         'Engineering'],
  ['Technical Lead',              'Engineering'],
  ['Technical Lead Consultant',   'Engineering'],
  ['Project Engineer',            'Project Management'],
  ['Web Developer',               'Development'],
  ['UI/UX Developer',             'Development'],
  ['Sales Coordinator',           'Sales'],
  ['Sales Executive',             'Sales'],
  ['Techno Commercial Coordinator','Sales'],
  ['Digital Marketing Manager',   'Marketing'],
  ['SEO',                         'Marketing'],
  ['Video editor',                'Marketing'],
  ['HR',                          'HR'],
  ['Accountant',                  'Accounts'],
];

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
