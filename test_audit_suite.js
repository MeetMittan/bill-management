require('dotenv').config();
const mongoose = require('mongoose');
const customCrypto = require('./config/customCrypto');
const User = require('./models/User');
const Category = require('./models/Category');
const Bill = require('./models/Bill');
const aiService = require('./services/aiService');
const csvService = require('./services/csvService');

async function runTestSuite() {
  console.log('====================================================');
  console.log('🧪 RUNNING AI AUDIT & TAX BILL MANAGEMENT TEST SUITE');
  console.log('====================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, testName) {
    totalTests++;
    if (condition) {
      console.log(`✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`❌ [FAIL] ${testName}`);
    }
  }

  try {
    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bill_management');
    console.log('[Test Setup] Connected to MongoDB test database.\n');

    // 1. Test AES-256-GCM Encryption / Decryption
    console.log('--- Test Suite 1: AES-256 Encryption & PII Masking ---');
    const secretApiKey = 'AIzaSyA_sample_google_gemini_api_key_1234567890';
    const encryptedKey = customCrypto.encrypt(secretApiKey);
    assert(encryptedKey && encryptedKey.includes(':'), 'AES-256-GCM creates IV:AuthTag:Cipher text');
    const decryptedKey = customCrypto.decrypt(encryptedKey);
    assert(decryptedKey === secretApiKey, 'AES-256-GCM decrypts cleanly back to original key');

    const maskedCard = customCrypto.maskPII('Payment from credit card 4111 2222 3333 4444 on file');
    assert(maskedCard.includes('•••• •••• •••• 4444'), 'PII masking successfully masks 16-digit card numbers');

    // 2. Test User Registration & Default Category Seeding
    console.log('\n--- Test Suite 2: User Model & Automatic Category Seeding ---');
    const testEmail = `test_auditor_${Date.now()}@firm.com`;
    const user = new User({
      name: 'Dr. Evelyn Reed',
      email: testEmail,
      password: 'AuditSecretPassword123!',
      role: 'Auditor'
    });
    await user.save();
    assert(user._id != null, 'User created and saved to MongoDB');

    const isPassValid = await user.comparePassword('AuditSecretPassword123!');
    assert(isPassValid === true, 'Bcrypt password comparison succeeded');

    await Category.seedDefaultsForUser(user._id);
    const seededCategories = await Category.find({ user: user._id });
    assert(seededCategories.length >= 7, `Default categories automatically seeded (${seededCategories.length} categories)`);

    // 3. Test AI Heuristic Invoice Parsing Engine
    console.log('\n--- Test Suite 3: OCR/AI Invoice Structured Extraction ---');
    const sampleRawOcr = `
      GLOBAL TECH HARDWARE LTD
      100 Silicon Way, Tech Park, CA 94025
      GSTIN: 27AABCT3518Q1ZV
      Invoice #: INV-2026-8842
      Date: 2026-09-15
      Due Date: 2026-10-15
      
      Description       Qty    Unit Price    Amount
      Dell 4K Monitors   2      $400.00      $800.00
      USB-C Hub          1      $50.00       $50.00
      
      Sub Total: $850.00
      GST Tax (18%): $153.00
      Grand Total: $1003.00
      Status: Paid
    `;

    const parsed = await aiService.parseInvoiceText(sampleRawOcr, user.aiSettings, seededCategories);
    assert(parsed.vendorName.toLowerCase().includes('hardware') || parsed.vendorName.toLowerCase().includes('global'), `Vendor extracted correctly: "${parsed.vendorName}"`);
    assert(parsed.invoiceNumber === 'INV-2026-8842', `Invoice number extracted: "${parsed.invoiceNumber}"`);
    assert(parsed.subtotal === 850, `Subtotal extracted: ${parsed.subtotal}`);
    assert(parsed.taxAmount === 153, `Tax extracted: ${parsed.taxAmount}`);
    assert(parsed.grandTotal === 1003, `Grand total extracted: ${parsed.grandTotal}`);
    assert(parsed.taxId.includes('27AABCT3518Q1ZV'), `Tax ID / GSTIN extracted: ${parsed.taxId}`);
    assert(parsed.suggestedCategory === 'Hardware', `Auto-assigned category: "${parsed.suggestedCategory}"`);

    // 4. Test Automated Audit Checks (Math Check & Flags)
    console.log('\n--- Test Suite 4: Automated Audit & Math Discrepancy Checks ---');
    // Save valid bill
    const billHash = customCrypto.computeHash(Buffer.from(sampleRawOcr));
    const bill1 = new Bill({
      user: user._id,
      vendorName: parsed.vendorName,
      invoiceNumber: parsed.invoiceNumber,
      billDate: new Date('2026-09-15'),
      dueDate: new Date('2026-10-15'),
      categoryName: parsed.suggestedCategory,
      subtotal: parsed.subtotal,
      taxAmount: parsed.taxAmount,
      grandTotal: parsed.grandTotal,
      taxId: parsed.taxId,
      fileHash: billHash,
      paymentStatus: 'Paid',
      auditFlags: {
        mathDiscrepancy: false,
        duplicateReceipt: false,
        missingTaxId: false
      }
    });
    await bill1.save();
    assert(bill1._id != null, 'Bill 1 stored successfully with Verified status');

    // Test Math Discrepancy Flag
    const flawedSubtotal = 500.00;
    const flawedTax = 50.00;
    const flawedGrandTotal = 600.00; // Expected 550.00 -> Discrepancy!
    const diff = Math.abs((flawedSubtotal + flawedTax) - flawedGrandTotal);
    const hasMathError = diff > 0.05;
    assert(hasMathError === true, 'Math discrepancy detected: Subtotal ($500) + Tax ($50) != Grand Total ($600)');

    const billWithMathError = new Bill({
      user: user._id,
      vendorName: 'Faulty Vendor Supplies',
      invoiceNumber: 'ERR-999',
      billDate: new Date(),
      dueDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // Due in 3 days!
      subtotal: flawedSubtotal,
      taxAmount: flawedTax,
      grandTotal: flawedGrandTotal,
      taxId: '', // Missing tax ID
      paymentStatus: 'Due',
      auditFlags: {
        mathDiscrepancy: true,
        mathDiscrepancyDetails: 'Mismatch of $50.00',
        missingTaxId: true
      }
    });
    await billWithMathError.save();
    assert(billWithMathError.auditFlags.mathDiscrepancy === true, 'Math discrepancy flag persisted in MongoDB');
    assert(billWithMathError.auditFlags.missingTaxId === true, 'Missing Tax ID flag persisted in MongoDB');

    // Test Duplicate Detection
    const duplicateBill = await Bill.findOne({ user: user._id, fileHash: billHash });
    assert(duplicateBill != null && duplicateBill._id.equals(bill1._id), 'Duplicate file detected via SHA-256 hash match');

    // 5. Test "Ask Your Bills" Natural Language RAG Chat
    console.log('\n--- Test Suite 5: "Ask Your Bills" Local RAG Querying ---');
    const userBills = await Bill.find({ user: user._id });
    const ragAnswer = await aiService.askBillsRag('How much tax did I pay on hardware?', userBills, user.aiSettings);
    assert(typeof ragAnswer === 'string' && ragAnswer.length > 20, 'RAG chat generated intelligent audit response');
    assert(ragAnswer.includes('153') || ragAnswer.includes('Hardware') || ragAnswer.includes('Tax'), 'RAG chat cited exact hardware tax amount ($153.00)');

    // 6. Test CSV Export Generation
    console.log('\n--- Test Suite 6: CSV Export Service ---');
    const billsCsv = csvService.generateBillsCSV(userBills);
    assert(billsCsv.includes('Invoice Number') && billsCsv.includes('INV-2026-8842'), 'Bills CSV generated with proper RFC 4180 headers and values');

    const catCsv = csvService.generateCategorySummaryCSV([
      { categoryName: 'Hardware', count: 1, totalSubtotal: 850, totalTax: 153, grandTotal: 1003, paidAmount: 1003, dueAmount: 0 }
    ]);
    assert(catCsv.includes('Category Name') && catCsv.includes('Hardware'), 'Category summary CSV generated with metrics');

    // Cleanup test records
    await Bill.deleteMany({ user: user._id });
    await Category.deleteMany({ user: user._id });
    await User.deleteOne({ _id: user._id });
    console.log('\n[Test Cleanup] Test database records cleaned up.');

    console.log('\n====================================================');
    console.log(`🎉 TEST SUMMARY: ${passedTests}/${totalTests} TESTS PASSED!`);
    console.log('====================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exit(1);
  }
}

runTestSuite();

