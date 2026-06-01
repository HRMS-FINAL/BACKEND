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
      enum: ['Laptop', 'Monitor', 'Mouse', 'Keyboard', 'ID Card', 'PC', 'Mobile with SIM', 'Other'],
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
// re-issue a serial that was used by a soft-deleted asset. This hook
// drops the legacy index ONCE on startup, leaving only the new partial
// one in place. Idempotent — `dropIndex` throws if it's already gone,
// we swallow that case.
async function dropLegacySerialNoIndex() {
  try {
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
  } catch (e) { console.warn('[Asset] index cleanup:', e.message); }
}
// Run when the connection is open. Wrap in setTimeout so it doesn't
// race with the rest of model registration.
mongoose.connection.once('open', () => setTimeout(dropLegacySerialNoIndex, 2000));

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

module.exports = mongoose.model('Asset', assetSchema);
