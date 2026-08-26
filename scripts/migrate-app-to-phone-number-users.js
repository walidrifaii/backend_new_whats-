/**
 * One-shot: rename App → phone_number_users and drop old thin assignment table.
 * Safe to re-run. Prefer restarting the API (alignDiagramSchema runs this on boot).
 *
 *   node scripts/migrate-app-to-phone-number-users.js
 */
require('dotenv').config();
const { testConnection } = require('../src/db/mysql');
const { migrateAppToPhoneNumberUsers, alignDiagramSchema } = require('../src/db/alignDiagramSchema');
const App = require('../src/models/App');

(async () => {
  await testConnection();
  await alignDiagramSchema();
  await migrateAppToPhoneNumberUsers();
  await App.ensureTable();
  console.log('Done: assignment table is phone_number_users');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
