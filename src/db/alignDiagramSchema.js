const { query } = require('./mysql');

const tableExists = async (name) => {
  const rows = await query(
    `SELECT 1 AS ok
     FROM information_schema.tables
     WHERE table_schema = DATABASE() AND LOWER(table_name) = LOWER(?)
     LIMIT 1`,
    [String(name).replace(/`/g, '')]
  );
  return Boolean(rows[0]);
};

const columnExists = async (table, column) => {
  const rows = await query(
    `SELECT 1 AS ok
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND LOWER(table_name) = LOWER(?)
       AND LOWER(column_name) = LOWER(?)
     LIMIT 1`,
    [String(table).replace(/`/g, ''), column]
  );
  return Boolean(rows[0]);
};

const ignore = (err) => {
  const code = err?.code || '';
  const message = String(err?.message || '');
  return (
    code === 'ER_DUP_FIELDNAME' ||
    code === 'ER_DUP_KEYNAME' ||
    code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
    code === 'ER_TABLE_EXISTS_ERROR' ||
    code === 'ER_BAD_TABLE_ERROR' ||
    code === 'ER_DUP_ENTRY' ||
    message.includes('Duplicate') ||
    message.includes("Can't DROP") ||
    message.includes('already exists') ||
    message.includes('Unknown table')
  );
};

const run = async (sql) => {
  try {
    await query(sql);
  } catch (err) {
    if (!ignore(err)) throw err;
  }
};

const renameTable = async (from, to) => {
  if (!(await tableExists(from))) return;
  const toName = String(to).replace(/`/g, '');
  if (from.toLowerCase() === toName.toLowerCase()) return;
  if (await tableExists(toName)) return;
  await run(`RENAME TABLE \`${from}\` TO ${to}`);
};

const renameColumn = async (table, from, to, definition) => {
  if (!(await tableExists(table))) return;
  if (!(await columnExists(table, from))) return;
  if (await columnExists(table, to)) return;
  const quoted = table.includes('`') ? table : `\`${table}\``;
  await run(`ALTER TABLE ${quoted} CHANGE \`${from}\` \`${to}\` ${definition}`);
};

const dropForeignKeys = async (table) => {
  if (!(await tableExists(table))) return;
  const rows = await query(
    `SELECT CONSTRAINT_NAME AS name
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE()
       AND LOWER(TABLE_NAME) = LOWER(?)
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [table]
  );
  for (const row of rows) {
    await run(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${row.name}\``);
  }
};

const addColumn = async (table, name, definition) => {
  if (!(await tableExists(table))) return;
  if (await columnExists(table, name)) return;
  const quoted = table.includes('`') ? table : `\`${table}\``;
  await run(`ALTER TABLE ${quoted} ADD COLUMN \`${name}\` ${definition}`);
};

const migrateOwnerAndNumberColumns = async (table) => {
  if (!(await tableExists(table))) return;
  const hasUserId = await columnExists(table, 'user_id');
  const hasClientId = await columnExists(table, 'client_id');
  const hasOtpId = await columnExists(table, 'OTP_NUMBER_id');
  if (hasUserId && hasClientId && !hasOtpId) {
    await renameColumn(table, 'client_id', 'OTP_NUMBER_id', 'CHAR(24) NOT NULL');
    await renameColumn(table, 'user_id', 'client_id', 'CHAR(24) NOT NULL');
  } else if (hasUserId && !hasClientId) {
    await renameColumn(table, 'user_id', 'client_id', 'CHAR(24) NOT NULL');
  }
  await addColumn(table, 'App_id', 'CHAR(24) NULL');
};

/**
 * Make the live DB use the same table/field names as schema.dbml.
 * Extra WhatsApp columns (session_id, tokens, plan_status) are kept so the app still runs.
 */
const alignDiagramSchema = async () => {
  for (const table of ['campaigns', 'message_logs', 'message_jobs', 'message_job_items', 'contacts', 'apps', 'App']) {
    await dropForeignKeys(table);
  }
  await dropForeignKeys('phone_numbers');
  await dropForeignKeys('OTP_NUMBER');
  await dropForeignKeys('phone_number_users');
  await dropForeignKeys('user_sources');
  await dropForeignKeys('users');
  await dropForeignKeys('client');
  await dropForeignKeys('plans');
  await dropForeignKeys('plan');

  for (const table of ['campaigns', 'message_logs', 'message_jobs']) {
    await migrateOwnerAndNumberColumns(table);
  }
  if (await columnExists('contacts', 'user_id')) {
    await renameColumn('contacts', 'user_id', 'client_id', 'CHAR(24) NOT NULL');
  }
  if (await columnExists('message_job_items', 'user_id')) {
    await renameColumn('message_job_items', 'user_id', 'client_id', 'CHAR(24) NOT NULL');
  }

  const phoneTable = (await tableExists('phone_numbers'))
    ? 'phone_numbers'
    : ((await tableExists('OTP_NUMBER')) ? 'OTP_NUMBER' : null);
  if (phoneTable) {
    await renameColumn(phoneTable, 'client_id', 'session_id', 'VARCHAR(190) NOT NULL');
    await renameColumn(phoneTable, 'name', 'title', 'VARCHAR(120) NOT NULL');
    await renameColumn(phoneTable, 'phone', 'number', 'VARCHAR(190) NULL');
    await addColumn(phoneTable, 'session_id', 'VARCHAR(190) NULL');
    await addColumn(phoneTable, 'title', 'VARCHAR(120) NOT NULL DEFAULT \'\'');
    await addColumn(phoneTable, 'number', 'VARCHAR(190) NULL');
  }

  const userTable = (await tableExists('users'))
    ? 'users'
    : ((await tableExists('client')) ? 'client' : null);
  if (userTable) {
    await renameColumn(userTable, 'allow_source_switch', 'allow_service_switch', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await renameColumn(userTable, 'current_app_id', 'current_App_id', 'CHAR(24) NULL');
    await addColumn(userTable, 'allow_service_switch', 'BOOLEAN NOT NULL DEFAULT FALSE');
    await addColumn(userTable, 'current_App_id', 'CHAR(24) NULL');
  }

  const appTable = (await tableExists('apps'))
    ? 'apps'
    : ((await tableExists('App')) ? 'App' : null);
  if (appTable) {
    await renameColumn(appTable, 'user_id', 'client_id', 'CHAR(24) NOT NULL');
    await renameColumn(appTable, 'phone_number_id', 'OTP_NUMBER_id', 'CHAR(24) NOT NULL');
    await renameColumn(appTable, 'is_active', 'Active', 'BOOLEAN NOT NULL DEFAULT TRUE');
  }

  const planTable = (await tableExists('plans'))
    ? 'plans'
    : ((await tableExists('plan')) ? 'plan' : null);
  if (planTable) {
    await renameColumn(planTable, 'message_quota', 'credits', 'INT NOT NULL DEFAULT 0');
    await addColumn(planTable, 'credits', 'INT NOT NULL DEFAULT 0');
    await addColumn(planTable, 'amount', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00');
  }

  await renameTable('users', 'client');
  await renameTable('phone_numbers', '`OTP_NUMBER`');
  await renameTable('plans', 'plan');
  await renameTable('apps', '`App`');

  await run(`
    CREATE TABLE IF NOT EXISTS subscription (
      id CHAR(24) NOT NULL,
      client_id CHAR(24) NOT NULL,
      plan_id CHAR(24) NULL,
      credits INT NULL DEFAULT 0,
      amount DECIMAL(10,2) NULL DEFAULT 0.00,
      \`Active\` BOOLEAN NULL DEFAULT TRUE,
      created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_subscription_client (client_id),
      KEY idx_subscription_plan (plan_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  console.log('✅ Database tables aligned with dbdiagram (client, OTP_NUMBER, App, plan, subscription)');
};

module.exports = { alignDiagramSchema, tableExists, columnExists };
