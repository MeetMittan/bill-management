const crypto = require('crypto');

// Default fallback key for development if not provided in env (will log warning)
const RAW_KEY = process.env.ENCRYPTION_KEY || 'default-secret-encryption-key-audit-tax-32b';
// Ensure a 32-byte key for AES-256 using SHA-256
const ALGORITHM = 'aes-256-gcm';
const KEY = crypto.createHash('sha256').update(RAW_KEY).digest();

/**
 * Encrypts a plain text string using AES-256-GCM.
 * @param {string} text - Plain text to encrypt.
 * @returns {string} - Combined string format: "iv:authTag:encryptedData" in hex.
 */
function encrypt(text) {
  if (!text || typeof text !== 'string') return '';
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (error) {
    console.error('Encryption error:', error.message);
    throw new Error('Failed to encrypt sensitive data');
  }
}

/**
 * Decrypts an AES-256-GCM encrypted string.
 * @param {string} encryptedString - String in format "iv:authTag:encryptedData".
 * @returns {string} - Decrypted plain text string.
 */
function decrypt(encryptedString) {
  if (!encryptedString || typeof encryptedString !== 'string') return '';
  try {
    const parts = encryptedString.split(':');
    if (parts.length !== 3) {
      // Return empty if not properly formatted
      return '';
    }
    
    const [ivHex, authTagHex, encryptedDataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedDataHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error.message);
    return '';
  }
}

/**
 * Masks sensitive account or card numbers (PII protection).
 * E.g., "123456789012" -> "•••• •••• 9012"
 * @param {string} str 
 * @returns {string}
 */
function maskPII(str) {
  if (!str || typeof str !== 'string') return '';
  // Mask 16-digit cards (with dashes/spaces) or 9-18 digit account numbers keeping last 4
  return str.replace(/\b(?:\d{4}[ -]){3}\d{4}\b|\b\d{9,18}\b/g, (match) => {
    const digitsOnly = match.replace(/\D/g, '');
    const last4 = digitsOnly.slice(-4);
    return `•••• •••• •••• ${last4}`;
  });
}

/**
 * Computes SHA-256 hash of a file buffer or string (for duplicate detection)
 * @param {Buffer|string} data 
 * @returns {string}
 */
function computeHash(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

module.exports = {
  encrypt,
  decrypt,
  maskPII,
  computeHash
};
