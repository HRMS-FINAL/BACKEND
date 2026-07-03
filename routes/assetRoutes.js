// routes/assetRoutes.js - Asset CRUD + assign / return / stats (open pattern)
const express  = require('express');
const router   = express.Router();
const mongoose = require('mongoose');
const Asset    = require('../models/Asset');

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// Locate by Mongo _id OR by human assetId (AST-001)
const findAssetByAnyId = async (id) => {
  if (isValidId(id)) {
    const byObjectId = await Asset.findOne({ _id: id, isActive: true });
    if (byObjectId) return byObjectId;
  }
  return Asset.findOne({ assetId: id.toUpperCase(), isActive: true });
};

// GET /api/assets - list all active assets
router.get('/', async (req, res) => {
  try {
    const {
      type,
      status,
      condition,
      employeeId,
      search,
      page = 1,
      limit = 100,
    } = req.query;

    const filter = { isActive: true };
    if (type)       filter.type      = type;
    if (status)     filter.status    = status;
    if (condition)  filter.condition = condition;
    if (employeeId) filter.employeeId = employeeId.toUpperCase();

    if (search && search.trim()) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        { assetName: rx },
        { assetId:   rx },
        { serialNo:  rx },
        { employeeId: rx },
        { employeeName: rx },
      ];
    }

    const pageNum  = Math.max(parseInt(page, 10)  || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const skip     = (pageNum - 1) * limitNum;

    const [items, total] = await Promise.all([
      Asset.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Asset.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      data: items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum) || 1,
      },
    });
  } catch (err) {
    console.error('[ASSET] List error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/assets/stats - counters by type / status
router.get('/stats', async (req, res) => {
  try {
    const filter = { isActive: true };
    const [total, assigned, available, repair, lost, byTypeRaw, byConditionRaw, byEmpRaw] = await Promise.all([
      Asset.countDocuments(filter),
      Asset.countDocuments({ ...filter, status: 'Assigned' }),
      Asset.countDocuments({ ...filter, status: 'Available' }),
      Asset.countDocuments({ ...filter, status: 'Under Repair' }),
      Asset.countDocuments({ ...filter, status: 'Lost' }),
      Asset.aggregate([
        { $match: filter },
        { $group: { _id: '$type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Asset.aggregate([
        { $match: filter },
        { $group: { _id: '$condition', count: { $sum: 1 } } },
      ]),
      Asset.aggregate([
        { $match: { ...filter, employeeId: { $ne: '' } } },
        { $group: { _id: '$employeeId' } },
        { $count: 'employees' },
      ]),
    ]);

    res.status(200).json({
      success: true,
      stats: {
        total,
        assigned,
        available,
        underRepair: repair,
        lost,
        employeesWithAssets: byEmpRaw[0]?.employees || 0,
        byType:      byTypeRaw.map((t)      => ({ type:      t._id || 'Other',   count: t.count })),
        byCondition: byConditionRaw.map((c) => ({ condition: c._id || 'Unknown', count: c.count })),
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[ASSET] Stats error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/assets/employee/:employeeId - all assets assigned to one employee
router.get('/employee/:employeeId', async (req, res) => {
  try {
    const empId = (req.params.employeeId || '').toUpperCase();
    const items = await Asset
      .find({ isActive: true, employeeId: empId })
      .sort({ createdAt: -1 })
      .lean();
    res.status(200).json({ success: true, employeeId: empId, count: items.length, data: items });
  } catch (err) {
    console.error('[ASSET] By-employee error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /api/assets/:id - by Mongo _id or by assetId
router.get('/:id', async (req, res) => {
  try {
    const asset = await findAssetByAnyId(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });
    res.status(200).json({ success: true, data: asset });
  } catch (err) {
    console.error('[ASSET] Get error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/assets - create
router.post('/', async (req, res) => {
  try {
    const {
      assetId,
      assetName,
      type,
      employeeId,
      employeeName,
      serialNo,
      issuedDate,
      condition,
      status,
      purchaseDate,
      purchasePrice,
      vendor,
      warrantyExpiry,
      notes,
    } = req.body;

    if (!assetName || !assetName.toString().trim()) {
      return res.status(400).json({ success: false, message: 'Asset name is required' });
    }
    if (!serialNo || !serialNo.toString().trim()) {
      return res.status(400).json({ success: false, message: 'Serial / Asset number is required' });
    }

    // Reject duplicate active serial numbers up-front for a nicer error
    const dup = await Asset.findOne({ serialNo: serialNo.toString().trim(), isActive: true });
    if (dup) {
      return res.status(400).json({
        success: false,
        message: `An asset with serial "${serialNo}" already exists (${dup.assetId})`,
      });
    }

    const asset = await Asset.create({
      ...(assetId ? { assetId: assetId.toString().trim().toUpperCase() } : {}),
      assetName: assetName.toString().trim(),
      type:      type || 'Laptop',
      employeeId: (employeeId || '').toString().trim().toUpperCase(),
      employeeName: (employeeName || '').toString().trim(),
      serialNo: serialNo.toString().trim(),
      issuedDate: issuedDate || Date.now(),
      condition: condition || 'Good',
      status:    status    || (employeeId ? 'Assigned' : 'Available'),
      purchaseDate:  purchaseDate  || null,
      purchasePrice: purchasePrice || 0,
      vendor:        vendor        || '',
      warrantyExpiry: warrantyExpiry || null,
      notes: notes || '',
    });

    res.status(201).json({
      success: true,
      data: asset,
      message: `Asset "${asset.assetName}" (${asset.assetId}) created successfully`,
    });
  } catch (err) {
    console.error('[ASSET] Create error:', err);
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'Duplicate value', detail: err.keyValue });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// PUT /api/assets/:id - update
router.put('/:id', async (req, res) => {
  try {
    const asset = await findAssetByAnyId(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });

    const allowed = [
      'assetName', 'type', 'employeeId', 'employeeName',
      'serialNo', 'issuedDate', 'returnedDate', 'condition', 'status',
      'purchaseDate', 'purchasePrice', 'vendor', 'warrantyExpiry', 'notes',
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) asset[key] = req.body[key];
    }
    if (typeof asset.employeeId === 'string') asset.employeeId = asset.employeeId.trim().toUpperCase();
    if (typeof asset.assetName  === 'string') asset.assetName  = asset.assetName.trim();
    if (typeof asset.serialNo   === 'string') asset.serialNo   = asset.serialNo.trim();

    // #348 — Wrap the save so we can detect the legacy-index E11000
    // that fires when a soft-deleted asset has the same serialNo as
    // the row being edited. If it happens, drop the legacy index and
    // retry ONCE. Any duplicate against an ACTIVE row keeps returning
    // a friendly 400 as before.
    try {
      await asset.save();
    } catch (dupErr) {
      if (dupErr && dupErr.code === 11000 && /serialNo/i.test(String(dupErr.message))) {
        // Is there ANOTHER active asset with the same serial?
        const clash = await Asset.findOne({
          _id: { $ne: asset._id },
          serialNo: asset.serialNo,
          isActive: true,
        }).select('assetId');
        if (clash) {
          return res.status(400).json({
            success: false,
            message: `Serial "${asset.serialNo}" is already used by another active asset (${clash.assetId}).`,
          });
        }
        // No active clash — the legacy full-unique serialNo_1 index is
        // matching a soft-deleted row. Drop it and retry the save.
        console.warn('[ASSET] E11000 on serialNo but no active clash — dropping legacy index and retrying');
        try {
          if (typeof Asset.dropLegacySerialNoIndex === 'function') {
            await Asset.dropLegacySerialNoIndex();
          }
          await asset.save();
        } catch (retryErr) {
          console.error('[ASSET] Retry after legacy-index drop still failed:', retryErr.message);
          return res.status(500).json({
            success: false,
            message: 'Could not save changes. Please refresh and try again.',
          });
        }
      } else {
        throw dupErr;  // Bubble to outer catch for validation / other errors.
      }
    }
    res.status(200).json({ success: true, data: asset, message: 'Asset updated successfully' });
  } catch (err) {
    console.error('[ASSET] Update error:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    // #348 — Final safety net for any duplicate that slips through.
    if (err.code === 11000) {
      return res.status(400).json({
        success: false,
        message: `Duplicate value on ${Object.keys(err.keyValue || {}).join(', ') || 'a unique field'}. Please refresh and try again.`,
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/assets/:id/assign - assign to an employee
router.patch('/:id/assign', async (req, res) => {
  try {
    const { employeeId, employeeName, issuedDate } = req.body;
    if (!employeeId) {
      return res.status(400).json({ success: false, message: 'employeeId is required to assign' });
    }
    const asset = await findAssetByAnyId(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });

    asset.employeeId   = employeeId.toString().trim().toUpperCase();
    asset.employeeName = (employeeName || '').toString().trim();
    asset.issuedDate   = issuedDate || new Date();
    asset.returnedDate = null;
    asset.status       = 'Assigned';
    await asset.save();

    res.status(200).json({ success: true, data: asset, message: `Assigned to ${asset.employeeId}` });
  } catch (err) {
    console.error('[ASSET] Assign error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/assets/:id/return - return an asset (mark Available)
router.patch('/:id/return',  async (req, res) => {
  try {
    const asset = await findAssetByAnyId(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });

    asset.employeeId   = '';
    asset.employeeName = '';
    asset.returnedDate = new Date();
    asset.status       = 'Available';
    if (req.body.condition) asset.condition = req.body.condition;
    await asset.save();

    res.status(200).json({ success: true, data: asset, message: 'Asset returned' });
  } catch (err) {
    console.error('[ASSET] Return error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/assets/:id/status - quick status change
router.patch('/:id/status', async (req, res) => {
  try {
    const allowed = ['Assigned', 'Available', 'Under Repair', 'Retired', 'Lost'];
    const { status } = req.body;
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    const asset = await findAssetByAnyId(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });

    asset.status = status;
    await asset.save();
    res.status(200).json({ success: true, data: asset, message: `Status set to ${status}` });
  } catch (err) {
    console.error('[ASSET] Status error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// DELETE /api/assets/:id - soft delete
router.delete('/:id', async (req, res) => {
  try {
    const asset = await findAssetByAnyId(req.params.id);
    if (!asset) return res.status(404).json({ success: false, message: 'Asset not found' });

    asset.isActive = false;
    await asset.save();
    res.status(200).json({
      success: true,
      message: `Asset "${asset.assetName}" (${asset.assetId}) deleted successfully`,
    });
  } catch (err) {
    console.error('[ASSET] Delete error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
