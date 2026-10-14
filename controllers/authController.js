const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Category = require('../models/Category');
const customCrypto = require('../config/customCrypto');
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
  res.render('login', { title: 'Sign In | Audit & Tax Bill Manager', error: null });
}

/**
 * GET /register
 */
function showRegister(req, res) {
  res.render('register', { title: 'Create Account | Audit & Tax Bill Manager', error: null });
}

/**
 * POST /register
 */
async function register(req, res) {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ success: false, message: 'All fields are required.' });
      }
      return res.render('register', { title: 'Create Account', error: 'Please provide all required fields.' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ success: false, message: 'An account with this email already exists.' });
      }
      return res.render('register', { title: 'Create Account', error: 'Email address is already registered.' });
    }

    const user = new User({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password,
      role: role || 'Auditor'
    });

    await user.save();

    // Seed standard initial categories for this user
    await Category.seedDefaultsForUser(user._id);

    const token = generateToken(user._id);
    res.cookie('token', token, COOKIE_OPTIONS);

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, redirect: '/dashboard' });
    }
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Registration error:', error);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ success: false, message: error.message });
    }
    res.render('register', { title: 'Create Account', error: error.message || 'Registration failed.' });
  }
}

/**
 * POST /login
 */
async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
      }
      return res.render('login', { title: 'Sign In', error: 'Please enter your email and password.' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(401).json({ success: false, message: 'Invalid email or password credentials.' });
      }
      return res.render('login', { title: 'Sign In', error: 'Invalid email or password.' });
    }

    const token = generateToken(user._id);
    res.cookie('token', token, COOKIE_OPTIONS);

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true, redirect: '/dashboard' });
    }
    res.redirect('/dashboard');
  } catch (error) {
    console.error('Login error:', error);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ success: false, message: error.message });
    }
    res.render('login', { title: 'Sign In', error: 'An unexpected error occurred during login.' });
  }
}

/**
 * GET /logout
 */
function logout(req, res) {
  res.clearCookie('token');
  res.redirect('/login');
}

/**
 * GET /settings
 */
async function showSettings(req, res) {
  const user = await User.findById(req.user._id);
  
  // Decrypt for masked display if present
  let hasGeminiKey = false;
  let hasOpenAiKey = false;
  let geminiKeyMasked = '';
  let openAiKeyMasked = '';

  if (user.aiSettings?.geminiApiKeyEncrypted) {
    const raw = customCrypto.decrypt(user.aiSettings.geminiApiKeyEncrypted);
    if (raw) {
      hasGeminiKey = true;
      geminiKeyMasked = `${raw.slice(0, 4)}••••••••${raw.slice(-4)}`;
    }
  }

  if (user.aiSettings?.openAiApiKeyEncrypted) {
    const raw = customCrypto.decrypt(user.aiSettings.openAiApiKeyEncrypted);
    if (raw) {
      hasOpenAiKey = true;
      openAiKeyMasked = `${raw.slice(0, 3)}••••••••${raw.slice(-4)}`;
    }
  }

  res.render('settings', {
    title: 'Profile & AI Settings | Audit & Tax Manager',
    user,
    hasGeminiKey,
    hasOpenAiKey,
    geminiKeyMasked,
    openAiKeyMasked,
    success: req.query.success || null,
    error: req.query.error || null
  });
}

/**
 * POST /api/settings/ai
 */
async function updateAiSettings(req, res) {
  try {
    const {
      preferredProvider,
      geminiApiKey,
      openAiApiKey,
      ollamaBaseUrl,
      ollamaModel,
      emailAlertsEnabled
    } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (preferredProvider && ['ollama', 'gemini', 'openai'].includes(preferredProvider)) {
      user.aiSettings.preferredProvider = preferredProvider;
    }

    if (ollamaBaseUrl) {
      user.aiSettings.ollamaBaseUrl = ollamaBaseUrl.trim();
    }

    if (ollamaModel) {
      user.aiSettings.ollamaModel = ollamaModel.trim();
    }

    // Encrypt keys before saving if provided and not masked placeholder
    if (geminiApiKey && !geminiApiKey.includes('••••')) {
      user.aiSettings.geminiApiKeyEncrypted = customCrypto.encrypt(geminiApiKey.trim());
    }

    if (openAiApiKey && !openAiApiKey.includes('••••')) {
      user.aiSettings.openAiApiKeyEncrypted = customCrypto.encrypt(openAiApiKey.trim());
    }

    if (emailAlertsEnabled !== undefined) {
      user.emailAlertsEnabled = emailAlertsEnabled === 'true' || emailAlertsEnabled === true;
    }

    await user.save();

    res.json({
      success: true,
      message: 'AI and profile settings successfully updated with AES-256 encryption.'
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * POST /api/settings/test-ai
 * Tests connectivity to current AI provider
 */
async function testAiConnection(req, res) {
  const startTime = Date.now();
  try {
    const { provider, baseUrl, model, apiKey } = req.body;
    const targetProvider = provider || req.user.aiSettings?.preferredProvider || 'ollama';

    if (targetProvider === 'ollama') {
      const targetUrl = (baseUrl || req.user.aiSettings?.ollamaBaseUrl || 'http://localhost:11434') + '/api/tags';
      const resp = await fetch(targetUrl, { signal: AbortSignal.timeout(5000) });
      const latency = Date.now() - startTime;
      if (resp.ok) {
        const data = await resp.json();
        const models = (data.models || []).map(m => m.name).join(', ') || 'None found';
        return res.json({
          success: true,
          provider: 'Ollama',
          message: `Connected successfully! Available models: ${models}`,
          latencyMs: latency
        });
      } else {
        return res.status(400).json({
          success: false,
          provider: 'Ollama',
          message: `Ollama returned HTTP ${resp.status}: ${resp.statusText}`
        });
      }
    } else if (targetProvider === 'gemini') {
      let keyToTest = apiKey;
      if (!keyToTest || keyToTest.includes('••••')) {
        keyToTest = customCrypto.decrypt(req.user.aiSettings?.geminiApiKeyEncrypted);
      }
      if (!keyToTest) {
        return res.status(400).json({ success: false, message: 'No Gemini API Key provided or stored.' });
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${keyToTest}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const latency = Date.now() - startTime;
      if (resp.ok) {
        return res.json({
          success: true,
          provider: 'Google Gemini',
          message: 'Gemini API Key validated successfully!',
          latencyMs: latency
        });
      } else {
        const err = await resp.text();
        return res.status(400).json({
          success: false,
          provider: 'Google Gemini',
          message: `Gemini verification failed (${resp.status}): Invalid API Key.`
        });
      }
    } else if (targetProvider === 'openai') {
      let keyToTest = apiKey;
      if (!keyToTest || keyToTest.includes('••••')) {
        keyToTest = customCrypto.decrypt(req.user.aiSettings?.openAiApiKeyEncrypted);
      }
      if (!keyToTest) {
        return res.status(400).json({ success: false, message: 'No OpenAI API Key provided or stored.' });
      }

      const resp = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${keyToTest}` },
        signal: AbortSignal.timeout(8000)
      });
      const latency = Date.now() - startTime;
      if (resp.ok) {
        return res.json({
          success: true,
          provider: 'OpenAI',
          message: 'OpenAI API Key authenticated successfully!',
          latencyMs: latency
        });
      } else {
        return res.status(400).json({
          success: false,
          provider: 'OpenAI',
          message: 'Invalid OpenAI API Key or unauthorized.'
        });
      }
    }

    res.status(400).json({ success: false, message: 'Unknown provider specified.' });
  } catch (err) {
    const latency = Date.now() - startTime;
    res.status(500).json({
      success: false,
      message: `Connection failed: ${err.message}`,
      latencyMs: latency
    });
  }
}

module.exports = {
  showLogin,
  showRegister,
  register,
  login,
  logout,
  showSettings,
  updateAiSettings,
  testAiConnection
};

