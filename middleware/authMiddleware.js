const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secure-audit-jwt-secret-key-prod-2026';

/**
 * Protect routes by requiring a valid JWT in HTTP-Only cookies or Auth Header
 * and restricting unverified email accounts.
 */
async function protect(req, res, next) {
  let token = null;

  // 1. Check HTTP-Only cookie
  if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  } 
  // 2. Check Bearer Authorization Header
  else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  const isApiOrAjax = req.path.startsWith('/api') || 
                      req.xhr || 
                      (req.headers.accept && req.headers.accept.includes('application/json'));

  if (!token) {
    if (isApiOrAjax) {
      return res.status(401).json({ success: false, message: 'Please log in to continue.' });
    }
    return res.redirect('/login');
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      res.clearCookie('token');
      if (isApiOrAjax) {
        return res.status(401).json({ success: false, message: 'Account not found.' });
      }
      return res.redirect('/login');
    }

    req.user = user;
    res.locals.user = user;
    res.locals.displayName = user.formattedName || User.formatFirstWordCaps(user.name);

    // Restrict access until email is verified
    const isVerificationRoute = req.path === '/verify-email' || 
                                req.path === '/verify-otp' || 
                                req.path === '/api/auth/verify-otp' || 
                                req.path === '/api/auth/resend-otp' ||
                                req.path === '/logout';

    if (!user.isVerified && !isVerificationRoute) {
      if (isApiOrAjax) {
        return res.status(403).json({
          success: false,
          message: 'Please verify your email address to continue.',
          needsVerification: true,
          redirect: '/verify-otp'
        });
      }
      return res.redirect('/verify-otp');
    }

    next();
  } catch (err) {
    res.clearCookie('token');
    if (isApiOrAjax) {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }
    return res.redirect('/login');
  }
}

/**
 * Redirect logged in and verified users away from login/register to dashboard
 */
async function redirectIfAuthenticated(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.id);
      if (user) {
        if (!user.isVerified) {
          return res.redirect('/verify-otp');
        }
        return res.redirect('/dashboard');
      }
    } catch {
      // Token invalid, proceed
    }
  }
  next();
}

module.exports = {
  protect,
  redirectIfAuthenticated,
  JWT_SECRET
};
