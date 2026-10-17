const fs = require('fs');
const path = require('path');
const Bill = require('../models/Bill');
const Category = require('../models/Category');
const ocrService = require('../services/ocrService');
const aiService = require('../services/aiService');
const customCrypto = require('../config/customCrypto');

/**
 * Renders the Bill Upload Form
 */
async function showUpload(req, res) {
  const categories = await Category.find({ user: req.user._id }).sort({ name: 1 });
  res.render('upload', {
    title: 'Upload Invoice',
    categories
  });
}

/**
 * Handles Bill File Upload and Multi-Step AI Processing Pipeline
 * POST /api/bills/upload
 */
async function uploadBill(req, res) {
  let filePath = '';
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please select a valid invoice file (PDF, PNG, JPG).'
      });
    }

    filePath = req.file.path;
    const originalFileName = req.file.originalname;
    const fileMimeType = req.file.mimetype;
    const fileSize = req.file.size;

    // 1. Compute SHA-256 File Hash for Duplicate Receipt Protection
    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = customCrypto.computeHash(fileBuffer);

    // Check for exact duplicate file hash
    const duplicateByHash = await Bill.findOne({ user: req.user._id, fileHash: fileHash });

    // 2. OCR Text Extraction (Tesseract.js for images, PDFParse for PDFs)
    const ocrResult = await ocrService.extractTextFromFile(filePath, fileMimeType);
    const rawText = ocrResult.rawText || '';

    // 3. Dynamic Category Engine preparation
    const existingCategories = await Category.find({ user: req.user._id });

    // 4. AI Structured JSON Extraction
    const extracted = await aiService.parseInvoiceText(rawText, req.user?.aiSettings || {}, existingCategories);

    // 5. Dynamic Category Engine Assignment / Creation
    let assignedCategory = null;
    let assignedCategoryName = extracted.suggestedCategory || 'General / Miscellaneous';

    let matchCat = existingCategories.find(c => 
      c.name.toLowerCase() === assignedCategoryName.toLowerCase()
    );

    if (matchCat) {
      assignedCategory = matchCat._id;
      assignedCategoryName = matchCat.name;
    } else {
      const palette = ['#1e293b', '#334155', '#475569', '#64748b', '#2563eb', '#0d9488'];
      const randomColor = palette[Math.floor(Math.random() * palette.length)];
      
      try {
        const newCat = await Category.create({
          user: req.user._id,
          name: assignedCategoryName,
          color: randomColor,
          description: `Category for ${extracted.vendorName} invoices.`
        });
        assignedCategory = newCat._id;
        assignedCategoryName = newCat.name;
      } catch (catErr) {
        const fallback = existingCategories[0];
        if (fallback) {
          assignedCategory = fallback._id;
          assignedCategoryName = fallback.name;
        }
      }
    }

    // 6. Mathematical Calculations & Strict Validation
    let subtotal = Math.max(0, Math.abs(parseFloat(extracted.subtotal) || 0));
    let taxAmount = Math.max(0, Math.abs(parseFloat(extracted.taxAmount) || 0));
    let grandTotal = Math.max(0, Math.abs(parseFloat(extracted.grandTotal) || 0));

    // Handle default fallback calculation if grandTotal was 0
    if (grandTotal === 0 && subtotal > 0) {
      grandTotal = parseFloat((subtotal + taxAmount).toFixed(2));
    } else if (subtotal === 0 && grandTotal > 0 && taxAmount > 0) {
      subtotal = Math.max(0, parseFloat((grandTotal - taxAmount).toFixed(2)));
    }

    // STRICT MATHEMATICAL VALIDATION RULE:
    // Subtotal + Tax Amount MUST equal the Grand Total.
    const expectedTotal = parseFloat((subtotal + taxAmount).toFixed(2));
    const totalDiff = Math.abs(expectedTotal - grandTotal);

    if (totalDiff > 0.02) {
      // Remove temporary file on disk
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {}

      return res.status(400).json({
        success: false,
        message: 'Calculation error: Subtotal and Tax must equal Grand Total.'
      });
    }

    // Duplicate check
    let isDuplicate = !!duplicateByHash;
    let duplicateBillId = duplicateByHash ? duplicateByHash._id : null;

    if (!isDuplicate && extracted.invoiceNumber && extracted.vendorName) {
      const duplicateByFields = await Bill.findOne({
        user: req.user._id,
        vendorName: new RegExp(`^${extracted.vendorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        invoiceNumber: extracted.invoiceNumber
      });
      if (duplicateByFields) {
        isDuplicate = true;
        duplicateBillId = duplicateByFields._id;
      }
    }

    // Tax Rule Validation
    const isMissingTaxId = !extracted.taxId || extracted.taxId.trim().length === 0;
    const isMissingAddress = !extracted.vendorAddress || extracted.vendorAddress.trim().length < 5;

    // 7. Persist to MongoDB
    const relativeFilePath = `/uploads/${path.basename(filePath)}`;
    const bill = new Bill({
      user: req.user._id,
      vendorName: extracted.vendorName,
      firmName: extracted.firmName,
      invoiceNumber: extracted.invoiceNumber,
      billDate: extracted.billDate ? new Date(extracted.billDate) : new Date(),
      dueDate: extracted.dueDate ? new Date(extracted.dueDate) : undefined,
      category: assignedCategory,
      categoryName: assignedCategoryName,
      itemizedCosts: extracted.itemizedCosts || [],
      subtotal,
      taxAmount,
      grandTotal,
      taxId: extracted.taxId,
      vendorAddress: extracted.vendorAddress,
      paymentStatus: extracted.paymentStatus || 'Due',
      filePath: relativeFilePath,
      originalFileName,
      fileMimeType,
      fileSize,
      fileHash,
      ocrRawText: rawText,
      aiExtractedData: extracted,
      auditFlags: {
        mathDiscrepancy: false,
        mathDiscrepancyDetails: '',
        duplicateReceipt: isDuplicate,
        duplicateBillId: duplicateBillId,
        missingTaxId: isMissingTaxId,
        missingAddress: isMissingAddress,
        needsManualReview: isDuplicate || !rawText || extracted.vendorName === 'Unknown Vendor'
      },
      notes: [{
        author: 'System',
        text: `Invoice verified on ${new Date().toLocaleDateString()}.`
      }]
    });

    await bill.save();

    res.json({
      success: true,
      message: 'Invoice verified and saved successfully.',
      billId: bill._id,
      bill: {
        id: bill._id,
        vendorName: bill.vendorName,
        invoiceNumber: bill.invoiceNumber,
        category: bill.categoryName,
        grandTotal: bill.grandTotal,
        paymentStatus: bill.paymentStatus
      }
    });
  } catch (error) {
    console.error('[Upload Pipeline] Error:', error.message);
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    res.status(500).json({
      success: false,
      message: 'Failed to process invoice. Please check the file format and try again.'
    });
  }
}

/**
 * Filter, Search, Sort & List Bills
 * GET /bills
 */
async function getBills(req, res) {
  try {
    const {
      search,
      category,
      status,
      auditFilter,
      startDate,
      endDate,
      sortBy = 'billDate',
      sortOrder = 'desc',
      page = 1,
      limit = 15
    } = req.query;

    const query = { user: req.user._id };

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { vendorName: searchRegex },
        { firmName: searchRegex },
        { invoiceNumber: searchRegex },
        { taxId: searchRegex }
      ];
    }

    if (category && category !== 'all') {
      query.category = category;
    }

    if (status && ['Paid', 'Due'].includes(status)) {
      query.paymentStatus = status;
    }

    if (auditFilter === 'mathDiscrepancy') {
      query['auditFlags.mathDiscrepancy'] = true;
    } else if (auditFilter === 'duplicate') {
      query['auditFlags.duplicateReceipt'] = true;
    } else if (auditFilter === 'missingTaxId') {
      query['auditFlags.missingTaxId'] = true;
    } else if (auditFilter === 'needsManualReview') {
      query['auditFlags.needsManualReview'] = true;
    }

    if (startDate || endDate) {
      query.billDate = {};
      if (startDate) query.billDate.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.billDate.$lte = end;
      }
    }

    const sortOption = {};
    sortOption[sortBy] = sortOrder === 'asc' ? 1 : -1;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.max(1, parseInt(limit) || 15);
    const skip = (pageNum - 1) * limitNum;

    const [bills, totalCount, categories] = await Promise.all([
      Bill.find(query)
        .populate('category')
        .sort(sortOption)
        .skip(skip)
        .limit(limitNum),
      Bill.countDocuments(query),
      Category.find({ user: req.user._id }).sort({ name: 1 })
    ]);

    const totalPages = Math.ceil(totalCount / limitNum) || 1;

    res.render('bills', {
      title: 'Invoices',
      bills,
      categories,
      totalCount,
      totalPages,
      currentPage: pageNum,
      query: req.query
    });
  } catch (error) {
    console.error('Error fetching bills:', error.message);
    res.status(500).render('bills', {
      title: 'Invoices',
      bills: [],
      categories: [],
      totalCount: 0,
      totalPages: 1,
      currentPage: 1,
      query: {},
      error: 'Unable to load bills at this time.'
    });
  }
}

/**
 * Show Bill Detail & Manual Audit Review UI
 * GET /bills/:id
 */
async function showBillDetail(req, res) {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, user: req.user._id })
      .populate('category')
      .populate('auditFlags.duplicateBillId');

    if (!bill) {
      return res.status(404).render('bills', {
        title: 'Bill Not Found',
        bills: [],
        categories: [],
        totalCount: 0,
        totalPages: 1,
        currentPage: 1,
        query: {},
        error: 'The requested bill record could not be found.'
      });
    }

    const categories = await Category.find({ user: req.user._id }).sort({ name: 1 });

    res.render('billDetail', {
      title: `Invoice: ${bill.vendorName}`,
      bill,
      categories
    });
  } catch (error) {
    console.error('Error loading bill detail:', error.message);
    res.redirect('/bills');
  }
}

/**
 * Update Bill Details (Manual Review / Edits)
 * POST /api/bills/:id
 */
async function updateBill(req, res) {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, user: req.user._id });
    if (!bill) {
      return res.status(404).json({ success: false, message: 'Bill record not found.' });
    }

    const {
      vendorName,
      firmName,
      invoiceNumber,
      billDate,
      dueDate,
      category: categoryId,
      subtotal,
      taxAmount,
      grandTotal,
      taxId,
      vendorAddress,
      paymentStatus,
      clearReviewFlag
    } = req.body;

    // Sanitize non-negative numbers
    const newSubtotal = subtotal !== undefined ? Math.max(0, Math.abs(parseFloat(subtotal) || 0)) : bill.subtotal;
    const newTax = taxAmount !== undefined ? Math.max(0, Math.abs(parseFloat(taxAmount) || 0)) : bill.taxAmount;
    const newGrandTotal = grandTotal !== undefined ? Math.max(0, Math.abs(parseFloat(grandTotal) || 0)) : bill.grandTotal;

    // STRICT MATHEMATICAL VALIDATION:
    // Subtotal + Tax MUST equal Grand Total
    const expectedTotal = parseFloat((newSubtotal + newTax).toFixed(2));
    const totalDiff = Math.abs(expectedTotal - newGrandTotal);

    if (totalDiff > 0.02) {
      return res.status(400).json({
        success: false,
        message: 'Calculation error: Subtotal and Tax must equal Grand Total.'
      });
    }

    if (vendorName) bill.vendorName = vendorName.trim();
    if (firmName !== undefined) bill.firmName = firmName.trim();
    if (invoiceNumber !== undefined) bill.invoiceNumber = invoiceNumber.trim();
    if (billDate) bill.billDate = new Date(billDate);
    if (dueDate) bill.dueDate = new Date(dueDate);
    if (taxId !== undefined) bill.taxId = taxId.trim();
    if (vendorAddress !== undefined) bill.vendorAddress = vendorAddress.trim();
    if (paymentStatus && ['Paid', 'Due'].includes(paymentStatus)) {
      bill.paymentStatus = paymentStatus;
    }

    bill.subtotal = newSubtotal;
    bill.taxAmount = newTax;
    bill.grandTotal = newGrandTotal;

    bill.auditFlags.mathDiscrepancy = false;
    bill.auditFlags.mathDiscrepancyDetails = '';
    bill.auditFlags.missingTaxId = !bill.taxId || bill.taxId.trim().length === 0;

    if (categoryId) {
      const cat = await Category.findOne({ _id: categoryId, user: req.user._id });
      if (cat) {
        bill.category = cat._id;
        bill.categoryName = cat.name;
      }
    }

    if (clearReviewFlag) {
      bill.auditFlags.needsManualReview = false;
      bill.auditFlags.manualReviewReason = '';
    }

    const authorDisplayName = req.user.formattedName || req.user.name;
    bill.notes.push({
      author: authorDisplayName,
      text: `Updated on ${new Date().toLocaleDateString()}.`
    });

    await bill.save();

    res.json({
      success: true,
      message: 'Invoice updated successfully.',
      bill
    });
  } catch (error) {
    console.error('Error updating bill:', error.message);
    res.status(500).json({ success: false, message: 'Failed to update invoice.' });
  }
}

/**
 * Toggle Payment Status between Paid and Due
 * PATCH /api/bills/:id/toggle-status
 */
async function toggleStatus(req, res) {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, user: req.user._id });
    if (!bill) {
      return res.status(404).json({ success: false, message: 'Bill record not found.' });
    }

    bill.paymentStatus = bill.paymentStatus === 'Paid' ? 'Due' : 'Paid';
    await bill.save();

    res.json({
      success: true,
      newStatus: bill.paymentStatus,
      message: `Status marked as ${bill.paymentStatus}.`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not toggle payment status.' });
  }
}

/**
 * Add Internal Audit Note
 * POST /api/bills/:id/notes
 */
async function addAuditNote(req, res) {
  try {
    const { noteText } = req.body;
    if (!noteText || !noteText.trim()) {
      return res.status(400).json({ success: false, message: 'Please enter a note.' });
    }

    const bill = await Bill.findOne({ _id: req.params.id, user: req.user._id });
    if (!bill) {
      return res.status(404).json({ success: false, message: 'Bill record not found.' });
    }

    const authorDisplayName = req.user.formattedName || req.user.name;
    const note = {
      author: authorDisplayName,
      text: noteText.trim(),
      createdAt: new Date()
    };

    bill.notes.push(note);
    await bill.save();

    res.json({
      success: true,
      message: 'Note added.',
      note
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not save note.' });
  }
}

/**
 * Toggle PII Masking on Bill
 * PATCH /api/bills/:id/toggle-pii
 */
async function togglePii(req, res) {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, user: req.user._id });
    if (!bill) {
      return res.status(404).json({ success: false, message: 'Bill not found.' });
    }

    bill.piiMasked = !bill.piiMasked;
    await bill.save();

    res.json({
      success: true,
      piiMasked: bill.piiMasked,
      message: `Sensitive info ${bill.piiMasked ? 'masked' : 'visible'}.`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not update visibility.' });
  }
}

/**
 * Delete Bill Record
 * DELETE /api/bills/:id
 */
async function deleteBill(req, res) {
  try {
    const bill = await Bill.findOne({ _id: req.params.id, user: req.user._id });
    if (!bill) {
      return res.status(404).json({ success: false, message: 'Bill record not found.' });
    }

    if (bill.filePath) {
      const fullPath = path.join(__dirname, '..', bill.filePath);
      if (fs.existsSync(fullPath)) {
        try { fs.unlinkSync(fullPath); } catch (unlinkErr) {}
      }
    }

    await Bill.deleteOne({ _id: bill._id });

    res.json({
      success: true,
      message: 'Invoice deleted successfully.'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Could not delete invoice.' });
  }
}

module.exports = {
  showUpload,
  uploadBill,
  getBills,
  showBillDetail,
  updateBill,
  toggleStatus,
  addAuditNote,
  togglePii,
  deleteBill
};
