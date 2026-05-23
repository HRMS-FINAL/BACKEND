/**
 * Danger-zone cleanup endpoints. Each requires a confirmation phrase in the
 * POST body so they can't be triggered by accident (e.g. by a stale browser
 * tab or a misclick). Soft-delete is preferred where the schema supports it,
 * hard-delete is used for catalogue-style collections (departments,
 * designations, access roles) that don't have an isActive flag.
 *
 * Mounted at /api/admin in server.js.
 */
const express   = require('express');
const router    = express.Router();
const mongoose  = require('mongoose');

const Employee     = require('../models/Employee');
const Department   = require('../models/Department');
const Designation  = require('../models/Designation');
const AccessRole   = require('../models/AccessRole');

function requireConfirm(req, res, phrase) {
  const got = String(req.body?.confirm || '').trim();
  if (got !== phrase) {
    res.status(400).json({
      success: false,
      message: `Confirmation required. POST body must include {"confirm":"${phrase}"} to proceed.`,
    });
    return false;
  }
  return true;
}

/**
 * POST /api/admin/wipe-departments
 * Body: { "confirm": "DELETE_ALL_DEPARTMENTS" }
 */
router.post('/wipe-departments', async (req, res) => {
  if (!requireConfirm(req, res, 'DELETE_ALL_DEPARTMENTS')) return;
  try {
    const r = await Department.deleteMany({});
    console.warn(`[admin cleanup] departments wiped: ${r.deletedCount}`);
    res.json({ success: true, deleted: r.deletedCount || 0, collection: 'departments' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/wipe-designations
 * Body: { "confirm": "DELETE_ALL_DESIGNATIONS" }
 */
router.post('/wipe-designations', async (req, res) => {
  if (!requireConfirm(req, res, 'DELETE_ALL_DESIGNATIONS')) return;
  try {
    const r = await Designation.deleteMany({});
    console.warn(`[admin cleanup] designations wiped: ${r.deletedCount}`);
    res.json({ success: true, deleted: r.deletedCount || 0, collection: 'designations' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/wipe-access-roles
 * Body: { "confirm": "DELETE_ALL_ACCESS_ROLES" }
 */
router.post('/wipe-access-roles', async (req, res) => {
  if (!requireConfirm(req, res, 'DELETE_ALL_ACCESS_ROLES')) return;
  try {
    const r = await AccessRole.deleteMany({});
    console.warn(`[admin cleanup] access roles wiped: ${r.deletedCount}`);
    res.json({ success: true, deleted: r.deletedCount || 0, collection: 'accessroles' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/wipe-employees-except
 * Body: {
 *   "confirm": "DELETE_EMPLOYEES_EXCEPT",
 *   "keep":    ["Monica", "Pavithra"]    // optional — defaults to these two
 * }
 *
 * Deletes every employee whose firstName/lastName/full name doesn't contain
 * (case-insensitive) any of the "keep" entries. Also wipes ATTENDANCE,
 * LEAVES, ALLOWANCES, NOTIFICATIONS, PAYSLIPS, COMPLAINTS for the deleted
 * employees so they don't leave orphans pointing to non-existent users.
 */
router.post('/wipe-employees-except', async (req, res) => {
  if (!requireConfirm(req, res, 'DELETE_EMPLOYEES_EXCEPT')) return;
  try {
    const keepInput = Array.isArray(req.body?.keep) && req.body.keep.length
      ? req.body.keep
      : ['Monica', 'Pavithra'];
    const keepLower = keepInput.map(s => String(s).toLowerCase().trim()).filter(Boolean);

    // Fetch all candidates so we can match liberally (firstName, lastName,
    // virtual `name`, username). Mongo can't do "case-insensitive contains"
    // efficiently across multiple fields without $regex per row.
    const all = await Employee.find({}).lean();

    const isKeep = (e) => {
      const haystack = [
        e.firstName, e.lastName,
        (e.firstName && e.lastName ? `${e.firstName} ${e.lastName}` : ''),
        e.name, e.username, e.email,
      ].filter(Boolean).map(s => String(s).toLowerCase()).join(' | ');
      return keepLower.some(k => haystack.includes(k));
    };

    const toDelete = all.filter(e => !isKeep(e));
    const kept     = all.filter(isKeep);

    if (req.body?.dryRun === true) {
      return res.json({
        success: true,
        dryRun: true,
        wouldDelete: toDelete.length,
        wouldKeep:   kept.length,
        keepList:    keepInput,
        deletePreview: toDelete.slice(0, 50).map(e => ({
          _id: e._id, employeeId: e.employeeId, name: e.name ||
            [e.firstName, e.lastName].filter(Boolean).join(' '), email: e.email,
        })),
        keepPreview: kept.map(e => ({
          _id: e._id, employeeId: e.employeeId, name: e.name ||
            [e.firstName, e.lastName].filter(Boolean).join(' '), email: e.email,
        })),
      });
    }

    const deleteIds = toDelete.map(e => e._id);
    const r = await Employee.deleteMany({ _id: { $in: deleteIds } });

    // Clear orphan data referencing the deleted users.
    const db = mongoose.connection.db;
    const orphanCols = ['attendances', 'leaves', 'allowances', 'notifications',
                        'payslips', 'complaints', 'attendancerequests',
                        'locationpings'];
    const orphans = {};
    for (const name of orphanCols) {
      try {
        const r2 = await db.collection(name).deleteMany({ user: { $in: deleteIds } });
        orphans[name] = r2.deletedCount || 0;
      } catch (e) {
        orphans[name] = `skip: ${e.message}`;
      }
    }

    console.warn(`[admin cleanup] wiped ${r.deletedCount} employees keeping [${keepInput.join(', ')}], orphans: ${JSON.stringify(orphans)}`);

    res.json({
      success: true,
      deletedEmployees: r.deletedCount || 0,
      keptEmployees:    kept.length,
      keepList:         keepInput,
      orphanRowsDeleted: orphans,
    });
  } catch (err) {
    console.error('[wipe-employees-except]', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * Convenience three-in-one: clears Departments + Designations + AccessRoles
 * in a single call. Confirmation required.
 *
 * POST /api/admin/wipe-catalogue
 * Body: { "confirm": "DELETE_CATALOGUE" }
 */
router.post('/wipe-catalogue', async (req, res) => {
  if (!requireConfirm(req, res, 'DELETE_CATALOGUE')) return;
  try {
    const [d1, d2, d3] = await Promise.all([
      Department.deleteMany({}),
      Designation.deleteMany({}),
      AccessRole.deleteMany({}),
    ]);
    res.json({
      success: true,
      departments:  d1.deletedCount || 0,
      designations: d2.deletedCount || 0,
      accessRoles:  d3.deletedCount || 0,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
