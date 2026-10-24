require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const { connectDB } = require('./config/db');
const { protect, redirectIfAuthenticated } = require('./middleware/authMiddleware');
const { handleUpload } = require('./middleware/uploadMiddleware');

const authController = require('./controllers/authController');
const billController = require('./controllers/billController');
const analyticsController = require('./controllers/analyticsController');
const chatController = require('./controllers/chatController');
const mailerService = require('./services/mailerService');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable trust proxy for reverse proxies (Railway, Render, Heroku, Cloudflare)
app.set('trust proxy', 1);

// Connect to MongoDB
connectDB();

// View Engine Setup (EJS)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Core Middlewares
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(cookieParser());

// Static Assets
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Security: Rate Limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: 'Too many authentication attempts from this IP. Please try again after 15 minutes.'
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { success: false, message: 'Upload rate limit reached. Please wait a few moments before submitting more bills.' }
});

// ========================================================
// PUBLIC ROUTES
// ========================================================
app.get('/', (req, res) => {
  if (req.cookies && req.cookies.token) {
    return res.redirect('/dashboard');
  }
  res.redirect('/login');
});

app.get('/login', redirectIfAuthenticated, authController.showLogin);
app.post('/login', authLimiter, authController.login);

app.get('/register', redirectIfAuthenticated, authController.showRegister);
app.post('/register', authLimiter, authController.register);

app.get('/logout', authController.logout);

// Forgot & Reset Password
app.get('/forgot-password', redirectIfAuthenticated, authController.showForgotPassword);
app.post('/forgot-password', authLimiter, authController.forgotPassword);
app.post('/api/auth/forgot-password', authLimiter, authController.forgotPassword);

app.get('/reset-password', redirectIfAuthenticated, authController.showResetPassword);
app.post('/reset-password', authLimiter, authController.resetPassword);
app.post('/api/auth/reset-password', authLimiter, authController.resetPassword);

// Email & Sign-In OTP Verification
app.get('/verify-otp', authController.showVerifyEmail);
app.post('/verify-otp', authController.verifyEmail);
app.get('/verify-email', authController.showVerifyEmail);
app.post('/verify-email', authController.verifyEmail);
app.post('/api/auth/verify-otp', authController.verifyEmail);
app.post('/api/auth/resend-otp', authController.resendOtp);

// ========================================================
// PROTECTED WEB VIEWS (EJS UI)
// ========================================================
app.get('/dashboard', protect, analyticsController.showDashboard);
app.get('/bills', protect, billController.getBills);
app.get('/bills/:id', protect, billController.showBillDetail);
app.get('/upload', protect, billController.showUpload);
app.get('/profile', protect, authController.showProfile);
app.post('/profile', protect, authController.updateProfile);
app.get('/settings', protect, (req, res) => res.redirect('/profile'));
app.get('/chat', protect, chatController.showChat);

// ========================================================
// PROTECTED API ENDPOINTS
// ========================================================
// Bill Upload & Analysis Pipeline
app.post('/api/bills/upload', protect, uploadLimiter, handleUpload('billFile'), billController.uploadBill);

// Bill Management & Audit Notes
app.post('/api/bills/:id', protect, billController.updateBill);
app.delete('/api/bills/:id', protect, billController.deleteBill);
app.patch('/api/bills/:id/toggle-status', protect, billController.toggleStatus);
app.patch('/api/bills/:id/toggle-pii', protect, billController.togglePii);
app.post('/api/bills/:id/notes', protect, billController.addAuditNote);

// Analytics & CSV Export
app.get('/api/analytics/data', protect, analyticsController.getChartData);
app.get('/api/analytics/export-csv', protect, analyticsController.exportCSV);

// "Ask Your Bills" Local RAG Chat
app.post('/api/chat/ask', protect, chatController.handleChatQuery);

// User Profile Settings & Password Change
app.post('/api/profile/update', protect, authController.updateProfile);
app.post('/api/profile/change-password', protect, authController.changePassword);
app.post('/api/settings/profile', protect, authController.updateProfile);

// ========================================================
// AUTOMATED DUE DATE REMINDER SCHEDULER (NODE-CRON)
// Scans daily at 09:00 AM for invoices due in ~3 days
// ========================================================
cron.schedule('0 9 * * *', async () => {
  console.log('[Scheduler] Executing automated 3-day payment reminder scan...');
  await mailerService.checkAndSendDueAlerts();
});

// ========================================================
// 404 & ERROR HANDLING
// ========================================================
app.use((req, res) => {
  res.status(404).render('login', {
    title: '404 - Page Not Found',
    error: 'The requested resource was not found. Please log in or return to the dashboard.'
  });
});

app.use((err, req, res, next) => {
  console.error('[Unhandled Server Exception]:', err.stack);
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(500).json({
      success: false,
      message: err.message || 'Internal server error occurred.'
    });
  }
  res.status(500).send(`Server Error: ${err.message}`);
});

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Audit & Tax Bill Management Web App is Running`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`🔒 Encryption: AES-256-GCM Active`);
  console.log(`🤖 AI Pipeline: Local Ollama + Cloud Gemini/OpenAI Fallback`);
  console.log(`=======================================================`);
});

module.exports = app;

