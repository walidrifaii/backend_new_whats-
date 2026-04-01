const jwt = require('jsonwebtoken');

const getApiTokenExpiry = () => process.env.API_TOKEN_EXPIRES_IN || '365d';

const issueApiToken = (userId) => jwt.sign(
  { userId, tokenType: 'api' },
  process.env.JWT_SECRET,
  { expiresIn: getApiTokenExpiry() }
);

const issueDashboardToken = (userId) => jwt.sign(
  { userId, tokenType: 'dashboard' },
  process.env.JWT_SECRET,
  { expiresIn: '7d' }
);

module.exports = {
  issueApiToken,
  issueDashboardToken
};
