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

// Auto-generate assetId like AST-001 if not supplied
assetSchema.pre('validate', async function (next) {
  if (this.assetId) return next();
  try {
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
    next();
  } catch (err) {
    next(err);
  }
});

module.exports = mongoose.model('Asset', assetSchema);
