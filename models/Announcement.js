// models/Announcement.js - Announcement schema for HRM
const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Announcement title is required'],
      trim: true,
      minlength: 3,
      maxlength: 200,
    },
    description: {
      type: String,
      required: [true, 'Announcement description is required'],
      trim: true,
      minlength: 3,
      maxlength: 5000,
    },
    // ─── Mobile-app mirror field (Jun 2026 — #295) ────────────────────
    // The shared `announcements` collection is read by BOTH HRMS (uses
    // `description`) and ERM Mobile (uses `body`). Before this field
    // existed, Mongoose strict-mode silently dropped the `body` key
    // the announcement route was trying to write — so mobile showed
    // only the title with no content. Declaring `body` here lets the
    // create()/update() calls in routes/announcementRoutes.js actually
    // persist it. Kept as a non-required mirror so old rows still
    // validate; the route always populates it from `description`.
    body: {
      type: String,
      default: '',
      trim: true,
      maxlength: 5000,
    },
    // `postedBy` mirrors `createdByName` and is what the mobile reader
    // shows under each card ("Posted by HR"). Also silently dropped
    // before this field was declared.
    postedBy: {
      type: String,
      default: 'HR',
      trim: true,
      maxlength: 200,
    },
    category: {
      type: String,
      enum: ['General', 'HR', 'Policy', 'Event', 'Holiday', 'Training', 'Benefits', 'Office', 'Other'],
      default: 'General',
    },
    priority: {
      type: String,
      enum: ['Low', 'Medium', 'Normal', 'High', 'Urgent'],
      default: 'Normal',
    },
    status: {
      type: String,
      enum: ['Draft', 'Published', 'Archived'],
      default: 'Published',
    },
    audience: {
      type: String,
      enum: ['All', 'Department', 'Role'],
      default: 'All',
    },
    departments: {
      type: [String],
      default: [],
    },
    roles: {
      type: [String],
      enum: ['admin', 'hr', 'employee'],
      default: [],
    },
    publishDate: { type: Date, default: Date.now },
    expiryDate:  { type: Date, default: null },

    isPinned:    { type: Boolean, default: false },
    // Attachments. Files are stored inline as base64 in `dataBase64` so
    // HRMS doesn't need an external object store; `size` lets the UI
    // show "2.3 MB" without re-measuring. Backend enforces a per-file
    // ~5 MB ceiling at the route layer.
    attachments: {
      type: [
        {
          name:       { type: String, trim: true, default: '' },
          mimeType:   { type: String, trim: true, default: '' },
          size:       { type: Number, default: 0 },
          dataBase64: { type: String, default: '' },
          // Legacy field kept for older rows / external hosting cases.
          url:        { type: String, trim: true, default: '' },
          type:       { type: String, trim: true, default: '' },
        },
      ],
      default: [],
    },

    createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '', trim: true },
    createdByRole: { type: String, default: '', trim: true },

    readBy: {
      type: [
        {
          user:   { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          readAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    views:    { type: Number,  default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

announcementSchema.index({ isActive: 1, status: 1, isPinned: -1, publishDate: -1 });
announcementSchema.index({ category: 1 });
announcementSchema.index({ priority: 1 });
announcementSchema.index({ 'readBy.user': 1 });

announcementSchema.virtual('isExpired').get(function () {
  return this.expiryDate ? new Date(this.expiryDate) < new Date() : false;
});

announcementSchema.set('toJSON',   { virtuals: true });
announcementSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Announcement', announcementSchema);
