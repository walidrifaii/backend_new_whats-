-- phpMyAdmin import — same tables AND same fields as schema.dbml
-- Select an EMPTY database first, then Import this file.

-- client: id, name, email, password, is_active, allow_service_switch, current_App_id, created_at
CREATE TABLE IF NOT EXISTS client (
  id CHAR(24) NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  allow_service_switch BOOLEAN NOT NULL DEFAULT FALSE,
  `current_App_id` CHAR(24) NULL,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OTP_NUMBER: id, title, number, status, qr_code, session_path, last_connected, is_active, created_at
CREATE TABLE IF NOT EXISTS `OTP_NUMBER` (
  id CHAR(24) NOT NULL,
  title VARCHAR(120) NOT NULL,
  number VARCHAR(190) NOT NULL,
  status ENUM('disconnected', 'initializing', 'qr_ready', 'connected', 'auth_failure')
    NULL DEFAULT 'disconnected',
  qr_code LONGTEXT NULL,
  session_path VARCHAR(500) NULL,
  last_connected DATETIME NULL,
  is_active BOOLEAN NULL DEFAULT TRUE,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_otp_number (number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- plan: id, name, credits, amount, source_limit, is_active
CREATE TABLE IF NOT EXISTS plan (
  id CHAR(24) NOT NULL,
  name VARCHAR(120) NOT NULL,
  credits INT NULL,
  amount DECIMAL(10,2) NULL,
  source_limit INT NULL DEFAULT 1,
  is_active BOOLEAN NULL DEFAULT TRUE,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- phone_number_users: client ↔ number ↔ project (formerly App)
CREATE TABLE IF NOT EXISTS phone_number_users (
  id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  `OTP_NUMBER_id` CHAR(24) NOT NULL,
  service VARCHAR(64) NOT NULL,
  `Active` BOOLEAN NULL DEFAULT TRUE,
  balance INT NULL DEFAULT 0,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pnu_client_number_service (client_id, `OTP_NUMBER_id`, service),
  KEY idx_pnu_otp_number (`OTP_NUMBER_id`),
  KEY idx_pnu_client (client_id),
  CONSTRAINT fk_pnu_client
    FOREIGN KEY (client_id) REFERENCES client (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_pnu_otp_number
    FOREIGN KEY (`OTP_NUMBER_id`) REFERENCES `OTP_NUMBER` (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE client
  ADD CONSTRAINT fk_client_current_app
    FOREIGN KEY (`current_App_id`) REFERENCES phone_number_users (id)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- subscription: id, client_id, plan_id, credits, amount, Active, created_at
CREATE TABLE IF NOT EXISTS subscription (
  id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  plan_id CHAR(24) NULL,
  credits INT NULL,
  amount DECIMAL(10,2) NULL,
  `Active` BOOLEAN NULL DEFAULT TRUE,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_subscription_client (client_id),
  KEY idx_subscription_plan (plan_id),
  CONSTRAINT fk_subscription_client
    FOREIGN KEY (client_id) REFERENCES client (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_subscription_plan
    FOREIGN KEY (plan_id) REFERENCES plan (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- campaigns: same fields as dbdiagram
CREATE TABLE IF NOT EXISTS campaigns (
  id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  `App_id` CHAR(24) NOT NULL,
  `OTP_NUMBER_id` CHAR(24) NOT NULL,
  name VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  media_url VARCHAR(2048) NULL,
  media_type ENUM('image', 'video', 'document') NULL,
  status ENUM('draft', 'running', 'paused', 'completed', 'failed')
    NOT NULL DEFAULT 'draft',
  min_delay INT NOT NULL DEFAULT 20000,
  max_delay INT NOT NULL DEFAULT 30000,
  total_contacts INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  pending_count INT NOT NULL DEFAULT 0,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_campaigns_client (client_id),
  KEY idx_campaigns_app (`App_id`),
  KEY idx_campaigns_otp (`OTP_NUMBER_id`),
  CONSTRAINT fk_campaigns_client
    FOREIGN KEY (client_id) REFERENCES client (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_campaigns_app
    FOREIGN KEY (`App_id`) REFERENCES phone_number_users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_campaigns_otp
    FOREIGN KEY (`OTP_NUMBER_id`) REFERENCES `OTP_NUMBER` (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contacts (
  id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  campaign_id CHAR(24) NOT NULL,
  name VARCHAR(200) NULL,
  phone VARCHAR(40) NOT NULL,
  variables JSON NULL,
  status ENUM('pending', 'sent', 'failed', 'skipped') NULL DEFAULT 'pending',
  sent_at DATETIME NULL,
  error TEXT NULL,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_contacts_campaign_status (campaign_id, status),
  KEY idx_contacts_campaign_phone (campaign_id, phone),
  KEY idx_contacts_client (client_id),
  CONSTRAINT fk_contacts_client
    FOREIGN KEY (client_id) REFERENCES client (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_contacts_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_logs (
  id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  `App_id` CHAR(24) NULL,
  `OTP_NUMBER_id` CHAR(24) NOT NULL,
  campaign_id CHAR(24) NULL,
  contact_id CHAR(24) NULL,
  phone VARCHAR(40) NOT NULL,
  message TEXT NOT NULL,
  direction ENUM('outgoing', 'incoming') NULL DEFAULT 'outgoing',
  status ENUM('sent', 'failed', 'received') NULL DEFAULT 'sent',
  whatsapp_message_id VARCHAR(255) NULL,
  error TEXT NULL,
  timestamp DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_message_logs_client_time (client_id, timestamp),
  KEY idx_message_logs_otp_time (`OTP_NUMBER_id`, timestamp),
  KEY idx_message_logs_campaign_time (campaign_id, timestamp),
  CONSTRAINT fk_message_logs_client
    FOREIGN KEY (client_id) REFERENCES client (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_message_logs_app
    FOREIGN KEY (`App_id`) REFERENCES phone_number_users (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_message_logs_otp
    FOREIGN KEY (`OTP_NUMBER_id`) REFERENCES `OTP_NUMBER` (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_message_logs_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_message_logs_contact
    FOREIGN KEY (contact_id) REFERENCES contacts (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_jobs (
  id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  `App_id` CHAR(24) NULL,
  `OTP_NUMBER_id` CHAR(24) NOT NULL,
  message TEXT NOT NULL,
  media_url VARCHAR(2048) NULL,
  status ENUM('queued', 'running', 'completed', 'failed', 'cancelled')
    NULL DEFAULT 'queued',
  min_delay INT NULL DEFAULT 20000,
  max_delay INT NULL DEFAULT 30000,
  spread_hours DECIMAL(8,2) NULL DEFAULT 16,
  total_count INT NULL DEFAULT 0,
  sent_count INT NULL DEFAULT 0,
  failed_count INT NULL DEFAULT 0,
  pending_count INT NULL DEFAULT 0,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_message_jobs_client (client_id),
  KEY idx_message_jobs_otp (`OTP_NUMBER_id`),
  KEY idx_message_jobs_status (status),
  CONSTRAINT fk_message_jobs_client
    FOREIGN KEY (client_id) REFERENCES client (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_message_jobs_app
    FOREIGN KEY (`App_id`) REFERENCES phone_number_users (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_message_jobs_otp
    FOREIGN KEY (`OTP_NUMBER_id`) REFERENCES `OTP_NUMBER` (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_job_items (
  id CHAR(24) NOT NULL,
  job_id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  status ENUM('pending', 'sent', 'failed') NULL DEFAULT 'pending',
  whatsapp_message_id VARCHAR(255) NULL,
  error TEXT NULL,
  scheduled_at DATETIME NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_message_job_items_job_status (job_id, status),
  KEY idx_message_job_items_client (client_id),
  KEY idx_message_job_items_scheduled (job_id, status, scheduled_at),
  CONSTRAINT fk_message_job_items_job
    FOREIGN KEY (job_id) REFERENCES message_jobs (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_message_job_items_client
    FOREIGN KEY (client_id) REFERENCES client (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admins (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  is_active BOOLEAN NULL DEFAULT TRUE,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS token_sessions (
  id INT NOT NULL AUTO_INCREMENT,
  token_hash CHAR(64) NOT NULL,
  token TEXT NOT NULL,
  owner_type VARCHAR(20) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  is_active BOOLEAN NULL DEFAULT TRUE,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_token_hash (token_hash),
  KEY idx_owner (owner_type, owner_id),
  KEY idx_active_expiry (is_active, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO plan (id, name, credits, amount, source_limit, is_active)
VALUES
  ('64a000000000000000000001', 'Mini', 500, 0.00, 1, 1),
  ('64a000000000000000000002', 'Medium', 1000, 0.00, 2, 1),
  ('64a000000000000000000003', 'Max', 1500, 0.00, 3, 1);
