// models/Asset.js - Company asset schema for HRM
const mongoose = require('mongoose');

const assetSchema = new mongoose.Schema(
  {
    // Human-readable id like AST-001 - auto-generated on create if not supplied
    assetId: {
      type: String,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    },
    assetName: {
      type: String,
      required: [true, 'Asset name is required'],
      trim: true,
      minlength: 2,
      maxlength: 200,
    },
    type: {
      type: String,
      required: [true, 'Asset type is required'],
      // 'SIM Card' added (#348) — the Add Asset UI has TWO distinct
      // options: "Mobile with SIM" (a phone that ships with an
      // embedded SIM) and "SIM Card" (a standalone SIM issued to
      // employees). The enum was missing the second value which made
      // save fail with "SIM Card is not a valid enum value for path
      // 'type'". Keep both so old rows still validate.
      enum: ['Laptop', 'Monitor', 'Mouse', 'Keyboard', 'ID Card', 'PC', 'Mobile with SIM', 'SIM Card', 'Other'],
      default: 'Laptop',
    },
    // Reference to the employee this asset is assigned to.
    // Stored as string (e.g. EMP-1001) to match the frontend's existing data shape.
    employeeId: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
      index: true,
    },
    employeeName: { type: String, default: '', trim: true },

    serialNo: {
      type: String,
      required: [true, 'Serial / Asset number is required'],
      trim: true,
      maxlength: 100,
    },
    issuedDate: { type: Date, default: Date.now },
    returnedDate: { type: Date, default: null },

    condition: {
      type: String,
      enum: ['New', 'Good', 'Fair', 'Poor'],
      default: 'Good',
    },
    status: {
      type: String,
      enum: ['Assigned', 'Available', 'Under Repair', 'Retired', 'Lost'],
      default: 'Assigned',
    },

    // Optional commercial details
    purchaseDate:  { type: Date,   default: null },
    purchasePrice: { type: Number, default: 0, min: 0 },
    vendor:        { type: String, trim: true, default: '' },
    warrantyExpiry:{ type: Date,   default: null },

    notes: { type: String, trim: true, default: '', maxlength: 2000 },

    // Soft delete flag (consistent with other models in the project)
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Indexes for common queries
assetSchema.index({ isActive: 1, status: 1 });
assetSchema.index({ type: 1 });
assetSchema.index({ serialNo: 1 }, { unique: true, partialFilterExpression: { isActive: true } });

// ─── Legacy index cleanup ─────────────────────────────────────────────
// Earlier deployments created a `serialNo_1` index that was FULL-UNIQUE
// (not partial). After we switched to partial-unique above, the old
// index sticks around in Mongo and throws E11000 the moment HR tries to
// re-issue a serial that was used by a soft-deleted asset — OR when
// editing an active asset whose serialNo happens to match a soft-deleted
// row (because the legacy index counts inactive rows too).
//
// #348 — Hardened cleanup: instead of running once and giving up, we
//        expose a helper that route handlers can call before writes
//        that hit the unique constraint. Callers still don't block on
//        it (fire-and-forget), but it means the drop is retried after
//        every server restart AND on-demand from the route layer.
async function dropLegacySerialNoIndex() {
  try {
    if (mongoose.connection.readyState !== 1) return;   // not open yet
    const coll = mongoose.connection.collection('assets');
    const indexes = await coll.indexes();
    for (const idx of indexes) {
      // The legacy full-unique index is `serialNo_1` with NO
      // partialFilterExpression. The new one has the filter; keep it.
      if (idx.name === 'serialNo_1' && !idx.partialFilterExpression) {
        await coll.dropIndex('serialNo_1');
        console.log('[Asset] dropped legacy full-unique serialNo_1 index');
      }
    }
  } catch (e) {
    console.warn('[Asset] index cleanup:', e.message);
  }
}

// Run when the connection is open, and also if it happens to already
// be open by the time this module was required (nodemon hot reload).
mongoose.connection.once('open', () => setTimeout(dropLegacySerialNoIndex, 2000));
if (mongoose.connection.readyState === 1) {
  setTimeout(dropLegacySerialNoIndex, 500);
}

// Auto-generate assetId like AST-001 if not supplied.
//
// IMPORTANT — modern Mongoose v6+ does NOT pass a `next` callback to
// async pre-hooks. Mixing `async function (next)` with calls to `next()`
// produces a "next is not a function" runtime error the moment any save
// triggers validation. Use plain async/await and let Mongoose advance
// the chain on promise resolution (throw to abort).
assetSchema.pre('validate', async function () {
  if (this.assetId) return;
  const last = await this.constructor
    .findOne({ assetId: /^AST-/ })
    .sort({ createdAt: -1 })
    .select('assetId')
    .lean();
  let nextNum = 1;
  if (last && last.assetId) {
    const m = last.assetId.match(/AST-(\d+)/);
    if (m) nextNum = parseInt(m[1], 10) + 1;
  }
  this.assetId = `AST-${String(nextNum).padStart(3, '0')}`;
});

const Asset = mongoose.model('Asset', assetSchema);

// #348 — Expose the cleanup helper on the compiled model so
// assetRoutes.js can trigger it on demand after an E11000. Must be
// attached AFTER mongoose.model() so it isn't overwritten by the
// module.exports assignment below.
Asset.dropLegacySerialNoIndex = dropLegacySerialNoIndex;

module.exports = Asset;
