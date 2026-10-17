const customCrypto = require('../config/customCrypto');

/**
 * Normalizes text to extract valid JSON even if wrapped in markdown blocks
 */
function extractJsonFromAiResponse(aiText) {
  if (!aiText) return null;

  try {
    return JSON.parse(aiText.trim());
  } catch (initialErr) {
    const markdownRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
    const match = aiText.match(markdownRegex);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1].trim());
      } catch (e) {}
    }

    const firstBrace = aiText.indexOf('{');
    const lastBrace = aiText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = aiText.substring(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch (e) {
        const cleaned = candidate
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']');
        try {
          return JSON.parse(cleaned);
        } catch (innerErr) {}
      }
    }
  }
  return null;
}

/**
 * Rule-based Invoice Heuristic Parser (Fast & accurate local extraction)
 */
function heuristicInvoiceExtractor(rawText, existingCategories = []) {
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  
  // 1. Vendor Name
  let vendorName = 'Unknown Vendor';
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (!line.match(/invoice|bill|tax|receipt|date|total|gstin|phone|email/i) && line.length > 2 && line.length < 50) {
      vendorName = line.replace(/^[#*-]\s*/, '').trim();
      break;
    }
  }

  // 2. Invoice Number
  let invoiceNumber = '';
  const invMatch = rawText.match(/(?:Invoice\s*(?:No\.?|Number|#)|Bill\s*(?:No\.?|#)|INV[-#\s]*):?\s*([A-Za-z0-9\-_/]+)/i);
  if (invMatch && invMatch[1]) {
    invoiceNumber = invMatch[1].trim();
  }

  // 3. Dates
  let billDate = new Date().toISOString().split('T')[0];
  let dueDate = '';
  const dateMatch = rawText.match(/(?:Date|Invoice\s*Date|Bill\s*Date):?\s*([0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4})/i);
  if (dateMatch && dateMatch[1]) {
    const parsed = new Date(dateMatch[1]);
    if (!isNaN(parsed.getTime())) {
      billDate = parsed.toISOString().split('T')[0];
    }
  }

  const dueDateMatch = rawText.match(/(?:Due\s*Date|Payment\s*Due):?\s*([0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4})/i);
  if (dueDateMatch && dueDateMatch[1]) {
    const parsed = new Date(dueDateMatch[1]);
    if (!isNaN(parsed.getTime())) {
      dueDate = parsed.toISOString().split('T')[0];
    }
  }

  // 4. Tax Identification Number (GSTIN / VAT ID)
  let taxId = '';
  const gstinMatch = rawText.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})\b/i);
  if (gstinMatch) {
    taxId = gstinMatch[1].toUpperCase();
  } else {
    const taxMatch = rawText.match(/(?:GSTIN|VAT(?:\s*ID)?|Tax\s*ID|TIN|EIN):?\s*([A-Z0-9\-_]+)/i);
    if (taxMatch && taxMatch[1]) {
      taxId = taxMatch[1].trim();
    }
  }

  // 5. Financial Amounts (Non-negative)
  let grandTotal = 0;
  let subtotal = 0;
  let taxAmount = 0;

  const grandTotalMatch = rawText.match(/(?:Grand\s*Total|Total\s*Amount|Amount\s*Due|Invoice\s*Total)\s*:?\s*[₹$€£]?\s*([0-9,]+\.?[0-9]{0,2})/i);
  if (grandTotalMatch && grandTotalMatch[1]) {
    grandTotal = Math.max(0, parseFloat(grandTotalMatch[1].replace(/,/g, '')) || 0);
  } else {
    const fallbackTotalMatch = rawText.match(/(?:^|[^a-zA-Z])Total\s*:?\s*[₹$€£]?\s*([0-9,]+\.?[0-9]{0,2})/im);
    if (fallbackTotalMatch && fallbackTotalMatch[1]) {
      grandTotal = Math.max(0, parseFloat(fallbackTotalMatch[1].replace(/,/g, '')) || 0);
    }
  }

  const subtotalMatch = rawText.match(/(?:Sub\s*Total|Net\s*Amount|Taxable\s*Amount)\s*:?\s*[₹$€£]?\s*([0-9,]+\.?[0-9]{0,2})/i);
  if (subtotalMatch && subtotalMatch[1]) {
    subtotal = Math.max(0, parseFloat(subtotalMatch[1].replace(/,/g, '')) || 0);
  }

  const taxMatch2 = rawText.match(/(?:Total\s*Tax|Tax\s*Amount|GST(?:\s*Tax)?|VAT|CGST\s*\+\s*SGST)(?:\s*\([^)]*\))?\s*:?\s*[₹$€£]?\s*([0-9,]+\.?[0-9]{0,2})/i);
  if (taxMatch2 && taxMatch2[1]) {
    taxAmount = Math.max(0, parseFloat(taxMatch2[1].replace(/,/g, '')) || 0);
  }

  if (grandTotal > 0 && subtotal === 0 && taxAmount > 0) {
    subtotal = Math.max(0, parseFloat((grandTotal - taxAmount).toFixed(2)));
  } else if (subtotal > 0 && taxAmount > 0 && grandTotal === 0) {
    grandTotal = parseFloat((subtotal + taxAmount).toFixed(2));
  } else if (grandTotal > 0 && subtotal === 0 && taxAmount === 0) {
    subtotal = grandTotal;
  }

  // 6. Payment Status Heuristics
  let paymentStatus = 'Due';
  if (/paid|payment\s*received|status:\s*paid|cleared/i.test(rawText) && !/unpaid|due\s*date/i.test(rawText)) {
    paymentStatus = 'Paid';
  }

  // 7. Category classification
  let suggestedCategory = 'General / Miscellaneous';
  const lowerText = rawText.toLowerCase();

  const categoryKeywords = {
    'Hardware': ['hardware', 'computer', 'laptop', 'monitor', 'keyboard', 'server', 'printer', 'cable', 'ram', 'ssd', 'intel', 'dell', 'lenovo'],
    'Software & Cloud': ['software', 'cloud', 'aws', 'amazon web services', 'azure', 'google cloud', 'github', 'saas', 'subscription', 'domain', 'hosting', 'jira', 'slack', 'license'],
    'Office Supplies': ['stationery', 'paper', 'staples', 'desk', 'chair', 'pen', 'notebook', 'furniture', 'office depot'],
    'Travel & Lodging': ['flight', 'airline', 'hotel', 'uber', 'lyft', 'taxi', 'railway', 'train', 'airbnb', 'boarding pass', 'lodging'],
    'Utilities & Bills': ['electricity', 'water', 'internet', 'broadband', 'telecom', 'phone', 'airtel', 'jio', 'power'],
    'Legal & Professional': ['audit', 'consulting', 'legal', 'attorney', 'retainer', 'accounting', 'advisory'],
    'Meals & Entertainment': ['restaurant', 'cafe', 'food', 'dinner', 'lunch', 'starbucks', 'coffee', 'meal', 'catering']
  };

  for (const [cat, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some(kw => lowerText.includes(kw))) {
      suggestedCategory = cat;
      break;
    }
  }

  return {
    vendorName,
    firmName: '',
    invoiceNumber,
    billDate,
    dueDate: dueDate || billDate,
    itemizedCosts: [
      {
        description: 'Line item charge',
        quantity: 1,
        unitPrice: subtotal || grandTotal,
        amount: subtotal || grandTotal
      }
    ],
    subtotal,
    taxAmount,
    grandTotal,
    taxId,
    vendorAddress: '',
    suggestedCategory,
    paymentStatus
  };
}

const INVOICE_PARSER_SYSTEM_PROMPT = `
You are an expert Tax and Financial Audit assistant. Extract all bill/invoice information from the provided raw OCR text.
Output MUST be a single raw JSON object matching this schema exactly without any extra markdown or conversational text:

{
  "vendorName": "Company or store issuing the bill",
  "firmName": "Buyer/client company name if mentioned",
  "invoiceNumber": "Invoice or Bill identifier",
  "billDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD (estimate or use billDate if not specified)",
  "itemizedCosts": [
    {
      "description": "Item or service name",
      "quantity": 1,
      "unitPrice": 0.00,
      "amount": 0.00
    }
  ],
  "subtotal": 0.00,
  "taxAmount": 0.00,
  "grandTotal": 0.00,
  "taxId": "GSTIN, VAT ID, TIN, or EIN if found",
  "vendorAddress": "Vendor full address if available",
  "suggestedCategory": "One of: Hardware, Software & Cloud, Office Supplies, Travel & Lodging, Utilities & Bills, Legal & Professional, Meals & Entertainment, or suggest a new category name",
  "paymentStatus": "Paid or Due"
}
`;

/**
 * Calls Ollama REST API
 */
async function callOllama(prompt, systemPrompt) {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'llama3';

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      prompt: `${systemPrompt}\n\nInvoice OCR Text:\n${prompt}`,
      stream: false,
      format: 'json'
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Ollama returned status ${response.status}`);
  }

  const data = await response.json();
  return data.response;
}

/**
 * Calls Google Gemini REST API
 */
async function callGemini(prompt, systemPrompt, apiKey) {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('No Gemini API key available');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  
  const payload = {
    contents: [
      {
        parts: [
          { text: `${systemPrompt}\n\nInvoice OCR Text:\n${prompt}` }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error('Gemini API call failed');
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}

/**
 * Main AI Invoice Parsing Pipeline:
 */
async function parseInvoiceText(rawText, userAiSettings = {}, existingCategories = []) {
  let parsedJson = null;

  // 1. Try Gemini if configured in environment
  if (process.env.GEMINI_API_KEY) {
    try {
      const resp = await callGemini(rawText, INVOICE_PARSER_SYSTEM_PROMPT, process.env.GEMINI_API_KEY);
      parsedJson = extractJsonFromAiResponse(resp);
    } catch (err) {}
  }

  // 2. Try Ollama local
  if (!parsedJson) {
    try {
      const resp = await callOllama(rawText, INVOICE_PARSER_SYSTEM_PROMPT);
      parsedJson = extractJsonFromAiResponse(resp);
    } catch (ollamaErr) {}
  }

  // 3. Fallback to Rule-based Heuristic Engine
  if (!parsedJson) {
    parsedJson = heuristicInvoiceExtractor(rawText, existingCategories);
  }

  // Sanitize non-negative values
  const subtotal = Math.max(0, Math.abs(parseFloat(parsedJson.subtotal) || 0));
  const taxAmount = Math.max(0, Math.abs(parseFloat(parsedJson.taxAmount) || 0));
  let grandTotal = Math.max(0, Math.abs(parseFloat(parsedJson.grandTotal) || 0));

  if (grandTotal === 0 && (subtotal > 0 || taxAmount > 0)) {
    grandTotal = parseFloat((subtotal + taxAmount).toFixed(2));
  } else if (subtotal === 0 && grandTotal > 0 && taxAmount > 0) {
    subtotal = Math.max(0, parseFloat((grandTotal - taxAmount).toFixed(2)));
  }

  return {
    vendorName: (parsedJson.vendorName || 'Unknown Vendor').trim(),
    firmName: (parsedJson.firmName || '').trim(),
    invoiceNumber: (parsedJson.invoiceNumber || '').trim(),
    billDate: parsedJson.billDate || new Date().toISOString().split('T')[0],
    dueDate: parsedJson.dueDate || parsedJson.billDate || new Date().toISOString().split('T')[0],
    itemizedCosts: Array.isArray(parsedJson.itemizedCosts) && parsedJson.itemizedCosts.length > 0 
      ? parsedJson.itemizedCosts.map(item => ({
          description: item.description || 'Line item',
          quantity: Math.max(1, Math.abs(parseFloat(item.quantity) || 1)),
          unitPrice: Math.max(0, Math.abs(parseFloat(item.unitPrice) || 0)),
          amount: Math.max(0, Math.abs(parseFloat(item.amount) || 0))
        }))
      : [{ description: 'Total Charge', quantity: 1, unitPrice: subtotal || grandTotal, amount: subtotal || grandTotal }],
    subtotal: parseFloat(subtotal.toFixed(2)),
    taxAmount: parseFloat(taxAmount.toFixed(2)),
    grandTotal: parseFloat(grandTotal.toFixed(2)),
    taxId: (parsedJson.taxId || '').trim(),
    vendorAddress: (parsedJson.vendorAddress || '').trim(),
    suggestedCategory: (parsedJson.suggestedCategory || 'General / Miscellaneous').trim(),
    paymentStatus: (parsedJson.paymentStatus && ['Paid', 'Due'].includes(parsedJson.paymentStatus)) 
      ? parsedJson.paymentStatus 
      : 'Due'
  };
}

/**
 * Ask Your Bills RAG Chat: Answers user questions based on stored bill metadata in ₹
 */
async function askBillsRag(userQuery, billsContext = []) {
  const billsSummaryText = billsContext.map((b, i) => {
    const dateStr = b.billDate ? new Date(b.billDate).toISOString().split('T')[0] : 'N/A';
    const dueStr = b.dueDate ? new Date(b.dueDate).toISOString().split('T')[0] : 'N/A';
    return `[Bill #${i + 1}]
- Vendor: ${b.vendorName}
- Invoice #: ${b.invoiceNumber || 'N/A'}
- Category: ${b.categoryName || 'General'}
- Date: ${dateStr} (Due: ${dueStr})
- Subtotal: ₹${b.subtotal.toFixed(2)} | Tax: ₹${b.taxAmount.toFixed(2)} | Grand Total: ₹${b.grandTotal.toFixed(2)}
- Tax ID: ${b.taxId || 'Not specified'}
- Status: ${b.paymentStatus}`;
  }).join('\n\n');

  const systemPrompt = `You are a helpful Financial Assistant.
Answer the user's question clearly and concisely using the provided invoice records. Always format monetary values in Indian Rupees (₹).
Do not output technical jargon or internal error details.

INVOICE RECORDS (${billsContext.length} Records):
${billsSummaryText || 'No bills uploaded yet.'}
`;

  // 1. Try Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      const resp = await callGemini(userQuery, systemPrompt, process.env.GEMINI_API_KEY);
      if (resp) return resp;
    } catch (e) {}
  }

  // 2. Try Ollama
  try {
    const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const model = process.env.OLLAMA_MODEL || 'llama3';
    const resp = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: `${systemPrompt}\n\nUser Question: ${userQuery}`,
        stream: false
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (resp.ok) {
      const d = await resp.json();
      return d.response;
    }
  } catch (err) {}

  // 3. Clean Statistical Fallback
  const queryLower = userQuery.toLowerCase();
  let matchedBills = billsContext;

  const categories = ['hardware', 'software', 'cloud', 'office', 'travel', 'utilities', 'legal', 'meals'];
  const matchedCat = categories.find(c => queryLower.includes(c));
  if (matchedCat) {
    matchedBills = matchedBills.filter(b => (b.categoryName || '').toLowerCase().includes(matchedCat));
  }

  if (queryLower.includes('due') || queryLower.includes('pending') || queryLower.includes('unpaid')) {
    matchedBills = matchedBills.filter(b => b.paymentStatus === 'Due');
  } else if (queryLower.includes('paid')) {
    matchedBills = matchedBills.filter(b => b.paymentStatus === 'Paid');
  }

  const totalAmount = matchedBills.reduce((acc, b) => acc + (b.grandTotal || 0), 0);
  const totalTax = matchedBills.reduce((acc, b) => acc + (b.taxAmount || 0), 0);

  return `Based on your records (${matchedBills.length} matching invoices):
• Total Expenditure: ₹${totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
• Total Tax (GST/VAT): ₹${totalTax.toLocaleString('en-IN', { minimumFractionDigits: 2 })}

Recent matching invoices:
${matchedBills.slice(0, 5).map(b => `• ${b.vendorName} (Inv #${b.invoiceNumber || 'N/A'}): ₹${b.grandTotal.toFixed(2)} [${b.paymentStatus}]`).join('\n')}`;
}

module.exports = {
  parseInvoiceText,
  askBillsRag,
  extractJsonFromAiResponse,
  heuristicInvoiceExtractor
};
