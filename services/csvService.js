/**
 * Utility to escape a string for CSV RFC 4180 compliance
 */
function escapeCSV(val) {
  if (val === null || val === undefined) return '""';
  let str = String(val);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    str = `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates CSV string for a list of bills
 */
function generateBillsCSV(bills = []) {
  const headers = [
    'Invoice Number',
    'Vendor Name',
    'Firm / Client',
    'Category',
    'Bill Date',
    'Due Date',
    'Tax Registration (GSTIN/VAT)',
    'Subtotal (₹)',
    'Tax Amount (₹)',
    'Grand Total (₹)',
    'Payment Status',
    'Duplicate Flag',
    'Missing Tax ID',
    'Created At'
  ];

  const rows = bills.map(b => [
    escapeCSV(b.invoiceNumber || 'N/A'),
    escapeCSV(b.vendorName),
    escapeCSV(b.firmName || ''),
    escapeCSV(b.categoryName || 'General'),
    escapeCSV(b.billDate ? new Date(b.billDate).toISOString().split('T')[0] : ''),
    escapeCSV(b.dueDate ? new Date(b.dueDate).toISOString().split('T')[0] : ''),
    escapeCSV(b.taxId || 'N/A'),
    (b.subtotal || 0).toFixed(2),
    (b.taxAmount || 0).toFixed(2),
    (b.grandTotal || 0).toFixed(2),
    escapeCSV(b.paymentStatus),
    b.auditFlags?.duplicateReceipt ? 'YES' : 'NO',
    b.auditFlags?.missingTaxId ? 'YES' : 'NO',
    escapeCSV(b.createdAt ? new Date(b.createdAt).toISOString() : '')
  ]);

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
}

/**
 * Generates Category-wise tax and spend breakdown CSV
 */
function generateCategorySummaryCSV(categoryStats = []) {
  const headers = [
    'Category Name',
    'Total Invoices',
    'Total Subtotal (₹)',
    'Total Tax (₹)',
    'Grand Total Spend (₹)',
    'Paid Amount (₹)',
    'Due Amount (₹)'
  ];

  const rows = categoryStats.map(c => [
    escapeCSV(c.categoryName || 'Uncategorized'),
    c.count || 0,
    (c.totalSubtotal || 0).toFixed(2),
    (c.totalTax || 0).toFixed(2),
    (c.grandTotal || 0).toFixed(2),
    (c.paidAmount || 0).toFixed(2),
    (c.dueAmount || 0).toFixed(2)
  ]);

  return [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
}

module.exports = {
  generateBillsCSV,
  generateCategorySummaryCSV
};
