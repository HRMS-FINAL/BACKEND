/**
 * Settings routes — single-document config the admin section reads/writes.
 *
 *   GET  /api/settings              → full settings doc (auto-creates with
 *                                     defaults on first call)
 *   PUT  /api/settings              → merge top-level keys
 *   PATCH /api/settings/:section    → merge into one section (company,
 *                                     workingHours, leavePolicy, payroll,
 *                                     notifications, branding)
 *   POST /api/settings/reset        → wipe and reinsert defaults
 */
const express  = require('express');
const router   = express.Router();
const Settings = require('../models/Settings');

const ALLOWED_SECTIONS = ['company', 'workingHours', 'leavePolicy', 'payroll', 'notifications', 'branding'];

async function getOrCreate() {
  let doc = await Settings.findOne({ key: 'global' });
  if (!doc) {
    doc = await Settings.create({ key: 'global' });
  }
  return doc;
}

router.get('/', async (req, res) => {
  try {
    const doc = await getOrCreate();
    res.status(200).json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.put('/', async (req, res) => {
  try {
    const update = req.body || {};
    // Only merge known top-level sections — silently ignore anything else
    // so a typo in the client can't poison the doc.
    const patch = {};
    for (const k of ALLOWED_SECTIONS) {
      if (update[k] !== undefined) patch[k] = update[k];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid sections in body.' });
    }
    const doc = await Settings.findOneAndUpdate(
      { key: 'global' },
      { $set: patch },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(200).json({ success: true, data: doc, message: 'Settings updated.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.patch('/:section', async (req, res) => {
  try {
    const { section } = req.params;
    if (!ALLOWED_SECTIONS.includes(section)) {
      return res.status(400).json({ success: false, message: `Unknown section "${section}"` });
    }
    const body = req.body || {};
    const $set = {};
    Object.keys(body).forEach(k => {
      $set[`${section}.${k}`] = body[k];
    });
    if (Object.keys($set).length === 0) {
      return res.status(400).json({ success: false, message: 'Empty body — nothing to update.' });
    }
    const doc = await Settings.findOneAndUpdate(
      { key: 'global' },
      { $set },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(200).json({ success: true, data: doc, message: `${section} updated.` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/reset', async (req, res) => {
  try {
    if (req.body?.confirm !== 'RESET_SETTINGS') {
      return res.status(400).json({
        success: false,
        message: 'Confirmation required: POST body must include {"confirm":"RESET_SETTINGS"}.',
      });
    }
    await Settings.deleteMany({});
    const doc = await Settings.create({ key: 'global' });
    res.status(200).json({ success: true, data: doc, message: 'Settings reset to defaults.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
