// routes/designationRoutes.js
const express     = require('express');
const router      = express.Router();
const Designation = require('../models/Designation');

const COLORS = ['#4299E1','#9F7AEA','#4CAA17','#ECC94B','#F687B3','#ED8936','#38B2AC','#FC8181'];

// GET /api/designations — all active designations
router.get('/', async (req, res) => {
  try {
    const designations = await Designation.find({ isActive: true }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: designations });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/designations/:id
router.get('/:id', async (req, res) => {
  try {
    const designation = await Designation.findById(req.params.id);
    if (!designation) return res.status(404).json({ success: false, message: 'Designation not found' });
    res.status(200).json({ success: true, data: designation });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/designations — create
router.post('/', async (req, res) => {
  try {
    const { title, dept, minSalary, maxSalary } = req.body;
    if (!title) return res.status(400).json({ success: false, message: 'Designation title is required' });

    const exists = await Designation.findOne({ title: title.trim(), isActive: true });
    if (exists) return res.status(400).json({ success: false, message: `Designation "${title}" already exists` });

    const count = await Designation.countDocuments();
    const color = COLORS[count % COLORS.length];
    const designation = await Designation.create({ title: title.trim(), dept: dept || '', minSalary: minSalary || 0, maxSalary: maxSalary || 0, color });
    res.status(201).json({ success: true, data: designation, message: `Designation "${title}" created successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/designations/:id — update
router.put('/:id', async (req, res) => {
  try {
    const designation = await Designation.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!designation) return res.status(404).json({ success: false, message: 'Designation not found' });
    res.status(200).json({ success: true, data: designation, message: 'Designation updated successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/designations/:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    const designation = await Designation.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!designation) return res.status(404).json({ success: false, message: 'Designation not found' });
    res.status(200).json({ success: true, message: `Designation "${designation.title}" deleted successfully` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
