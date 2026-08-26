/** Core table names. OTP_NUMBER stays quoted (MySQL case). */
module.exports = {
  CLIENT: 'client',
  OTP_NUMBER: '`OTP_NUMBER`',
  /** Client ↔ WhatsApp number ↔ project (service). Formerly named `App`. */
  APP: 'phone_number_users',
  PLAN: 'plan',
  SUBSCRIPTION: 'subscription'
};
