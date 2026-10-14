const Bill = require('../models/Bill');
const aiService = require('../services/aiService');

/**
 * GET /chat
 * Renders the "Ask Your Bills" RAG Chat View
 */
async function showChat(req, res) {
  try {
    const billsCount = await Bill.countDocuments({ user: req.user._id });
    const sampleVendors = await Bill.distinct('vendorName', { user: req.user._id });
    const sampleCategories = await Bill.distinct('categoryName', { user: req.user._id });

    res.render('chat', {
      title: 'Ask Your Bills | AI Audit Assistant',
      billsCount,
      sampleVendors: sampleVendors.slice(0, 5),
      sampleCategories: sampleCategories.slice(0, 5),
      preferredProvider: req.user.aiSettings?.preferredProvider || 'ollama'
    });
  } catch (error) {
    console.error('Error rendering chat page:', error);
    res.render('chat', {
      title: 'Ask Your Bills',
      billsCount: 0,
      sampleVendors: [],
      sampleCategories: [],
      preferredProvider: 'ollama'
    });
  }
}

/**
 * POST /api/chat/ask
 * Evaluates user question against user's bills metadata
 */
async function handleChatQuery(req, res) {
  try {
    const { question } = req.body;
    if (!question || !question.trim()) {
      return res.status(400).json({ success: false, message: 'Please provide a valid question.' });
    }

    // Retrieve all user bills for context
    const bills = await Bill.find({ user: req.user._id })
      .select('vendorName firmName invoiceNumber billDate dueDate categoryName subtotal taxAmount grandTotal taxId paymentStatus auditFlags notes')
      .sort({ billDate: -1 })
      .limit(100); // Top 100 bills for comprehensive local context

    if (bills.length === 0) {
      return res.json({
        success: true,
        answer: 'You have not uploaded any bills or invoices yet. Upload your first bill to start analyzing your expenses and taxes!'
      });
    }

    console.log(`[RAG Chat] Processing query: "${question}" with ${bills.length} bills in context...`);
    const answer = await aiService.askBillsRag(question.trim(), bills, req.user.aiSettings);

    res.json({
      success: true,
      answer,
      billsAnalyzedCount: bills.length
    });
  } catch (error) {
    console.error('[RAG Chat] Error processing chat query:', error);
    res.status(500).json({
      success: false,
      message: `Failed to analyze bills: ${error.message}`
    });
  }
}

module.exports = {
  showChat,
  handleChatQuery
};

