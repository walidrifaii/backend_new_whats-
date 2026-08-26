/**
 * Drop unused marketing tables and related message_logs columns.
 * Runs on API boot via alignDiagramSchema.
 */
const dropUnusedMarketingSchema = async ({ run, dropForeignKeys, columnExists, tableExists }) => {
  for (const table of ['message_job_items', 'message_jobs', 'contacts', 'campaigns', 'message_logs']) {
    await dropForeignKeys(table);
  }

  if (await tableExists('message_logs')) {
    if (await columnExists('message_logs', 'campaign_id')) {
      await run('ALTER TABLE message_logs DROP COLUMN campaign_id');
    }
    if (await columnExists('message_logs', 'contact_id')) {
      await run('ALTER TABLE message_logs DROP COLUMN contact_id');
    }
  }

  await run('DROP TABLE IF EXISTS message_job_items');
  await run('DROP TABLE IF EXISTS message_jobs');
  await run('DROP TABLE IF EXISTS contacts');
  await run('DROP TABLE IF EXISTS campaigns');
};

module.exports = { dropUnusedMarketingSchema };
