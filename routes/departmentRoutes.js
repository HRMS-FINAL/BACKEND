// routes/departmentRoutes.js
const express    = require('express');
const router     = express.Router();
const Department = require('../models/Department');
const Employee   = require('../models/Employee');

const COLORS = ['#4299E1','#9F7AEA','#4CAA17','#ECC94B','#F687B3','#ED8936','#38B2AC','#FC8181'];

// GET /api/departments — all active departments + LIVE employee count per row
router.get('/', async (req, res) => {
  try {
    const departments = await Department.find({ isActive: true }).sort({ createdAt: -1 }).lean();

    // Count employees per department in one aggregate. Employees may store
    // department as an ObjectId OR as a plain name string, so we bucket by
    // both keys and merge below.
    const byId = await Employee.aggregate([
      { $match: { isActive: { $ne: false } } },
      { $group: { _id: '$department', count: { $sum: 1 } } },
    ]);
    const countById   = {};
    const countByName = {};
    byId.forEach(r => {
      const k = String(r._id || '');
      if (/^[a-f0-9]{24}$/i.test(k)) countById[k]  = r.count;
      else                            countByName[k.toLowerCase()] = r.count;
    });

    const enriched = departments.map(d => ({
      ...d,
      employeeCount:
        (countById[String(d._id)] || 0) +
        (countByName[String(d.name || '').toLowerCase()] || 0),
    }));

    res.status(200).json({ success: true, data: enriched });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/departments/:id
router.get('/:id', async (req, res) => {
  try {
    const department = await Department.findById(req.params.id);
    if (!department) return res.status(404).json({ success: false, message: 'Department not found' });
    res.status(200).json({ success: true, data: department });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/departments — create
router.post('/', async (req, res) => {
  try {
    const { name, manager, budget } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Department name is required' });

    const exists = await Department.findOne({ name: name.trim(), isActive: true });
    if (exists) return res.status(400).json({ success: false, message: `Department "${name}" already exists` });

    const count = await Department.countDocuments();
    const color = COLORS[count % COLORS.length];
    const department = await Department.create({ name: name.trim(), manager: manager || '', budget: budget || '', color });
    res.status(201).json({ success: true, data: department, message: `Department "${name}" created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/departments/:id — update
router.put('/:id', async (req, res) => {
  try {
    const department = await Department.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!department) return res.status(404).json({ success: false, message: 'Department not found' });
    res.status(200).json({ success: true, data: department, message: 'Department updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/departments/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const department = await Department.findByIdAndDelete(req.params.id);
    if (!department) return res.status(404).json({ success: false, message: 'Department not found' });
    res.status(200).json({ success: true, message: `Department "${department.name}" deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
