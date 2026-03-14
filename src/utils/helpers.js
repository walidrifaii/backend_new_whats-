/**
 * Renders a templated message by replacing {variable} placeholders
 * with values from the contact's data.
 *
 * @param {string} template - The message template, e.g. "Hello {name}, your code is {code}"
 * @param {object} variables - Key-value pairs for substitution
 * @returns {string} - The rendered message
 */
const renderTemplate = (template, variables = {}) => {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return variables[key] !== undefined ? variables[key] : match;
  });
};

/**
 * Normalizes a phone number to WhatsApp format (country code + number + @c.us)
 */
const normalizePhone = (phone) => {
  let cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.startsWith('0')) cleaned = cleaned.substring(1);
  if (!cleaned.includes('@')) return `${cleaned}@c.us`;
  return cleaned;
};

/**
 * Generates a random delay between min and max milliseconds
 */
const randomDelay = (min = 20000, max = 30000) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

/**
 * Sleep for a given number of milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = { renderTemplate, normalizePhone, randomDelay, sleep };
