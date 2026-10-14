const customCrypto = require('../config/customCrypto');

/**
 * Normalizes text to extract valid JSON even if wrapped in markdown blocks
 */
function extractJsonFromAiResponse(aiText) {
  if (!aiText) return null;

  try {
    // 1. Direct parse attempt
    return JSON.parse(aiText.trim());
  } catch (initialErr) {
    // 2. Regex to strip ```json ... ``` or ``` ... ```
    const markdownRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
    const match = aiText.match(markdownRegex);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1].trim());
      } catch (e) {
        // Continue to fallback
      }
    }

    // 3. Fallback: Find outer braces { ... }
    const firstBrace = aiText.indexOf('{');
    const lastBrace = aiText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = aiText.substring(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch (e) {
        // Try fixing unescaped newlines or trailing commas
        const cleaned = candidate
          .replace(/,\s*}/g, '}')
          .replace(/,\s*]/g, ']');
        try {
          return JSON.parse(cleaned);
        } catch (innerErr) {
          console.error('[AI Service] Failed to parse JSON even after cleaning:', innerErr.message);
        }
      }
    }
  }
  return null;
}

/**
 * Smart Rule-based Invoice Heuristic Parser (Fallback when AI is offline or unreachable)
 */
function heuristicInvoiceExtractor(rawText, existingCategories = []) {
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  
  // 1. Vendor Name Heuristics (usually first 3 non-empty lines)
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

  // 3. Dates (Bill Date and Due Date)
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

  // 4. Tax Identification Number (GSTIN / VAT ID / EIN)
  let taxId = '';
  // GSTIN 15-char regex or VAT/Tax ID
  const gstinMatch = rawText.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})\b/i);
  if (gstinMatch) {
    taxId = gstinMatch[1].toUpperCase();
  } else {
    const taxMatch = rawText.match(/(?:GSTIN|VAT(?:\s*ID)?|Tax\s*ID|TIN|EIN):?\s*([A-Z0-9\-_]+)/i);
    if (taxMatch && taxMatch[1]) {
      taxId = taxMatch[1].trim();
    }
  }

  // 5. Financial Amounts (Subtotal, Tax, Grand Total)
  let grandTotal = 0;
  let subtotal = 0;
  let taxAmount = 0;

  // Match Grand Total specifically first (avoiding greedy match on Sub Total)
  const grandTotalMatch = rawText.match(/(?:Grand\s*Total|Total\s*Amount|Amount\s*Due|Invoice\s*Total)\s*:?\s*[$₹€£]?\s*([0-9,]+\.?[0-9]{0,2})/i);
  if (grandTotalMatch && grandTotalMatch[1]) {
    grandTotal = parseFloat(grandTotalMatch[1].replace(/,/g, '')) || 0;
  } else {
    const fallbackTotalMatch = rawText.match(/(?:^|[^a-zA-Z])Total\s*:?\s*[$₹€£]?\s*([0-9,]+\.?[0-9]{0,2})/im);
    if (fallbackTotalMatch && fallbackTotalMatch[1]) {
      grandTotal = parseFloat(fallbackTotalMatch[1].replace(/,/g, '')) || 0;
    }
  }

  const subtotalMatch = rawText.match(/(?:Sub\s*Total|Net\s*Amount|Taxable\s*Amount)\s*:?\s*[$₹€£]?\s*([0-9,]+\.?[0-9]{0,2})/i);
  if (subtotalMatch && subtotalMatch[1]) {
    subtotal = parseFloat(subtotalMatch[1].replace(/,/g, '')) || 0;
  }

  // Matches "GST Tax (18%): $153.00", "Total Tax: $50", "VAT: $20", etc.
  const taxMatch2 = rawText.match(/(?:Total\s*Tax|Tax\s*Amount|GST(?:\s*Tax)?|VAT|CGST\s*\+\s*SGST)(?:\s*\([^)]*\))?\s*:?\s*[$₹€£]?\s*([0-9,]+\.?[0-9]{0,2})/i);
  if (taxMatch2 && taxMatch2[1]) {
    taxAmount = parseFloat(taxMatch2[1].replace(/,/g, '')) || 0;
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
    'Utilities & Bills': ['electricity', 'water', 'internet', 'broadband', 'telecom', 'phone', 'verizon', 'at&t', 'power'],
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
        description: 'Invoice Total Line Item',
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
    paymentStatus,
    parsedVia: 'rule-based-heuristic-engine'
  };
}

/**
 * System Prompt instructing the AI to output strictly structured JSON
 */
const INVOICE_PARSER_SYSTEM_PROMPT = `
You are an expert Tax and Financial Audit AI. Extract all bill/invoice information from the provided raw OCR text.
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
async function callOllama(prompt, systemPrompt, settings) {
  const baseUrl = settings.ollamaBaseUrl || 'http://localhost:11434';
  const model = settings.ollamaModel || 'llama3';

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: model,
      prompt: `${systemPrompt}\n\nInvoice OCR Text:\n${prompt}`,
      stream: false,
      format: 'json'
    }),
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return data.response;
}

/**
 * Calls Google Gemini REST API
 */
async function callGemini(prompt, systemPrompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
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
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text;
}

/**
 * Calls OpenAI REST API
 */
async function callOpenAI(prompt, systemPrompt, apiKey) {
  const url = 'https://api.openai.com/v1/chat/completions';

  const payload = {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Invoice OCR Text:\n${prompt}` }
    ],
    temperature: 0.1,
    response_format: { type: "json_object" }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content;
}

/**
 * Main AI Invoice Parsing Pipeline:
 * Priority: Configured Provider -> Ollama -> Heuristic Engine Fallback
 */
async function parseInvoiceText(rawText, userAiSettings = {}, existingCategories = []) {
  const provider = userAiSettings.preferredProvider || 'ollama';
  let aiRawResponse = null;
  let parsedJson = null;
  let parsingEngineUsed = 'heuristic';

  // Attempt Cloud AI if configured
  if (provider === 'gemini') {
    const geminiKey = customCrypto.decrypt(userAiSettings.geminiApiKeyEncrypted);
    if (geminiKey) {
      try {
        console.log('[AI Service] Routing to Gemini API...');
        aiRawResponse = await callGemini(rawText, INVOICE_PARSER_SYSTEM_PROMPT, geminiKey);
        parsedJson = extractJsonFromAiResponse(aiRawResponse);
        if (parsedJson) parsingEngineUsed = 'gemini';
      } catch (err) {
        console.warn('[AI Service] Gemini API failed:', err.message, '- Falling back to Ollama / Heuristic...');
      }
    } else {
      console.warn('[AI Service] Gemini preferred but no API key configured. Trying Ollama...');
    }
  } else if (provider === 'openai') {
    const openAiKey = customCrypto.decrypt(userAiSettings.openAiApiKeyEncrypted);
    if (openAiKey) {
      try {
        console.log('[AI Service] Routing to OpenAI API...');
        aiRawResponse = await callOpenAI(rawText, INVOICE_PARSER_SYSTEM_PROMPT, openAiKey);
        parsedJson = extractJsonFromAiResponse(aiRawResponse);
        if (parsedJson) parsingEngineUsed = 'openai';
      } catch (err) {
        console.warn('[AI Service] OpenAI API failed:', err.message, '- Falling back to Ollama / Heuristic...');
      }
    } else {
      console.warn('[AI Service] OpenAI preferred but no API key configured. Trying Ollama...');
    }
  }

  // Attempt Ollama if Cloud AI wasn't used or failed
  if (!parsedJson) {
    try {
      console.log('[AI Service] Routing to local Ollama API...');
      aiRawResponse = await callOllama(rawText, INVOICE_PARSER_SYSTEM_PROMPT, userAiSettings);
      parsedJson = extractJsonFromAiResponse(aiRawResponse);
      if (parsedJson) parsingEngineUsed = 'ollama';
    } catch (ollamaErr) {
      console.warn('[AI Service] Ollama unreachable or failed:', ollamaErr.message);
    }
  }

  // Fallback to Rule-based Heuristic Engine
  if (!parsedJson) {
    console.log('[AI Service] Using Rule-based Heuristic Parser fallback...');
    parsedJson = heuristicInvoiceExtractor(rawText, existingCategories);
    parsingEngineUsed = 'rule-based-heuristic';
  }

  // Sanitize and validate numeric values
  const subtotal = Math.abs(parseFloat(parsedJson.subtotal) || 0);
  const taxAmount = Math.abs(parseFloat(parsedJson.taxAmount) || 0);
  let grandTotal = Math.abs(parseFloat(parsedJson.grandTotal) || 0);

  if (grandTotal === 0 && (subtotal > 0 || taxAmount > 0)) {
    grandTotal = parseFloat((subtotal + taxAmount).toFixed(2));
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
          quantity: parseFloat(item.quantity) || 1,
          unitPrice: parseFloat(item.unitPrice) || 0,
          amount: parseFloat(item.amount) || 0
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
      : 'Due',
    parsingEngineUsed,
    rawAiResponse: aiRawResponse
  };
}

/**
 * Ask Your Bills RAG Chat: Answers user questions based on stored bill metadata
 */
async function askBillsRag(userQuery, billsContext = [], userAiSettings = {}) {
  const provider = userAiSettings.preferredProvider || 'ollama';

  // Format compact bill metadata context
  const billsSummaryText = billsContext.map((b, i) => {
    const dateStr = b.billDate ? new Date(b.billDate).toISOString().split('T')[0] : 'N/A';
    const dueStr = b.dueDate ? new Date(b.dueDate).toISOString().split('T')[0] : 'N/A';
    return `[Bill #${i + 1}]
- Vendor: ${b.vendorName}
- Firm / Client: ${b.firmName || 'None'}
- Invoice #: ${b.invoiceNumber || 'N/A'}
- Category: ${b.categoryName || 'General'}
- Date: ${dateStr} (Due: ${dueStr})
- Subtotal: $${b.subtotal.toFixed(2)} | Tax Paid: $${b.taxAmount.toFixed(2)} | Grand Total: $${b.grandTotal.toFixed(2)}
- Tax ID (GST/VAT): ${b.taxId || 'Missing'}
- Status: ${b.paymentStatus}
- Audit Flags: Math Discrepancy=${b.auditFlags?.mathDiscrepancy ? 'YES' : 'NO'}, Duplicate=${b.auditFlags?.duplicateReceipt ? 'YES' : 'NO'}
- Notes: ${(b.notes || []).map(n => n.text).join('; ') || 'None'}`;
  }).join('\n\n');

  const systemPrompt = `You are an expert Tax and Financial Audit Assistant named "AuditAI".
You have direct read access to the user's verified bills and tax records.
Answer the user's audit/tax question accurately, citing specific invoice numbers, dates, vendor names, and exact tax or total dollar amounts.
If the information is not in the records, state that clearly. Be professional, concise, and helpful.

CURRENT AUDIT BILLS DATABASE (${billsContext.length} Records):
${billsSummaryText || 'No bills uploaded yet.'}
`;

  // 1. Try Gemini
  if (provider === 'gemini') {
    const key = customCrypto.decrypt(userAiSettings.geminiApiKeyEncrypted);
    if (key) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${systemPrompt}\n\nUser Question: ${userQuery}` }] }]
          })
        });
        if (resp.ok) {
          const d = await resp.json();
          return d.candidates?.[0]?.content?.parts?.[0]?.text;
        }
      } catch (err) {
        console.warn('[RAG Chat] Gemini error:', err.message);
      }
    }
  }

  // 2. Try OpenAI
  if (provider === 'openai') {
    const key = customCrypto.decrypt(userAiSettings.openAiApiKeyEncrypted);
    if (key) {
      try {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userQuery }
            ]
          })
        });
        if (resp.ok) {
          const d = await resp.json();
          return d.choices?.[0]?.message?.content;
        }
      } catch (err) {
        console.warn('[RAG Chat] OpenAI error:', err.message);
      }
    }
  }

  // 3. Try Ollama
  try {
    const baseUrl = userAiSettings.ollamaBaseUrl || 'http://localhost:11434';
    const model = userAiSettings.ollamaModel || 'llama3';
    const resp = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model,
        prompt: `${systemPrompt}\n\nUser Question: ${userQuery}`,
        stream: false
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (resp.ok) {
      const d = await resp.json();
      return d.response;
    }
  } catch (err) {
    console.warn('[RAG Chat] Ollama unreachable:', err.message);
  }

  // 4. Intelligent Local Audit Engine Fallback
  // Compute basic stats to answer standard questions (e.g. tax in hardware, total spend, due bills)
  const queryLower = userQuery.toLowerCase();
  let matchedBills = billsContext;

  // Filter by category if mentioned
  const categories = ['hardware', 'software', 'cloud', 'office', 'travel', 'utilities', 'legal', 'meals'];
  const matchedCat = categories.find(c => queryLower.includes(c));
  if (matchedCat) {
    matchedBills = matchedBills.filter(b => (b.categoryName || '').toLowerCase().includes(matchedCat));
  }

  // Filter by status if mentioned
  if (queryLower.includes('due') || queryLower.includes('pending') || queryLower.includes('unpaid')) {
    matchedBills = matchedBills.filter(b => b.paymentStatus === 'Due');
  } else if (queryLower.includes('paid')) {
    matchedBills = matchedBills.filter(b => b.paymentStatus === 'Paid');
  }

  const totalAmount = matchedBills.reduce((acc, b) => acc + (b.grandTotal || 0), 0);
  const totalTax = matchedBills.reduce((acc, b) => acc + (b.taxAmount || 0), 0);

  return `📊 **Local Audit Engine Summary:**
Based on your ${billsContext.length} uploaded records:
- **Matching Invoices Found:** ${matchedBills.length}
- **Total Expenditure:** $${totalAmount.toFixed(2)}
- **Total Tax (GST/VAT) Paid:** $${totalTax.toFixed(2)}

${matchedBills.slice(0, 5).map(b => `• **${b.vendorName}** (Inv #${b.invoiceNumber || 'N/A'}): Total $${b.grandTotal.toFixed(2)}, Tax $${b.taxAmount.toFixed(2)} [Status: ${b.paymentStatus}]`).join('\n')}

*(Tip: To enable full conversational AI reasoning, start Ollama locally or enter your Gemini/OpenAI API key in [Settings](/settings).)*`;
}

module.exports = {
  parseInvoiceText,
  askBillsRag,
  extractJsonFromAiResponse,
  heuristicInvoiceExtractor
};
