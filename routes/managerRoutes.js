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

    // Side effect: if the email matches an Employee row, grant manager
    // access by flipping role='manager'. This is how the ERM Web manager
    // routes know to let them in.
    let promoted = false;
    if (doc.email) {
      try {
        const updated = await Employee.findOneAndUpdate(
          { email: doc.email },
          { $set: { role: 'manager' } },
          { new: true }
        );
        if (updated) promoted = true;
      } catch (e) {
        console.warn('[managers.create] role promotion failed:', e.message);
      }
    }

    res.status(201).json({ success: true, data: doc, promoted });
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

    // If this manager was tied to an Employee record by email, demote
    // them back to 'employee'. Manager access in ERM Web drops on the
    // next sign-in / token refresh.
    if (doc.email) {
      try {
        await Employee.updateOne({ email: doc.email, role: 'manager' }, { $set: { role: 'employee' } });
      } catch (e) {
        console.warn('[managers.delete] role demote failed:', e.message);
      }
    }
    res.json({ success: true, data: doc });
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid manager id' });
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
