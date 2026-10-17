const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

/**
 * Formats a user name with CAPS LOCK ON THE FIRST WORD
 * and title-cased subsequent words (e.g., "meet kumar" -> "MEET Kumar").
 */
function formatFirstWordCaps(name) {
  if (!name || typeof name !== 'string') return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '';
  if (parts.length === 1) return parts[0].toUpperCase();

  const firstWord = parts[0].toUpperCase();
  const restWords = parts.slice(1).map(w => {
    if (!w) return '';
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');

  return `${firstWord} ${restWords}`;
}

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide your full name'],
    trim: true,
    maxlength: 100
  },
  email: {
    type: String,
    required: [true, 'Please provide an email address'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address']
  },
  password: {
    type: String,
    required: [true, 'Please provide a password'],
    minlength: 6,
    select: false
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  verificationOtp: {
    type: String,
    default: null
  },
  verificationOtpExpires: {
    type: Date,
    default: null
  },
  verificationToken: {
    type: String,
    default: null
  },
  emailAlertsEnabled: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Virtual getter to format user's name with CAPS LOCK ON THE FIRST WORD (e.g., "MEET Kumar")
userSchema.virtual('formattedName').get(function () {
  return formatFirstWordCaps(this.name);
});

// Pre-save password hashing
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  if (typeof this.password === 'string' && /^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(this.password)) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Password verification method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Generate 6-digit OTP for email verification (10-minute validity)
userSchema.methods.generateVerificationOtp = function () {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  this.verificationOtp = otp;
  this.verificationOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
  return otp;
};

// Generate direct token for email link verification
userSchema.methods.generateVerificationToken = function () {
  const token = crypto.randomBytes(24).toString('hex');
  this.verificationToken = token;
  return token;
};

userSchema.statics.formatFirstWordCaps = formatFirstWordCaps;

module.exports = mongoose.model('User', userSchema);
