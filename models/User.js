const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
  role: {
    type: String,
    enum: ['Auditor', 'Accountant', 'Admin'],
    default: 'Auditor'
  },
  aiSettings: {
    preferredProvider: {
      type: String,
      enum: ['ollama', 'gemini', 'openai'],
      default: 'ollama'
    },
    geminiApiKeyEncrypted: {
      type: String,
      default: ''
    },
    openAiApiKeyEncrypted: {
      type: String,
      default: ''
    },
    ollamaBaseUrl: {
      type: String,
      default: 'http://localhost:11434'
    },
    ollamaModel: {
      type: String,
      default: 'llama3'
    }
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

// Pre-save password hashing
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Password verification method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
