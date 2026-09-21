/**
 * Wipe all WhatsApp session folders and mark numbers disconnected in DB.
 *
 * Local:  node scripts/clear-all-sessions.js
 * Docker: docker exec -it <container> node scripts/clear-all-sessions.js
 *
 * Prefer POST /api/admin/sessions/clear-all while the app is running
 * (also stops live Chromium). This script is for offline / shell wipe.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { testConnection } = require('../src/db/mysql');
const WhatsAppClientModel = require('../src/models/WhatsAppClient');

const SESSIONS_DIR = process.env.SESSIONS_DIR
  ? path.resolve(process.env.SESSIONS_DIR)
  : path.resolve(__dirname, '../sessions');

async function main() {
  console.log(`📁 Sessions dir: ${SESSIONS_DIR}`);

  let removed = 0;
  if (fs.existsSync(SESSIONS_DIR)) {
    for (const name of fs.readdirSync(SESSIONS_DIR)) {
      const full = path.join(SESSIONS_DIR, name);
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
      console.log(`🗑️  Removed ${full}`);
    }
  } else {
    console.log('No sessions directory found.');
  }

  await testConnection();
  const clients = await WhatsAppClientModel.find({ isActive: true });
  await Promise.all(
    clients.map((c) =>
      WhatsAppClientModel.findOneAndUpdate(
        { clientId: c.clientId },
        { status: 'disconnected', qrCode: null, phone: '' }
      )
    )
  );

  console.log(`✅ Removed ${removed} path(s); reset ${clients.length} number(s) to disconnected`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
