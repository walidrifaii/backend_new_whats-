const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Admin = require('../models/Admin');
const TokenSession = require('../models/TokenSession');

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const validSession = await TokenSession.isValid(token);
    if (!validSession) {
      return res.status(401).json({ error: 'Session expired. Please login again.' });
    }
    req.token = token;
    
    if (decoded.adminId) {
      const admin = await Admin.findById(decoded.adminId);
      if (!admin || !admin.isActive) {
        return res.status(401).json({ error: 'Admin not found or inactive' });
      }
      delete admin.password;
      req.user = admin;
      return next();
    }

    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }
    if (!user.authToken || user.authToken !== token) {
      return res.status(401).json({ error: 'Session revoked. Please login again.' });
    }

    delete user.password;
    delete user.authToken;
    user.isAdmin = false;
    req.user = user;
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

module.exports = authMiddleware;
