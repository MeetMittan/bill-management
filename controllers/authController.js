const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PendingUser = require('../models/PendingUser');
const Bill = require('../models/Bill');
const Category = require('../models/Category');
const mailerService = require('../services/mailerService');
const { JWT_SECRET } = require('../middleware/authMiddleware');

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
};

function generateToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' });
}

/**
 * GET /login
 */
function showLogin(req, res) {
  res.render('login', { title: 'Sign In', error: null });
}

/**
 * GET /register
 */
function showRegister(req, res) {
  res.render('register', { title: 'Create Account', error: null });
}

/**
 * POST /register
 * Step 1: Validate signup fields. DO NOT create permanent user yet.
 * Step 2: Generate 6-digit OTP, store in PendingUser (10 min expiry), and dispatch via Nodemailer.
 * Step 3: Abandonment protection: clean up any abandoned unverified records so email is never locked out.
 */
async function register(req, res) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      const msg = 'Please fill in all required fields.';
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ success: false, message: msg });
      }
      return res.render('register', { title: 'Create Account', error: msg });
    }

    if (password.length < 6) {
      const msg = 'Password must be at least 6 characters long.';
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ success: false, message: msg });
      }
      return res.render('register', { title: 'Create Account', error: msg });
    }

    const cleanEmail = email.toLowerCase().trim();

    // Check if an active verified user already exists
    const existingVerifiedUser = await User.findOne({ email: cleanEmail, isVerified: true });
    if (existingVerifiedUser) {
      const msg = 'An account with this email already exists. Please sign in.';
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ success: false, message: msg });
      }
      return res.render('register', { title: 'Create Account', error: msg });
    }

    // Step 3 (Abandonment Protection):
    // Purge any stale unverified user or previous pending attempts so the user is never locked out
    await User.deleteMany({ email: cleanEmail, isVerified: false });
    await PendingUser.deleteMany({ email: cleanEmail });

    // Step 2: Generate 6-digit numeric OTP and 10-minute validity
    const otp = PendingUser.generateOtp();
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000);
    const verificationToken = crypto.randomBytes(24).toString('hex');

    // DO NOT create a permanent user in MongoDB yet. Store temporarily in PendingUser collection.
    const pendingUser = await PendingUser.create({
      name: name.trim(),
      email: cleanEmail,
      password,
      otp,
      otpExpires,
      verificationToken
    });

    // Send OTP directly to the user's email via Nodemailer
    await mailerService.sendVerificationEmail(
      { name: pendingUser.name, email: cleanEmail },
      otp,
      verificationToken,
      'signup'
    );

    // Set temporary pending cookie for verification context and clear any existing auth token
    res.clearCookie('token');
    res.cookie('pending_email', cleanEmail, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, redirect: `/verify-otp?email=${encodeURIComponent(cleanEmail)}` });
    }
    res.redirect(`/verify-otp?email=${encodeURIComponent(cleanEmail)}`);
  } catch (error) {
    console.error('Registration error:', error.message);
    const msg = 'Unable to complete registration. Please check your information and try again.';
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ success: false, message: msg });
    }
    res.render('register', { title: 'Create Account', error: msg });
  }
}

/**
 * GET /verify-email or GET /verify-otp
 */
async function showVerifyEmail(req, res) {
  try {
    let user = req.user;
    if (!user && req.cookies && req.cookies.token) {
      try {
        const decoded = jwt.verify(req.cookies.token, JWT_SECRET);
        user = await User.findById(decoded.id);
      } catch (e) {}
    }

    const targetEmail = (req.query.email || req.cookies?.pending_email || (user ? user.email : '')).toLowerCase().trim();

    // Check if token was provided in URL query for instant verification link
    const { token, email } = req.query;
    if (token && email) {
      const cleanEmail = email.toLowerCase().trim();

      // Check PendingUser first
      const pendingUser = await PendingUser.findOne({ email: cleanEmail, verificationToken: token });
      if (pendingUser && new Date() <= pendingUser.otpExpires) {
        await User.deleteMany({ email: pendingUser.email, isVerified: false });
        const newUser = new User({
          name: pendingUser.name,
          email: pendingUser.email,
          password: pendingUser.password,
          isVerified: true
        });
        await newUser.save();
        await Category.seedDefaultsForUser(newUser._id);
        await PendingUser.deleteOne({ _id: pendingUser._id });

        res.clearCookie('pending_email');
        const authToken = generateToken(newUser._id);
        res.cookie('token', authToken, COOKIE_OPTIONS);
        return res.redirect('/dashboard?verified=true');
      }

      // Check existing User (for signin or link flow)
      const targetUser = await User.findOne({
        email: cleanEmail,
        verificationToken: token
      });
      if (targetUser) {
        targetUser.isVerified = true;
        targetUser.verificationOtp = undefined;
        targetUser.verificationOtpExpires = undefined;
        targetUser.verificationToken = undefined;
        await targetUser.save();

        res.clearCookie('pending_email');
        const authToken = generateToken(targetUser._id);
        res.cookie('token', authToken, COOKIE_OPTIONS);
        return res.redirect('/dashboard?verified=true');
      }
    }

    if (user && user.isVerified) {
      return res.redirect('/dashboard');
    }

    const hasSmtpConfigured = !!((process.env.EMAIL_USER || process.env.SMTP_USER) && (process.env.EMAIL_PASS || process.env.SMTP_PASS));
    let devOtp = null;
    if (!hasSmtpConfigured && targetEmail) {
      const pending = await PendingUser.findOne({ email: targetEmail });
      if (pending && new Date() <= pending.otpExpires) {
        devOtp = pending.otp;
      } else if (user && user.verificationOtp) {
        devOtp = user.verificationOtp;
      }
    }

    res.render('verify-email', {
      title: 'Verify Your Email',
      userEmail: targetEmail,
      hasSmtpConfigured,
      devOtp,
      error: req.query.error || null,
      success: null
    });
  } catch (err) {
    res.render('verify-email', {
      title: 'Verify Your Email',
      userEmail: req.user ? req.user.email : (req.query.email || ''),
      hasSmtpConfigured: false,
      devOtp: null,
      error: 'An unexpected issue occurred. Please request a new code.',
      success: null
    });
  }
}

/**
 * POST /verify-email or POST /verify-otp or POST /api/auth/verify-otp
 * Step 4 (OTP Verification):
 * If valid and not expired, create permanent user document in MongoDB, hash password with bcrypt, and log in with JWT.
 * If failed or incorrect, show clean user-friendly error message ("Invalid or expired OTP") and stay on verification page.
 */
async function verifyEmail(req, res) {
  try {
    const otpInput = (req.body.otp || '').trim();
    const isApi = req.xhr || req.headers.accept?.includes('application/json');
    const targetEmail = (req.body.email || req.query.email || req.cookies?.pending_email || (req.user ? req.user.email : '')).toLowerCase().trim();

    if (!otpInput || otpInput.length < 6) {
      const msg = 'Invalid or expired OTP';
      if (isApi) return res.status(400).json({ success: false, message: msg });
      return res.status(400).render('verify-email', {
        title: 'Verify Your Email',
        userEmail: targetEmail,
        error: msg,
        success: null
      });
    }

    // Check PendingUser collection first (Signup Verification)
    if (targetEmail) {
      const pendingUser = await PendingUser.findOne({ email: targetEmail });
      if (pendingUser) {
        const isOtpValid = pendingUser.otp === otpInput;
        const isExpired = new Date() > pendingUser.otpExpires;

        if (!isOtpValid || isExpired) {
          const msg = 'Invalid or expired OTP';
          if (isApi) return res.status(400).json({ success: false, message: msg });
          return res.status(400).render('verify-email', {
            title: 'Verify Your Email',
            userEmail: targetEmail,
            error: msg,
            success: null
          });
        }

        // OTP is valid! NOW create permanent user account in MongoDB Atlas
        await User.deleteMany({ email: pendingUser.email, isVerified: false });
        const user = new User({
          name: pendingUser.name,
          email: pendingUser.email,
          password: pendingUser.password,
          isVerified: true
        });
        await user.save();

        // Seed default spending categories for the new permanent user
        await Category.seedDefaultsForUser(user._id);

        // Clean up temporary PendingUser document
        await PendingUser.deleteOne({ _id: pendingUser._id });
        res.clearCookie('pending_email');

        // Automatically log in with JWT token in httpOnly cookie
        const token = generateToken(user._id);
        res.cookie('token', token, COOKIE_OPTIONS);

        if (isApi) {
          return res.json({ success: true, redirect: '/dashboard', message: 'Account verified successfully.' });
        }
        return res.redirect('/dashboard');
      }
    }

    // Check existing User record (Sign-in OTP Verification)
    let user = req.user;
    if (!user && req.cookies && req.cookies.token) {
      try {
        const decoded = jwt.verify(req.cookies.token, JWT_SECRET);
        user = await User.findById(decoded.id);
      } catch (e) {}
    }
    if (!user && targetEmail) {
      user = await User.findOne({ email: targetEmail });
    }

    if (user && user.verificationOtp) {
      const isOtpValid = user.verificationOtp === otpInput;
      const isExpired = user.verificationOtpExpires && new Date() > user.verificationOtpExpires;

      if (!isOtpValid || isExpired) {
        const msg = 'Invalid or expired OTP';
        if (isApi) return res.status(400).json({ success: false, message: msg });
        return res.status(400).render('verify-email', {
          title: 'Verify Your Email',
          userEmail: targetEmail || user.email,
          error: msg,
          success: null
        });
      }

      user.isVerified = true;
      user.verificationOtp = undefined;
      user.verificationOtpExpires = undefined;
      user.verificationToken = undefined;
      await user.save();

      res.clearCookie('pending_email');
      const token = generateToken(user._id);
      res.cookie('token', token, COOKIE_OPTIONS);

      if (isApi) {
        return res.json({ success: true, redirect: '/dashboard', message: 'Email verified successfully.' });
      }
      return res.redirect('/dashboard');
    }

    // If no matching pending or existing user with OTP found
    const msg = 'Invalid or expired OTP';
    if (isApi) return res.status(400).json({ success: false, message: msg });
    return res.status(400).render('verify-email', {
      title: 'Verify Your Email',
      userEmail: targetEmail,
      error: msg,
      success: null
    });
  } catch (err) {
    console.error('Verify error:', err.message);
    const msg = 'Invalid or expired OTP';
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ success: false, message: msg });
    }
    res.status(500).render('verify-email', {
      title: 'Verify Your Email',
      userEmail: req.body?.email || '',
      error: msg,
      success: null
    });
  }
}

/**
 * POST /api/auth/resend-otp
 */
async function resendOtp(req, res) {
  try {
    const targetEmail = (req.body.email || req.cookies?.pending_email || (req.user ? req.user.email : '')).toLowerCase().trim();
    if (!targetEmail) {
      return res.status(400).json({ success: false, message: 'Email address is required.' });
    }

    // Check PendingUser first
    const pendingUser = await PendingUser.findOne({ email: targetEmail });
    if (pendingUser) {
      const otp = PendingUser.generateOtp();
      pendingUser.otp = otp;
      pendingUser.otpExpires = new Date(Date.now() + 10 * 60 * 1000);
      await pendingUser.save();

      await mailerService.sendVerificationEmail(
        { name: pendingUser.name, email: pendingUser.email },
        otp,
        pendingUser.verificationToken,
        'resend'
      );

      return res.json({
        success: true,
        message: 'A new 6-digit verification code has been sent to your email.'
      });
    }

    // Check existing User
    const user = await User.findOne({ email: targetEmail });
    if (user) {
      const otp = user.generateVerificationOtp();
      const verifyToken = user.generateVerificationToken();
      await user.save();

      await mailerService.sendVerificationEmail(user, otp, verifyToken, 'resend');

      return res.json({
        success: true,
        message: 'A new 6-digit verification code has been sent to your email.'
      });
    }

    return res.status(404).json({ success: false, message: 'No registration pending for this email. Please register.' });
  } catch (err) {
    console.error('Resend OTP error:', err.message);
    res.status(500).json({ success: false, message: 'Could not send verification code. Please try again later.' });
  }
}

/**
 * POST /login
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      const msg = 'Please enter both email and password.';
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ success: false, message: msg });
      }
      return res.render('login', { title: 'Sign In', error: msg });
    }

    const cleanEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: cleanEmail }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      const msg = 'Invalid email or password.';
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ success: false, message: msg });
      }
      return res.render('login', { title: 'Sign In', error: msg });
    }

    // Generate fresh 6-digit OTP for Sign-In verification (10 min expiry)
    const otp = user.generateVerificationOtp();
    const verifyToken = user.generateVerificationToken();
    user.isVerified = false;
    await user.save();

    // Send Sign-In OTP email via Nodemailer (no console logs of OTP)
    await mailerService.sendVerificationEmail(user, otp, verifyToken, 'signin');

    const token = generateToken(user._id);
    res.cookie('token', token, COOKIE_OPTIONS);
    res.cookie('pending_email', user.email, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, redirect: `/verify-otp?email=${encodeURIComponent(user.email)}` });
    }
    return res.redirect(`/verify-otp?email=${encodeURIComponent(user.email)}`);
  } catch (error) {
    console.error('Login error:', error.message);
    const msg = 'Unable to sign in. Please try again.';
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ success: false, message: msg });
    }
    res.render('login', { title: 'Sign In', error: msg });
  }
}

/**
 * GET /logout
 */
function logout(req, res) {
  res.clearCookie('token');
  res.clearCookie('pending_email');
  res.redirect('/login');
}

/**
 * Comprehensive User Profile View
 * GET /profile (or /settings)
 */
async function showProfile(req, res) {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.redirect('/login');
    }

    // Account activity summary metrics
    const totalBills = await Bill.countDocuments({ user: user._id });
    const metrics = await Bill.aggregate([
      { $match: { user: user._id } },
      {
        $group: {
          _id: null,
          totalTax: { $sum: '$taxAmount' },
          totalAmount: { $sum: '$grandTotal' }
        }
      }
    ]);

    const stats = {
      totalBills,
      totalTaxAudited: metrics.length > 0 ? metrics[0].totalTax : 0,
      totalAmountProcessed: metrics.length > 0 ? metrics[0].totalAmount : 0
    };

    res.render('profile', {
      title: 'User Profile & Account',
      user,
      stats,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (error) {
    console.error('Error loading profile:', error.message);
    res.redirect('/dashboard');
  }
}

/**
 * Update Profile Details
 * POST /profile or POST /api/profile/update or POST /api/settings/profile
 */
async function updateProfile(req, res) {
  try {
    const { name, email, emailAlertsEnabled } = req.body;
    const isApi = req.xhr || req.headers.accept?.includes('application/json');
    const user = await User.findById(req.user._id);

    if (!user) {
      const msg = 'User account not found.';
      if (isApi) return res.status(404).json({ success: false, message: msg });
      return res.redirect('/profile?error=' + encodeURIComponent(msg));
    }

    if (name && name.trim()) {
      user.name = name.trim();
    }

    if (email && email.trim() && email.toLowerCase().trim() !== user.email) {
      const cleanEmail = email.toLowerCase().trim();
      const existing = await User.findOne({ email: cleanEmail, _id: { $ne: user._id } });
      if (existing) {
        const msg = 'An account with this email address already exists.';
        if (isApi) return res.status(400).json({ success: false, message: msg });
        return res.redirect('/profile?error=' + encodeURIComponent(msg));
      }
      user.email = cleanEmail;
    }

    if (emailAlertsEnabled !== undefined) {
      user.emailAlertsEnabled = emailAlertsEnabled === 'true' || emailAlertsEnabled === true;
    }

    await user.save();

    const msg = 'Profile updated successfully.';
    if (isApi) {
      return res.json({
        success: true,
        message: msg,
        formattedName: user.formattedName
      });
    }
    return res.redirect('/profile?success=' + encodeURIComponent(msg));
  } catch (error) {
    console.error('Update profile error:', error.message);
    const msg = 'Failed to update profile details.';
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ success: false, message: msg });
    }
    return res.redirect('/profile?error=' + encodeURIComponent(msg));
  }
}

/**
 * Change Password
 * POST /api/profile/change-password
 */
async function changePassword(req, res) {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const isApi = req.xhr || req.headers.accept?.includes('application/json');

    if (!currentPassword || !newPassword) {
      const msg = 'Please enter both your current and new password.';
      if (isApi) return res.status(400).json({ success: false, message: msg });
      return res.redirect('/profile?error=' + encodeURIComponent(msg));
    }

    if (newPassword.length < 6) {
      const msg = 'New password must be at least 6 characters long.';
      if (isApi) return res.status(400).json({ success: false, message: msg });
      return res.redirect('/profile?error=' + encodeURIComponent(msg));
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      const msg = 'New password and confirmation do not match.';
      if (isApi) return res.status(400).json({ success: false, message: msg });
      return res.redirect('/profile?error=' + encodeURIComponent(msg));
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user || !(await user.comparePassword(currentPassword))) {
      const msg = 'Current password is incorrect.';
      if (isApi) return res.status(400).json({ success: false, message: msg });
      return res.redirect('/profile?error=' + encodeURIComponent(msg));
    }

    user.password = newPassword;
    await user.save();

    const msg = 'Password updated successfully.';
    if (isApi) return res.json({ success: true, message: msg });
    return res.redirect('/profile?success=' + encodeURIComponent(msg));
  } catch (error) {
    console.error('Change password error:', error.message);
    const msg = 'Failed to change password. Please try again.';
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ success: false, message: msg });
    }
    return res.redirect('/profile?error=' + encodeURIComponent(msg));
  }
}

module.exports = {
  showLogin,
  showRegister,
  register,
  showVerifyEmail,
  verifyEmail,
  resendOtp,
  login,
  logout,
  showProfile,
  updateProfile,
  changePassword
};
