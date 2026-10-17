const mongoose = require('mongoose');

const pendingUserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  password: {
    type: String,
    required: true
  },
  otp: {
    type: String,
    required: true
  },
  otpExpires: {
    type: Date,
    required: true
  },
  verificationToken: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 600 // MongoDB TTL index: automatically deletes pending document after 10 minutes (600s)
  }
});

// Helper static to generate 6-digit numeric OTP
pendingUserSchema.statics.generateOtp = function () {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

module.exports = mongoose.model('PendingUser', pendingUserSchema);

