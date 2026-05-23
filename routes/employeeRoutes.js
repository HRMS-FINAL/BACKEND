// routes/employeeRoutes.js — Employee CRUD with safe populate
const express     = require('express');
const router      = express.Router();
const mongoose    = require('mongoose');
const Employee    = require('../models/Employee');
const Department  = require('../models/Department');
const Designation = require('../models/Designation');
const AccessRole  = require('../models/AccessRole');

const isObjectId = v => v && mongoose.Types.ObjectId.isValid(String(v)) && String(v).length === 24;

// Safely resolve dept/desig/role from either ObjectId or plain string
const resolveEmployee = (e, deptMap, desigMap, roleMap) => ({
  ...e,
  department:  isObjectId(e.department)  ? (deptMap[String(e.department)]   || { name: String(e.department  || '—') }) : { name: String(e.department  || '—') },
  designation: isObjectId(e.designation) ? (desigMap[String(e.designation)] || { title: String(e.designation || '—') }) : { title: String(e.designation || '—') },
  accessRole:  isObjectId(e.accessRole)  ? (roleMap[String(e.accessRole)]   || { name: String(e.accessRole  || '—') })  : { name: String(e.accessRole  || '—') },
});

const loadLookupMaps = async () => {
  const [depts, desigs, roles] = await Promise.all([
    Department.find({}).lean(),
    Designation.find({}).lean(),
    AccessRole.find({}).lean(),
  ]);
  const deptMap  = Object.fromEntries(depts.map(d  => [String(d._id), d]));
  const desigMap = Object.fromEntries(desigs.map(d => [String(d._id), d]));
  const roleMap  = Object.fromEntries(roles.map(r  => [String(r._id), r]));
  return { deptMap, desigMap, roleMap, depts, desigs };
};

// ── GET /api/employees ──────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)   || 1);
    const limit  = Math.min(200, parseInt(req.query.limit) || 20);
    const skip   = (page - 1) * limit;
    const search = req.query.search;

    const filter = {};
    if (search) {
      filter.$or = [
        { firstName:  { $regex: search, $options: 'i' } },
        { lastName:   { $regex: search, $options: 'i' } },
        { email:      { $regex: search, $options: 'i' } },
        { employeeId: { $regex: search, $options: 'i' } },
      ];
    }

    const [total, rawEmployees] = await Promise.all([
      Employee.countDocuments(filter),
      Employee.find(filter).lean().sort({ createdAt: -1 }).skip(skip).limit(limit),
    ]);

    const { deptMap, desigMap, roleMap } = await loadLookupMaps();
    const employees = rawEmployees.map(e => resolveEmployee(e, deptMap, desigMap, roleMap));

    return res.status(200).json({ success: true, total, page, pages: Math.ceil(total / limit), employees });
  } catch (err) {
    console.error('[EMPLOYEE] List error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/employees/latest ───────────────────────────────────
router.get('/latest', async (req, res) => {
  try {
    const emp = await Employee.findOne().lean().sort({ createdAt: -1 });
    if (!emp) return res.status(404).json({ success: false, message: 'No employees yet' });
    return res.status(200).json({ success: true, employee: emp });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/employees/:id ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id).lean();
    if (!emp) return res.status(404).json({ success: false, message: 'Employee not found' });
    const { deptMap, desigMap, roleMap } = await loadLookupMaps();
    return res.status(200).json({ success: true, employee: resolveEmployee(emp, deptMap, desigMap, roleMap) });
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid employee id' });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/employees — create ────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const b = req.body;

    // Resolve department: accept ObjectId OR name string
    let deptId = null;
    if (b.department) {
      if (isObjectId(b.department)) {
        deptId = b.department;
      } else {
        const dept = await Department.findOne({ name: { $regex: new RegExp(`^${b.department}$`, 'i') } }).lean();
        deptId = dept ? dept._id : null;
        // If department name not found in DB, create it on the fly
        if (!deptId) {
          const newDept = await Department.create({ name: b.department });
          deptId = newDept._id;
        }
      }
    }

    // Resolve designation: accept ObjectId OR title string
    let desigId = null;
    if (b.designation) {
      if (isObjectId(b.designation)) {
        desigId = b.designation;
      } else {
        const desig = await Designation.findOne({ title: { $regex: new RegExp(`^${b.designation}$`, 'i') } }).lean();
        desigId = desig ? desig._id : null;
        // If designation not found, create it on the fly
        if (!desigId) {
          const newDesig = await Designation.create({ title: b.designation, dept: b.department || 'General' });
          desigId = newDesig._id;
        }
      }
    }

    const payload = {
      firstName:      b.firstName,
      lastName:       b.lastName,
      username:       b.username,
      password:       b.password || 'password123',
      email:          b.email,
      phone:          b.phone,
      address:        b.address || { street: b.street || '', city: b.city || '', state: b.state || '', zipCode: b.zipCode || '', country: b.country || '' },
      employeeId:     b.employeeId,
      department:     deptId,
      designation:    desigId,
      employmentType: b.employmentType || '',
      joiningDate:    b.joiningDate,
      salary:         Number(b.salary) || 0,
      assignedTo:     b.assignedTo,
      education:      b.education || { degree: b.degree || '', university: b.university || '', fieldOfStudy: b.fieldOfStudy || '', graduationYear: Number(b.graduationYear) || 2020 },
      status:         b.status || 'Active',
      isActive:       true,
    };

    const employee = await Employee.create(payload);
    console.log(`[EMPLOYEE] Created: ${employee.employeeId} — ${employee.firstName} ${employee.lastName}`);
    return res.status(201).json({ success: true, message: 'Employee created successfully', data: employee.toSafeObject() });
  } catch (err) {
    console.error('[EMPLOYEE] Create error:', err.message);
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, message: 'Validation failed: ' + Object.values(err.errors).map(e => e.message).join(', ') });
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      return res.status(400).json({ success: false, message: `${field} already exists. Please use a different value.` });
    }
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /api/employees/:id — update ────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const payload = { ...req.body };
    delete payload.password;
    Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

    const employee = await Employee.findByIdAndUpdate(req.params.id, payload, { new: true, runValidators: false });
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });
    return res.status(200).json({ success: true, message: 'Employee updated successfully', employee: employee.toSafeObject() });
  } catch (err) {
    if (err.name === 'CastError') return res.status(400).json({ success: false, message: 'Invalid employee id' });
    if (err.code === 11000) return res.status(400).json({ success: false, message: 'Duplicate value' });
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/employees/:id — soft delete ─────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const employee = await Employee.findByIdAndUpdate(
      req.params.id,
      { isActive: false, status: 'Terminated' },
      { new: true }
    );
    if (!employee) return res.status(404).json({ success: false, message: 'Employee not found' });
    return res.status(200).json({ success: true, message: `Employee "${employee.firstName} ${employee.lastName}" removed` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
