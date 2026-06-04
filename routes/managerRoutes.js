// routes/managerRoutes.js  —  Manager directory CRUD.
//
// • GET    /api/managers           — list active managers (auto-seeds on first call)
// • POST   /api/managers           — add a new manager
// • DELETE /api/managers/:id       — soft-delete (isActive=false)
//
// Side effect of POST: if `email` matches an existing employee, that
// employee's `role` is flipped to 'manager' so ERM Web manager-side
// access is granted automatically. No employee match? The manager
// entry still appears in the Assigned-To dropdown so HR can later
// create the employee row and the link forms by name.
const express  = require('express');
const router   = express.Router();
const Manager  = require('../models/Manager');
const Employee = require('../models/Employee');

// Seed the 8 canonical names from companyData.js the first time anyone
// hits the API. Idempotent — uses upsert keyed on name.
const SEED = [
  { name: 'Vimal Kumar', title: 'Managing Director' },
  { name: 'Saleem',      title: 'Sales Head' },
  { name: 'Vishnu',      title: 'Execution Head' },
  { name: 'Sathish',     title: 'Project Manager' },
  { name: 'Karthick',    title: 'Structural Engineer' },
  { name: 'Anish Kumar', title: 'CEO' },
  { name: 'Vivek',       title: 'Technical Lead Consultant' },
  { name: 'Vimal M',     title: 'Finance Head' },
];
let seeded = false;
async function ensureSeeded() {
  if (seeded) return;
  try {
    for (const m of SEED) {
      await Manager.updateOne(
        { name: m.name },
        { $setOnInsert: { name: m.name, title: m.title, isActive: true } },
        { upsert: true, collation: { locale: 'en', strength: 2 } }
      );
    }
    seeded = true;
  } catch (e) {
    console.warn('[managers.seed] failed:', e.message);
  }
}

router.get('/', async (req, res) => {
  await ensureSeeded();
  try {
    const items = await Manager.find({ isActive: true })
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, title, email } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    const doc = await Manager.findOneAndUpdate(
      { name: String(name).trim() },
      {
        $set: {
          name:  String(name).trim(),
          title: String(title || '').trim(),
          email: String(email || '').trim().toLowerCase(),
          isActive: true,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        collation: { locale: 'en', strength: 2 },
      }
    );

    // Side effect: grant ERM Web manager access by flipping the matching
    // Employee row's role to 'manager'. Two-pass lookup:
    //   1. exact email match (if email was provided)
    //   2. case-insensitive full-name match against firstName + lastName
    //      or the legacy `name` field
    // We also force isActive=true so a dormant account is signed-in-ready.
    let promoted    = false;
    let promotedRef = '';
    try {
      const updates = { role: 'manager', isActive: true };

      // Pass 1: by email
      let updated = null;
      if (doc.email) {
        updated = await Employee.findOneAndUpdate(
          { email: String(doc.email).toLowerCase().trim() },
          { $set: updates },
          { new: true }
        );
      }

      // Pass 2: by case-insensitive name. Match against either the
      // `firstName + ' ' + lastName` concatenation OR the legacy `name`
      // field. Escape regex specials in the manager's name first.
      if (!updated && doc.name) {
        const safe = String(doc.name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const nameRx = new RegExp(`^\\s*${safe}\\s*$`, 'i');
        updated = await Employee.findOneAndUpdate(
          { $or: [
              { name: nameRx },
              { $expr: { $regexMatch: {
                input: { $trim: { input: { $concat: [
                  { $ifNull: ['$firstName', ''] }, ' ', { $ifNull: ['$lastName', ''] },
                ] } } },
                regex: nameRx,
              } } },
            ],
          },
          { $set: updates },
          { new: true }
        );
      }

      if (updated) {
        promoted = true;
        promotedRef = updated.email || updated.name || String(updated._id);
        console.log('[managers.create] promoted', promotedRef, 'to role=manager');
      } else {
        console.log('[managers.create] no employee match for', doc.name, doc.email || '(no email)');
      }
    } catch (e) {
      console.warn('[managers.create] role promotion failed:', e.message);
    }

    res.status(201).json({ success: true, data: doc, promoted, promotedRef });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'A manager with this name already exists' });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const doc = await Manager.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ success: false, message: 'Manager not found' });

    // ── Cascade cleanup ────────────────────────────────────────────────
    // Once a manager is removed from the directory the rest of the app
    // must catch up automatically. Three side effects:
    //   1. Demote any employee with matching email or name from
    //      role='manager' → 'employee'. They lose ERM Web manager
    //      access on next sign-in / token refresh.
    //   2. Clear assignedTo on every employee currently reporting to
    //      this manager so the Assigned-To column doesn't show a
    //      stranded reference.
    //   3. (Implicit) the /api/managers GET no longer returns this row
    //      so the Assigned-To dropdown on Add Employee + Employee List
    //      edit + Department create stops listing them automatically.
    const cleanup = { demoted: 0, unassigned: 0 };
    try {
      // Build a case-insensitive name regex for the demotion + reassign
      // lookups. Name match catches seeded directory rows (Vimal Kumar,
      // Saleem, etc.) which don't carry an email.
      const nameRx = new RegExp(`^${String(doc.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').trim()}$`, 'i');

      // 1. Demote — by email if we have it, else by name.
      try {
        const filter = doc.email
          ? { $or: [{ email: String(doc.email).toLowerCase() }, { name: nameRx }], role: 'manager' }
          : { name: nameRx, role: 'manager' };
        const r = await Employee.updateMany(filter, { $set: { role: 'employee' } });
        cleanup.demoted = r.modifiedCount || 0;
      } catch (e) {
        console.warn('[managers.delete] role demote failed:', e.message);
      }

      // 2. Clear assignedTo on everyone currently reporting to them.
      try {
        const r = await Employee.updateMany(
          { assignedTo: nameRx },
          { $set: { assignedTo: '' } }
        );
        cleanup.unassigned = r.modifiedCount || 0;
      } catch (e) {
        console.warn('[managers.delete] assignedTo clear failed:', e.message);
      }

      console.log(`[managers.delete] cleanup for ${doc.name}: demoted=${cleanup.demoted}, unassigned=${cleanup.unassigned}`);
    } catch (e) {
      console.warn('[managers.delete] cascade failed:', e.message);
    }

    res.json({ success: true, data: doc, cleanup });
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid manager id' });
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
