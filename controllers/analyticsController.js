const Bill = require('../models/Bill');
const Category = require('../models/Category');
const csvService = require('../services/csvService');

/**
 * GET /dashboard
 * Renders main Dashboard with high-level KPI cards and recent bills
 */
async function showDashboard(req, res) {
  try {
    const userId = req.user._id;

    // Aggregate key financial metrics
    const [stats] = await Bill.aggregate([
      { $match: { user: userId } },
      {
        $group: {
          _id: null,
          totalSpend: { $sum: '$grandTotal' },
          totalTaxPaid: { $sum: '$taxAmount' },
          totalSubtotal: { $sum: '$subtotal' },
          totalBills: { $sum: 1 },
          paidSpend: {
            $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, '$grandTotal', 0] }
          },
          dueSpend: {
            $sum: { $cond: [{ $eq: ['$paymentStatus', 'Due'] }, '$grandTotal', 0] }
          },
          paidCount: {
            $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, 1, 0] }
          },
          dueCount: {
            $sum: { $cond: [{ $eq: ['$paymentStatus', 'Due'] }, 1, 0] }
          },
          mathDiscrepancies: {
            $sum: { $cond: ['$auditFlags.mathDiscrepancy', 1, 0] }
          },
          duplicates: {
            $sum: { $cond: ['$auditFlags.duplicateReceipt', 1, 0] }
          },
          missingTaxIds: {
            $sum: { $cond: ['$auditFlags.missingTaxId', 1, 0] }
          },
          needsManualReview: {
            $sum: { $cond: ['$auditFlags.needsManualReview', 1, 0] }
          }
        }
      }
    ]) || [{}];

    const kpis = {
      totalSpend: stats?.totalSpend || 0,
      totalTaxPaid: stats?.totalTaxPaid || 0,
      totalSubtotal: stats?.totalSubtotal || 0,
      totalBills: stats?.totalBills || 0,
      paidSpend: stats?.paidSpend || 0,
      dueSpend: stats?.dueSpend || 0,
      paidCount: stats?.paidCount || 0,
      dueCount: stats?.dueCount || 0,
      mathDiscrepancies: stats?.mathDiscrepancies || 0,
      duplicates: stats?.duplicates || 0,
      missingTaxIds: stats?.missingTaxIds || 0,
      needsManualReview: stats?.needsManualReview || 0
    };

    // Get 6 most recent bills
    const recentBills = await Bill.find({ user: userId })
      .populate('category')
      .sort({ createdAt: -1 })
      .limit(6);

    // Get upcoming bills due soon
    const upcomingDueBills = await Bill.find({
      user: userId,
      paymentStatus: 'Due',
      dueDate: { $exists: true, $ne: null }
    })
      .sort({ dueDate: 1 })
      .limit(5);

    res.render('dashboard', {
      title: 'Tax & Audit Executive Dashboard | Audit Manager',
      kpis,
      recentBills,
      upcomingDueBills
    });
  } catch (error) {
    console.error('Dashboard rendering error:', error);
    res.status(500).render('dashboard', {
      title: 'Dashboard Error',
      kpis: {},
      recentBills: [],
      upcomingDueBills: [],
      error: error.message
    });
  }
}

/**
 * GET /api/analytics/data
 * Returns JSON data for Chart.js charts (Category breakdown, Monthly trend, Tax vs Net)
 */
async function getChartData(req, res) {
  try {
    const userId = req.user._id;

    // 1. Category breakdown
    const categoryStats = await Bill.aggregate([
      { $match: { user: userId } },
      {
        $group: {
          _id: '$categoryName',
          totalSpend: { $sum: '$grandTotal' },
          totalTax: { $sum: '$taxAmount' },
          count: { $sum: 1 }
        }
      },
      { $sort: { totalSpend: -1 } }
    ]);

    // Lookup category colors if available
    const userCategories = await Category.find({ user: userId });
    const colorMap = {};
    userCategories.forEach(c => { colorMap[c.name] = c.color; });

    const categoriesData = {
      labels: categoryStats.map(c => c._id || 'Uncategorized'),
      amounts: categoryStats.map(c => parseFloat(c.totalSpend.toFixed(2))),
      taxes: categoryStats.map(c => parseFloat(c.totalTax.toFixed(2))),
      counts: categoryStats.map(c => c.count),
      colors: categoryStats.map(c => colorMap[c._id] || '#3b82f6')
    };

    // 2. Monthly Trend (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);

    const monthlyStats = await Bill.aggregate([
      {
        $match: {
          user: userId,
          billDate: { $gte: sixMonthsAgo }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$billDate' },
            month: { $month: '$billDate' }
          },
          subtotal: { $sum: '$subtotal' },
          taxAmount: { $sum: '$taxAmount' },
          grandTotal: { $sum: '$grandTotal' }
        }
      },
      {
        $sort: { '_id.year': 1, '_id.month': 1 }
      }
    ]);

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthlyTrend = {
      labels: monthlyStats.map(m => `${monthNames[m._id.month - 1]} ${m._id.year}`),
      subtotals: monthlyStats.map(m => parseFloat(m.subtotal.toFixed(2))),
      taxes: monthlyStats.map(m => parseFloat(m.taxAmount.toFixed(2))),
      totals: monthlyStats.map(m => parseFloat(m.grandTotal.toFixed(2)))
    };

    res.json({
      success: true,
      categoryBreakdown: categoriesData,
      monthlyTrend
    });
  } catch (error) {
    console.error('Error fetching analytics chart data:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * GET /api/analytics/export-csv
 * Exports CSV of bills or category summary
 */
async function exportCSV(req, res) {
  try {
    const { type = 'bills' } = req.query;
    const userId = req.user._id;

    if (type === 'categories') {
      const categorySummary = await Bill.aggregate([
        { $match: { user: userId } },
        {
          $group: {
            _id: '$categoryName',
            count: { $sum: 1 },
            totalSubtotal: { $sum: '$subtotal' },
            totalTax: { $sum: '$taxAmount' },
            grandTotal: { $sum: '$grandTotal' },
            paidAmount: {
              $sum: { $cond: [{ $eq: ['$paymentStatus', 'Paid'] }, '$grandTotal', 0] }
            },
            dueAmount: {
              $sum: { $cond: [{ $eq: ['$paymentStatus', 'Due'] }, '$grandTotal', 0] }
            }
          }
        },
        { $sort: { grandTotal: -1 } }
      ]);

      const formatted = categorySummary.map(c => ({
        categoryName: c._id || 'Uncategorized',
        count: c.count,
        totalSubtotal: c.totalSubtotal,
        totalTax: c.totalTax,
        grandTotal: c.grandTotal,
        paidAmount: c.paidAmount,
        dueAmount: c.dueAmount
      }));

      const csvData = csvService.generateCategorySummaryCSV(formatted);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="tax_audit_category_summary_${Date.now()}.csv"`);
      return res.send(csvData);
    }

    // Default: Export all bills
    const bills = await Bill.find({ user: userId }).sort({ billDate: -1 });
    const csvData = csvService.generateBillsCSV(bills);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="tax_audit_bills_${Date.now()}.csv"`);
    res.send(csvData);
  } catch (error) {
    console.error('Error exporting CSV:', error);
    res.status(500).send(`Export failed: ${error.message}`);
  }
}

module.exports = {
  showDashboard,
  getChartData,
  exportCSV
};

