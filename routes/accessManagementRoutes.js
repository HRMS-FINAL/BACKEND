// routes/accessManagementRoutes.js — Access Management (formerly Role)
const express    = require('express');
const router     = express.Router();
const AccessRole = require('../models/AccessRole');
const Employee   = require('../models/Employee');

const MODULES = ['dashboard', 'employees', 'payroll', 'attendance', 'settings', 'live_tracking'];
async function ensureDefaultRoles() {
  const wanted = [
    { name: 'HR',       color: '#9F7AEA', description: 'Human Resources team — manages employees, payroll, leaves.' },
    { name: 'Manager',  color: '#4CAA17', description: 'Team / Department managers — approve requests for their team.' },
    { name: 'Employee', color: '#4299E1', description: 'Standard team member — self-service access only.' },
  ];
  for (const r of wanted) {
    const exists = await AccessRole.findOne({ name: r.name });
    if (!exists) {
      try { await AccessRole.create({ ...r, permissions: defaultPermissions(), isActive: true }); }
      catch (e) { if (e.code !== 11000) console.warn('[access-role seed]', r.name, e.message); }
    }
  }
}

const defaultPermissions = () =>
  Object.fromEntries(MODULES.map(m => [m, { view: false, create: false, edit: false, delete: false }]));

// GET /api/access-management — list active roles + LIVE member count
// Auto-seeds HR/Manager/Employee if missing. Counts buckets employees by:
//   1) accessRole ObjectId pointing at this collection (HR-set), OR
//   2) Employee.role string ('hr' / 'admin' / 'employee') as fallback.
router.get('/', async (req, res) => {
  try {
    await ensureDefaultRoles();
    const roles = await AccessRole.find({ isActive: true }).sort({ createdAt: 1 }).lean();

    const employees = await Employee.find({ isActive: { $ne: false } })
      .select('accessRole role firstName lastName name email employeeId assignedTo')
      .lean();

    // Build a set of every name / email / id that appears as someone
    // else's "Assigned To" (i.e. manager). Anyone in this set is treated
    // as a Manager regardless of their `role` field — HR's request is
    // that "the people in the Assigned To dropdown ARE the managers".
    const managerKeys = new Set();
    for (const e of employees) {
      const a = String(e.assignedTo || '').trim().toLowerCase();
      if (a) managerKeys.add(a);
    }
    // Helper — does this employee look like a manager?
    const isManager = (e) => {
      const candidates = [
        e.firstName, e.lastName,
        e.firstName && e.lastName ? `${e.firstName} ${e.lastName}` : null,
        e.name, e.email, e.employeeId,
      ].filter(Boolean).map(s => String(s).trim().toLowerCase());
      return candidates.some(c => managerKeys.has(c));
    };

    const roleByObjId = Object.fromEntries(roles.map(r => [String(r._id), r.name]));
    const memberCount = {};
    roles.forEach(r => { memberCount[r.name] = 0; });

    for (const e of employees) {
      let bucket = null;
      // 1. Explicit accessRole pointer wins (HR-set in the UI).
      if (e.accessRole) bucket = roleByObjId[String(e.accessRole)] || null;
      // 2. Anyone listed as another employee's "Assigned To" is a Manager
      //    — this is the rule HR asked for and supersedes the older
      //    `role === 'admin'` heuristic.
      if (!bucket && isManager(e)) bucket = 'Manager';
      // 3. Fallback to the legacy `role` string.
      if (!bucket) {
        const r = String(e.role || '').toLowerCase();
        if (r === 'hr')         bucket = 'HR';
        else if (r === 'admin') bucket = 'Manager';
        else                    bucket = 'Employee';
      }
      if (memberCount[bucket] !== undefined) memberCount[bucket]++;
    }

    const enriched = roles.map(r => ({ ...r, members: memberCount[r.name] || 0 }));
    res.status(200).json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/access-management/:id
router.get('/:id', async (req, res) => {
  try {
    const role = await AccessRole.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Access role not found' });
    res.status(200).json({ success: true, data: role });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/access-management — create new role
router.post('/', async (req, res) => {
  try {
    const { name, description, color } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Role name is required' });
    const role = await AccessRole.create({
      name: name.trim(),
      description: description || '',
      color: color || '#4CAA17',
      permissions: defaultPermissions(),
    });
    res.status(201).json({ success: true, data: role, message: `Access role "${name}" created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/access-management/:id — update name/description/color
router.put('/:id', async (req, res) => {
  try {
    const role = await AccessRole.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!role) return res.status(404).json({ success: false, message: 'Access role not found' });
    res.status(200).json({ success: true, data: role, message: 'Access role updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/access-management/:id/permissions — update permission matrix
router.put('/:id/permissions', async (req, res) => {
  try {
    const { permissions } = req.body;
    if (!permissions) return res.status(400).json({ success: false, message: 'Permissions object is required' });
    const role = await AccessRole.findByIdAndUpdate(req.params.id, { permissions }, { new: true, runValidators: true });
    if (!role) return res.status(404).json({ success: false, message: 'Access role not found' });
    res.status(200).json({ success: true, data: role, message: 'Permissions updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/access-management/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const role = await AccessRole.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!role) return res.status(404).json({ success: false, message: 'Access role not found' });
    res.status(200).json({ success: true, message: 'Access role "' + role.name + '" deleted' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
