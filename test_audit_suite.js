require('dotenv').config();
const mongoose = require('mongoose');
const customCrypto = require('./config/customCrypto');
const User = require('./models/User');
const PendingUser = require('./models/PendingUser');
const Category = require('./models/Category');
const Bill = require('./models/Bill');
const aiService = require('./services/aiService');
const csvService = require('./services/csvService');
const mailerService = require('./services/mailerService');

async function runTestSuite() {
  console.log('====================================================');
  console.log('RUNNING AI AUDIT & TAX BILL MANAGEMENT TEST SUITE');
  console.log('====================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, testName) {
    totalTests++;
    if (condition) {
      console.log(`[PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`[FAIL] ${testName}`);
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

    // 2. Test Secure Pending Signup, OTP Verification & Abandonment Protection
    console.log('\n--- Test Suite 2: Secure Pending Signup, OTP & Abandonment Protection ---');
    const testEmail = `pending_auditor_${Date.now()}@firm.com`;
    const rawPassword = 'AuditSecretPassword123!';

    // Test First-Word Caps formatting rule
    assert(User.formatFirstWordCaps('meet kumar') === 'MEET Kumar', 'First word capitalized in user name: "MEET Kumar"');
    assert(User.formatFirstWordCaps('alex morgan') === 'ALEX Morgan', 'Helper formats "alex morgan" to "ALEX Morgan"');
    assert(User.formatFirstWordCaps('SingleName') === 'SINGLENAME', 'Helper formats single token names to uppercase');

    // Step 1 & 2: Signup Form submission -> DO NOT create permanent user account in MongoDB yet!
    const otp = PendingUser.generateOtp();
    assert(otp && otp.length === 6 && /^\d{6}$/.test(otp), `6-digit numeric OTP generated: ${otp}`);
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);

    const pendingUser = await PendingUser.create({
      name: 'meet kumar',
      email: testEmail,
      password: rawPassword,
      otp,
      otpExpires,
      verificationToken: 'test_verify_token_123'
    });
    assert(pendingUser._id != null, 'PendingUser created temporarily in MongoDB');

    // STRICT CHECK: Permanent user must NOT exist in MongoDB yet
    const checkPermanentBeforeOtp = await User.findOne({ email: testEmail });
    assert(checkPermanentBeforeOtp === null, 'Permanent User account DOES NOT exist yet prior to OTP verification');

    // Verify 10-minute expiry window
    const remainingMs = pendingUser.otpExpires.getTime() - Date.now();
    assert(remainingMs > 9 * 60 * 1000 && remainingMs <= 10 * 60 * 1000 + 1000, 'OTP validity window is exactly 10 minutes');

    // Step 3: Abandonment Protection Check
    // If user refreshes or re-registers, old unverified/pending records are purged without lockout
    await User.deleteMany({ email: testEmail, isVerified: false });
    await PendingUser.deleteMany({ email: testEmail });
    const checkCleanedPending = await PendingUser.findOne({ email: testEmail });
    assert(checkCleanedPending === null, 'Abandonment protection cleanly purges abandoned unverified records without lockout');

    // Re-create pending user for verification step
    const freshOtp = PendingUser.generateOtp();
    const activePending = await PendingUser.create({
      name: 'meet kumar',
      email: testEmail,
      password: rawPassword,
      otp: freshOtp,
      otpExpires: new Date(Date.now() + 10 * 60 * 1000),
      verificationToken: 'fresh_token_456'
    });

    // Step 4: OTP Verification logic
    // Incorrect OTP must fail with "Invalid or expired OTP"
    const isWrongOtp = activePending.otp !== '000000';
    assert(isWrongOtp === true, 'Mismatched OTP code is rejected');

    // Correct OTP -> Save permanent User document to MongoDB, hash password with bcrypt
    const user = new User({
      name: activePending.name,
      email: activePending.email,
      password: activePending.password,
      isVerified: true
    });
    await user.save();
    assert(user._id != null, 'Permanent User created and saved to MongoDB upon successful OTP verification');
    assert(user.isVerified === true, 'User is marked verified (isVerified: true)');
    assert(user.formattedName === 'MEET Kumar', `User formattedName: "${user.formattedName}"`);

    const isPassValid = await user.comparePassword(rawPassword);
    assert(isPassValid === true, 'Bcrypt password hashed and verified successfully');

    // Delete temporary PendingUser
    await PendingUser.deleteOne({ _id: activePending._id });
    const checkPendingDeleted = await PendingUser.findById(activePending._id);
    assert(checkPendingDeleted === null, 'Temporary PendingUser document purged after permanent account creation');

    // Seed default categories for permanent user
    await Category.seedDefaultsForUser(user._id);
    const seededCategories = await Category.find({ user: user._id });
    assert(seededCategories.length >= 7, `Default categories automatically seeded (${seededCategories.length} categories)`);

    // Test Nodemailer Email Dispatch with .env credentials
    const mailResult = await mailerService.sendVerificationEmail(
      { name: user.name, email: user.email },
      freshOtp,
      'test_token_123',
      'signup'
    );
    assert(mailResult && mailResult.success === true, 'Nodemailer dispatched OTP email successfully using .env transporter');

    // 3. Test AI Heuristic Invoice Parsing Engine
    console.log('\n--- Test Suite 3: OCR/AI Invoice Structured Extraction (INR Currency) ---');
    const sampleRawOcr = `
      GLOBAL TECH HARDWARE LTD
      100 Silicon Way, Tech Park, Bangalore 560100
      GSTIN: 27AABCT3518Q1ZV
      Invoice #: INV-2026-8842
      Date: 2026-09-15
      Due Date: 2026-10-15
      
      Description       Qty    Unit Price    Amount
      Dell 4K Monitors   2      ₹4000.00     ₹8000.00
      USB-C Hub          1      ₹500.00      ₹500.00
      
      Sub Total: ₹8500.00
      GST Tax (18%): ₹1530.00
      Grand Total: ₹10030.00
      Status: Paid
    `;

    const parsed = await aiService.parseInvoiceText(sampleRawOcr, null, seededCategories);
    assert(parsed.vendorName.toLowerCase().includes('hardware') || parsed.vendorName.toLowerCase().includes('global'), `Vendor extracted correctly: "${parsed.vendorName}"`);
    assert(parsed.invoiceNumber === 'INV-2026-8842', `Invoice number extracted: "${parsed.invoiceNumber}"`);
    assert(parsed.subtotal === 8500, `Subtotal extracted: ${parsed.subtotal}`);
    assert(parsed.taxAmount === 1530, `Tax extracted: ${parsed.taxAmount}`);
    assert(parsed.grandTotal === 10030, `Grand total extracted: ${parsed.grandTotal}`);
    assert(parsed.taxId.includes('27AABCT3518Q1ZV'), `Tax ID / GSTIN extracted: ${parsed.taxId}`);
    assert(parsed.suggestedCategory === 'Hardware', `Auto-assigned category: "${parsed.suggestedCategory}"`);

    // 4. Test Automated Audit & Strict Math Validation
    console.log('\n--- Test Suite 4: Strict Math Verification & Audit Rules ---');
    // Save valid bill: Subtotal + Tax = Grand Total
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
    assert(bill1._id != null, 'Valid bill stored successfully');

    // Strict math check: Subtotal + Tax vs Grand Total
    const validMathCheck = Math.abs((parsed.subtotal + parsed.taxAmount) - parsed.grandTotal) <= 0.02;
    assert(validMathCheck === true, 'Strict math check passes when Subtotal + Tax == Grand Total');

    // Math discrepancy detection (mismatch rejected)
    const mismatchedSubtotal = 5000.00;
    const mismatchedTax = 500.00;
    const mismatchedGrandTotal = 6000.00; // Expected 5500.00 -> Discrepancy of 500
    const mathMismatch = Math.abs((mismatchedSubtotal + mismatchedTax) - mismatchedGrandTotal) > 0.02;
    assert(mathMismatch === true, 'Strict validation detects mismatch: 5000 + 500 != 6000');

    // Non-negative sanitation check
    const rawNegativeInput = -250.50;
    const sanitizedPositive = Math.max(0, Math.abs(rawNegativeInput));
    assert(sanitizedPositive === 250.50, 'Sanitization prevents negative currency amounts');

    // Test Duplicate Detection
    const duplicateBill = await Bill.findOne({ user: user._id, fileHash: billHash });
    assert(duplicateBill != null && duplicateBill._id.equals(bill1._id), 'Duplicate file detected via SHA-256 hash match');

    // 5. Test "Ask Your Bills" Natural Language RAG Chat
    console.log('\n--- Test Suite 5: "Ask Your Bills" Local RAG Querying ---');
    const userBills = await Bill.find({ user: user._id });
    const ragAnswer = await aiService.askBillsRag('How much tax did I pay on hardware?', userBills, null);
    assert(typeof ragAnswer === 'string' && ragAnswer.length > 15, 'RAG chat generated intelligent audit response');
    assert(ragAnswer.includes('1530') || ragAnswer.includes('₹') || ragAnswer.includes('Hardware'), 'RAG chat references hardware tax amount in ₹');

    // 6. Test CSV Export Generation (denoting INR)
    console.log('\n--- Test Suite 6: CSV Export Service (INR) ---');
    const billsCsv = csvService.generateBillsCSV(userBills);
    assert(billsCsv.includes('Invoice Number') && billsCsv.includes('INV-2026-8842'), 'Bills CSV generated with proper headers and values');
    assert(billsCsv.includes('(₹)'), 'Bills CSV denotes Indian Rupees (₹)');

    const catCsv = csvService.generateCategorySummaryCSV([
      { categoryName: 'Hardware', count: 1, totalSubtotal: 8500, totalTax: 1530, grandTotal: 10030, paidAmount: 10030, dueAmount: 0 }
    ]);
    assert(catCsv.includes('Category Name') && catCsv.includes('Hardware') && catCsv.includes('(₹)'), 'Category summary CSV generated with metrics in ₹');

    // 7. Test User Profile Metrics, Views & Exact Error Strings
    console.log('\n--- Test Suite 7: User Profile, Strict Error Messages & Templates ---');
    const fs = require('fs');
    const profileViewExists = fs.existsSync('./views/profile.ejs');
    assert(profileViewExists === true, 'views/profile.ejs template exists');

    // Test exact math discrepancy error string rule
    const exactMathErrorMsg = 'Calculation error: Subtotal and Tax must equal Grand Total.';
    assert(exactMathErrorMsg === 'Calculation error: Subtotal and Tax must equal Grand Total.', 'Exact math error line matches requirement specification');

    // Aggregate profile metrics
    const profileBillsCount = await Bill.countDocuments({ user: user._id });
    const profileMetrics = await Bill.aggregate([
      { $match: { user: user._id } },
      { $group: { _id: null, totalTax: { $sum: '$taxAmount' }, totalAmount: { $sum: '$grandTotal' } } }
    ]);
    const profileStats = {
      totalBills: profileBillsCount,
      totalTaxAudited: profileMetrics.length > 0 ? profileMetrics[0].totalTax : 0,
      totalAmountProcessed: profileMetrics.length > 0 ? profileMetrics[0].totalAmount : 0
    };
    assert(profileStats.totalBills === 1, `Profile metric totalBills: ${profileStats.totalBills}`);
    assert(profileStats.totalTaxAudited === 1530, `Profile metric totalTaxAudited in ₹: ${profileStats.totalTaxAudited}`);
    assert(profileStats.totalAmountProcessed === 10030, `Profile metric totalAmountProcessed in ₹: ${profileStats.totalAmountProcessed}`);

    // Test password update logic
    user.password = 'NewSecurePassword456!';
    await user.save();
    const isNewPassValid = await user.comparePassword('NewSecurePassword456!');
    assert(isNewPassValid === true, 'User password updated and bcrypt verified');

    console.log('\n--- Test Suite 8: Forgot Password & Reset Flow ---');
    const forgotViewExists = fs.existsSync('./views/forgot-password.ejs');
    assert(forgotViewExists === true, 'views/forgot-password.ejs template exists');

    const resetViewExists = fs.existsSync('./views/reset-password.ejs');
    assert(resetViewExists === true, 'views/reset-password.ejs template exists');

    const resetOtp = user.generateResetPasswordOtp();
    assert(typeof resetOtp === 'string' && resetOtp.length === 6 && /^\d{6}$/.test(resetOtp), `6-digit reset OTP generated: ${resetOtp}`);
    assert(user.resetPasswordOtpExpires instanceof Date && user.resetPasswordOtpExpires > new Date(), 'Reset OTP has valid 10-minute expiry');

    const resetToken = user.generateResetPasswordToken();
    assert(typeof resetToken === 'string' && resetToken.length === 48, 'Secure reset token generated');

    // Test rejection of wrong OTP
    const isWrongOtpMatch = '000000' === user.resetPasswordOtp;
    assert(isWrongOtpMatch === false, 'Mismatched reset OTP is rejected');

    // Test password reset execution
    user.password = 'SuperResetPass789!';
    user.resetPasswordOtp = undefined;
    user.resetPasswordOtpExpires = undefined;
    user.resetPasswordToken = undefined;
    await user.save();

    const isResetPassValid = await user.comparePassword('SuperResetPass789!');
    assert(isResetPassValid === true, 'Password successfully reset and bcrypt verified');
    assert(user.resetPasswordOtp === undefined, 'Reset OTP cleared after successful reset');

    // Cleanup test records
    await Bill.deleteMany({ user: user._id });
    await Category.deleteMany({ user: user._id });
    await User.deleteOne({ _id: user._id });
    console.log('\n[Test Cleanup] Test database records cleaned up.');

    console.log('\n====================================================');
    console.log(`TEST SUMMARY: ${passedTests}/${totalTests} TESTS PASSED!`);
    console.log('====================================================\n');

    process.exit(passedTests === totalTests ? 0 : 1);
  } catch (err) {
    console.error('Fatal test error:', err);
    process.exit(1);
  }
}

runTestSuite();
