const adminMiddleware = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    if (!(req.user.isAdmin || req.user.role === 'admin')) {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports = adminMiddleware;
