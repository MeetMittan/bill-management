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
    title: 'Smart Bill Upload & AI Extraction | Audit Manager',
    categories,
    preferredProvider: req.user.aiSettings?.preferredProvider || 'ollama'
  });
}

/**
 * Handles Bill File Upload and Multi-Step AI Processing Pipeline
 * POST /api/bills/upload
 */
async function uploadBill(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded. Please select a valid invoice (PDF, PNG, JPG).'
      });
    }

    const filePath = req.file.path;
    const originalFileName = req.file.originalname;
    const fileMimeType = req.file.mimetype;
    const fileSize = req.file.size;

    // 1. Compute SHA-256 File Hash for Duplicate Receipt Protection
    const fileBuffer = fs.readFileSync(filePath);
    const fileHash = customCrypto.computeHash(fileBuffer);

    // Check for exact duplicate file hash
    const duplicateByHash = await Bill.findOne({ user: req.user._id, fileHash: fileHash });

    // 2. OCR Text Extraction (Tesseract.js for images, PDFParse for PDFs)
    console.log(`[Upload Pipeline] Extracting text from ${originalFileName}...`);
    const ocrResult = await ocrService.extractTextFromFile(filePath, fileMimeType);
    const rawText = ocrResult.rawText || '';

    // 3. Dynamic Category Engine preparation
    const existingCategories = await Category.find({ user: req.user._id });

    // 4. AI Structured JSON Extraction (Ollama / Gemini / Heuristics)
    console.log(`[Upload Pipeline] Parsing text with AI Service...`);
    const extracted = await aiService.parseInvoiceText(rawText, req.user.aiSettings, existingCategories);

    // 5. Dynamic Category Engine Assignment / Creation
    let assignedCategory = null;
    let assignedCategoryName = extracted.suggestedCategory || 'General / Miscellaneous';

    // Find if user already has this category (case-insensitive)
    let matchCat = existingCategories.find(c => 
      c.name.toLowerCase() === assignedCategoryName.toLowerCase()
    );

    if (matchCat) {
      assignedCategory = matchCat._id;
      assignedCategoryName = matchCat.name;
    } else {
      // Automatically create the new category dynamically
      console.log(`[Category Engine] Creating new dynamic category: "${assignedCategoryName}"`);
      const palette = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6', '#f97316'];
      const randomColor = palette[Math.floor(Math.random() * palette.length)];
      
      try {
        const newCat = await Category.create({
          user: req.user._id,
          name: assignedCategoryName,
          color: randomColor,
          description: `Auto-generated category for ${extracted.vendorName} bills.`
        });
        assignedCategory = newCat._id;
        assignedCategoryName = newCat.name;
      } catch (catErr) {
        // Fallback to first existing category
        const fallback = existingCategories[0];
        if (fallback) {
          assignedCategory = fallback._id;
          assignedCategoryName = fallback.name;
        }
      }
    }

    // 6. Automated Audit, Compliance & Math Checks
    const subtotal = parseFloat(extracted.subtotal) || 0;
    const taxAmount = parseFloat(extracted.taxAmount) || 0;
    const grandTotal = parseFloat(extracted.grandTotal) || 0;

    // A. Math Discrepancy Check (Subtotal + Tax == Grand Total)
    const expectedTotal = parseFloat((subtotal + taxAmount).toFixed(2));
    const totalDiff = Math.abs(expectedTotal - grandTotal);
    const hasMathDiscrepancy = totalDiff > 0.05; // 5 cents tolerance for rounding
    let mathDetails = '';

    if (hasMathDiscrepancy) {
      mathDetails = `Calculation mismatch: Subtotal ($${subtotal.toFixed(2)}) + Tax ($${taxAmount.toFixed(2)}) equals $${expectedTotal.toFixed(2)}, which does not match Grand Total ($${grandTotal.toFixed(2)}). Discrepancy of $${Math.abs(grandTotal - expectedTotal).toFixed(2)}.`;
    }

    // B. Duplicate Receipt Protection (Hash or Vendor + Invoice# + Date)
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

    // C. Tax Rule Validation
    const isMissingTaxId = !extracted.taxId || extracted.taxId.trim().length === 0;
    const isMissingAddress = !extracted.vendorAddress || extracted.vendorAddress.trim().length < 5;

    // D. Manual Review Flag
    const needsManualReview = ocrResult.needsManualReview || 
                              hasMathDiscrepancy || 
                              isDuplicate || 
                              !rawText || 
                              extracted.vendorName === 'Unknown Vendor';

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
        mathDiscrepancy: hasMathDiscrepancy,
        mathDiscrepancyDetails: mathDetails,
        duplicateReceipt: isDuplicate,
        duplicateBillId: duplicateBillId,
        missingTaxId: isMissingTaxId,
        missingAddress: isMissingAddress,
        needsManualReview: needsManualReview,
        manualReviewReason: needsManualReview 
          ? (ocrResult.error || (hasMathDiscrepancy ? 'Math discrepancy detected' : (isDuplicate ? 'Duplicate receipt detected' : 'Review suggested')))
          : ''
      },
      notes: [{
        author: 'System Audit',
        text: `Processed via ${extracted.parsingEngineUsed.toUpperCase()} on ${new Date().toLocaleString()}. OCR characters extracted: ${rawText.length}.`
      }]
    });

    await bill.save();

    res.json({
      success: true,
      message: 'Invoice uploaded and analyzed successfully!',
      billId: bill._id,
      bill: {
        id: bill._id,
        vendorName: bill.vendorName,
        invoiceNumber: bill.invoiceNumber,
        category: bill.categoryName,
        grandTotal: bill.grandTotal,
        paymentStatus: bill.paymentStatus,
        auditFlags: bill.auditFlags,
        engine: extracted.parsingEngineUsed
      }
    });
  } catch (error) {
    console.error('[Upload Pipeline] Error:', error);
    res.status(500).json({
      success: false,
      message: `Failed to process bill: ${error.message}`
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

    // Search by vendor name, firm name, invoice number, or tax ID
    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { vendorName: searchRegex },
        { firmName: searchRegex },
        { invoiceNumber: searchRegex },
        { taxId: searchRegex }
      ];
    }

    // Filter by category
    if (category && category !== 'all') {
      query.category = category;
    }

    // Filter by payment status
    if (status && ['Paid', 'Due'].includes(status)) {
      query.paymentStatus = status;
    }

    // Filter by audit flags
    if (auditFilter === 'mathDiscrepancy') {
      query['auditFlags.mathDiscrepancy'] = true;
    } else if (auditFilter === 'duplicate') {
      query['auditFlags.duplicateReceipt'] = true;
    } else if (auditFilter === 'missingTaxId') {
      query['auditFlags.missingTaxId'] = true;
    } else if (auditFilter === 'needsManualReview') {
      query['auditFlags.needsManualReview'] = true;
    }

    // Filter by Date Range
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
      title: 'Audit & Tax Bills Registry | Audit Manager',
      bills,
      categories,
      totalCount,
      totalPages,
      currentPage: pageNum,
      query: req.query
    });
  } catch (error) {
    console.error('Error fetching bills:', error);
    res.status(500).render('bills', {
      title: 'Audit & Tax Bills Registry',
      bills: [],
      categories: [],
      totalCount: 0,
      totalPages: 1,
      currentPage: 1,
      query: {},
      error: error.message
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
        error: 'The requested bill record does not exist or you do not have permission to view it.'
      });
    }

    const categories = await Category.find({ user: req.user._id }).sort({ name: 1 });

    res.render('billDetail', {
      title: `Audit Bill: ${bill.vendorName} (${bill.invoiceNumber || 'No INV#'})`,
      bill,
      categories
    });
  } catch (error) {
    console.error('Error loading bill detail:', error);
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
      return res.status(404).json({ success: false, message: 'Bill not found.' });
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

    if (subtotal !== undefined) bill.subtotal = parseFloat(subtotal) || 0;
    if (taxAmount !== undefined) bill.taxAmount = parseFloat(taxAmount) || 0;
    if (grandTotal !== undefined) bill.grandTotal = parseFloat(grandTotal) || 0;

    // Recalculate Audit Math Discrepancy
    const expectedTotal = parseFloat((bill.subtotal + bill.taxAmount).toFixed(2));
    const totalDiff = Math.abs(expectedTotal - bill.grandTotal);
    const hasMathDiscrepancy = totalDiff > 0.05;

    bill.auditFlags.mathDiscrepancy = hasMathDiscrepancy;
    if (hasMathDiscrepancy) {
      bill.auditFlags.mathDiscrepancyDetails = `Calculation mismatch: Subtotal ($${bill.subtotal.toFixed(2)}) + Tax ($${bill.taxAmount.toFixed(2)}) equals $${expectedTotal.toFixed(2)}, which does not match Grand Total ($${bill.grandTotal.toFixed(2)}).`;
    } else {
      bill.auditFlags.mathDiscrepancyDetails = '';
    }

    // Check tax ID flag
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

    // Add note of modification
    bill.notes.push({
      author: req.user.name || 'Auditor',
      text: `Updated bill values and verified math check on ${new Date().toLocaleString()}.`
    });

    await bill.save();

    res.json({
      success: true,
      message: 'Bill record updated and audit check refreshed successfully!',
      bill
    });
  } catch (error) {
    console.error('Error updating bill:', error);
    res.status(500).json({ success: false, message: error.message });
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
      return res.status(404).json({ success: false, message: 'Bill not found' });
    }

    bill.paymentStatus = bill.paymentStatus === 'Paid' ? 'Due' : 'Paid';
    await bill.save();

    res.json({
      success: true,
      newStatus: bill.paymentStatus,
      message: `Status updated to ${bill.paymentStatus}`
    });
  } catch (error) {
    console.error('Toggle status error:', error);
    res.status(500).json({ success: false, message: error.message });
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
      return res.status(400).json({ success: false, message: 'Note text cannot be empty.' });
    }

    const bill = await Bill.findOne({ _id: req.params.id, user: req.user._id });
    if (!bill) {
      return res.status(404).json({ success: false, message: 'Bill not found' });
    }

    const note = {
      author: req.user.name || 'Auditor',
      text: noteText.trim(),
      createdAt: new Date()
    };

    bill.notes.push(note);
    await bill.save();

    res.json({
      success: true,
      message: 'Audit note added successfully.',
      note
    });
  } catch (error) {
    console.error('Add note error:', error);
    res.status(500).json({ success: false, message: error.message });
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
      return res.status(404).json({ success: false, message: 'Bill not found' });
    }

    bill.piiMasked = !bill.piiMasked;
    await bill.save();

    res.json({
      success: true,
      piiMasked: bill.piiMasked,
      message: `PII Masking ${bill.piiMasked ? 'Enabled' : 'Disabled'}`
    });
  } catch (error) {
    console.error('Toggle PII error:', error);
    res.status(500).json({ success: false, message: error.message });
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
      return res.status(404).json({ success: false, message: 'Bill not found' });
    }

    // Try deleting physical file if it exists
    if (bill.filePath) {
      const fullPath = path.join(__dirname, '..', bill.filePath);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch (unlinkErr) {
          console.warn('Could not delete invoice file:', unlinkErr.message);
        }
      }
    }

    await Bill.deleteOne({ _id: bill._id });

    res.json({
      success: true,
      message: 'Bill record and associated invoice file removed successfully.'
    });
  } catch (error) {
    console.error('Delete bill error:', error);
    res.status(500).json({ success: false, message: error.message });
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

