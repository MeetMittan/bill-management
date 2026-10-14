const mongoose = require('mongoose');

const itemizedCostSchema = new mongoose.Schema({
  description: { type: String, default: '' },
  quantity: { type: Number, default: 1 },
  unitPrice: { type: Number, default: 0 },
  amount: { type: Number, default: 0 }
}, { _id: false });

const auditNoteSchema = new mongoose.Schema({
  author: { type: String, default: 'Auditor' },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const billSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  vendorName: {
    type: String,
    required: [true, 'Vendor name is required'],
    trim: true,
    index: true
  },
  firmName: {
    type: String,
    trim: true,
    default: ''
  },
  invoiceNumber: {
    type: String,
    trim: true,
    default: '',
    index: true
  },
  billDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  dueDate: {
    type: Date,
    index: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    index: true
  },
  categoryName: {
    type: String,
    default: 'General / Miscellaneous'
  },
  itemizedCosts: [itemizedCostSchema],
  subtotal: {
    type: Number,
    default: 0
  },
  taxAmount: {
    type: Number,
    default: 0
  },
  grandTotal: {
    type: Number,
    required: true,
    default: 0
  },
  taxId: {
    type: String,
    trim: true,
    default: '' // GSTIN / VAT ID / EIN / Tax Registration
  },
  vendorAddress: {
    type: String,
    trim: true,
    default: ''
  },
  paymentStatus: {
    type: String,
    enum: ['Paid', 'Due'],
    default: 'Due',
    index: true
  },
  filePath: {
    type: String,
    default: ''
  },
  originalFileName: {
    type: String,
    default: ''
  },
  fileMimeType: {
    type: String,
    default: ''
  },
  fileSize: {
    type: Number,
    default: 0
  },
  fileHash: {
    type: String,
    index: true
  },
  ocrRawText: {
    type: String,
    default: ''
  },
  aiExtractedData: {
    type: mongoose.Schema.Types.Mixed
  },
  auditFlags: {
    mathDiscrepancy: {
      type: Boolean,
      default: false
    },
    mathDiscrepancyDetails: {
      type: String,
      default: ''
    },
    duplicateReceipt: {
      type: Boolean,
      default: false
    },
    duplicateBillId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Bill'
    },
    missingTaxId: {
      type: Boolean,
      default: false
    },
    missingAddress: {
      type: Boolean,
      default: false
    },
    needsManualReview: {
      type: Boolean,
      default: false
    },
    manualReviewReason: {
      type: String,
      default: ''
    }
  },
  notes: [auditNoteSchema],
  piiMasked: {
    type: Boolean,
    default: false
  },
  reminderSent: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt timestamp before saving
billSchema.pre('save', function () {
  this.updatedAt = new Date();
});

module.exports = mongoose.model('Bill', billSchema);
