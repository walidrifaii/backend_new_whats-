const crypto = require('crypto');

const generateObjectId = () => crypto.randomBytes(12).toString('hex');

module.exports = {
  generateObjectId
};
