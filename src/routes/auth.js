const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Admin = require('../models/Admin');
const TokenSession = require('../models/TokenSession');
const authMiddleware = require('../middleware/auth');

const getTokenExpiryDate = (token) => {
  const decoded = jwt.decode(token);
  if (!decoded?.exp) return null;
  return new Date(decoded.exp * 1000);
};

const isJwtUsable = (token) => {
  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return true;
  } catch (_) {
    return false;
  }
};

const signPermanentUserToken = (userId) => {
  // Intentionally no expiresIn: token is stable across logins.
  return jwt.sign({ userId, type: 'user' }, process.env.JWT_SECRET);
};

// POST /api/auth/register
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, email, password } = req.body;
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });

    const user = await User.create({ name, email, password });
    const token = signPermanentUserToken(user._id);
    await User.saveToken(user._id, token);
    await TokenSession.createOrUpdate({
      token,
      ownerType: 'user',
      ownerId: user._id,
      expiresAt: getTokenExpiryDate(token)
    });
    res.status(201).json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password } = req.body;
    // Regular user login only (users table)
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const isMatch = await user.comparePassword(password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid credentials' });

    let token = user.authToken;
    if (!token || !isJwtUsable(token)) {
      token = signPermanentUserToken(user._id);
      await User.saveToken(user._id, token);
    }
    await TokenSession.createOrUpdate({
      token,
      ownerType: 'user',
      ownerId: user._id,
      expiresAt: getTokenExpiryDate(token)
    });
    return res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/admin-login
router.post('/admin-login', [
  body('email').isEmail(),
  body('password').notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password } = req.body;
    const admin = await Admin.findByEmail(email);
    if (!admin) return res.status(401).json({ error: 'Invalid admin credentials' });

    const isMatch = await Admin.comparePassword(admin, password);
    if (!isMatch) return res.status(401).json({ error: 'Invalid admin credentials' });
    if (!admin.isActive) return res.status(401).json({ error: 'Admin is inactive' });

    // If legacy plain-text password was used, transparently upgrade to bcrypt.
    if (admin.password === String(password || '')) {
      await Admin.updatePasswordHash(admin._id, password);
    }

    const token = jwt.sign({ adminId: admin._id, type: 'admin' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    await TokenSession.createOrUpdate({
      token,
      ownerType: 'admin',
      ownerId: admin._id,
      expiresAt: getTokenExpiryDate(token)
    });
    const safeAdmin = { ...admin };
    delete safeAdmin.password;
    return res.json({ token, user: safeAdmin });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, async (req, res) => {
  try {
    if (req.token) {
      await TokenSession.revoke(req.token);
    }
    return res.json({ message: 'Logged out successfully' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
