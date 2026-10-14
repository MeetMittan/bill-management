const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const { PDFParse } = require('pdf-parse');

/**
 * Extracts raw textual data from an uploaded invoice (Image or PDF).
 * @param {string} filePath - Absolute path to uploaded file
 * @param {string} mimeType - MIME type of the file
 * @returns {Promise<{success: boolean, rawText: string, needsManualReview: boolean, error?: string}>}
 */
async function extractTextFromFile(filePath, mimeType) {
  try {
    if (!fs.existsSync(filePath)) {
      return {
        success: false,
        rawText: '',
        needsManualReview: true,
        error: 'File does not exist on disk.'
      };
    }

    const ext = path.extname(filePath).toLowerCase();
    let rawText = '';

    // Handle PDF files
    if (mimeType === 'application/pdf' || ext === '.pdf') {
      try {
        const fileBuffer = fs.readFileSync(filePath);
        const parser = new PDFParse({ data: fileBuffer });
        const result = await parser.getText();
        
        if (typeof result === 'string') {
          rawText = result;
        } else if (result && result.text) {
          rawText = result.text;
        } else if (result && Array.isArray(result.pages)) {
          rawText = result.pages.map(p => p.text || '').join('\n');
        } else if (result && typeof result === 'object') {
          rawText = JSON.stringify(result);
        }
      } catch (pdfErr) {
        console.warn('[OCR Service] PDF direct text extraction failed, attempting fallback or review:', pdfErr.message);
      }
    } 
    // Handle Image files (PNG, JPG, JPEG, WEBP)
    else {
      console.log(`[OCR Service] Starting Tesseract.js OCR processing for ${path.basename(filePath)}...`);
      const { data } = await Tesseract.recognize(filePath, 'eng', {
        logger: (m) => {
          if (m.status === 'recognizing text' && m.progress % 0.5 === 0) {
            console.log(`[OCR Service] OCR Progress: ${(m.progress * 100).toFixed(0)}%`);
          }
        }
      });
      rawText = (data && data.text) ? data.text : '';
    }

    rawText = (rawText || '').trim();

    // Edge case 1: OCR Failure or Low Quality Image
    if (!rawText || rawText.length < 15) {
      console.warn('[OCR Service] Insufficient text extracted (<15 chars). Marking for Manual Review.');
      return {
        success: false,
        rawText: rawText || '',
        needsManualReview: true,
        error: 'Low-quality scan or unreadable image. Text extraction yielded insufficient characters.'
      };
    }

    return {
      success: true,
      rawText: rawText,
      needsManualReview: false
    };
  } catch (error) {
    console.error('[OCR Service] Exception occurred during text extraction:', error.message);
    return {
      success: false,
      rawText: '',
      needsManualReview: true,
      error: `OCR Exception: ${error.message}`
    };
  }
}

module.exports = {
  extractTextFromFile
};

