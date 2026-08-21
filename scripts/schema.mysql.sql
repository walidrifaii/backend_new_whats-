-- MySQL 8+ schema for WhatsApp SaaS backend
-- Mirrors existing MongoDB collections:
-- users, phone_numbers, phone_number_users, campaigns, contacts, message_logs

CREATE DATABASE IF NOT EXISTS whatsapp_saas
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE whatsapp_saas;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(24) NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'user') NOT NULL DEFAULT 'user',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  parent_user_id CHAR(24) NULL,
  source VARCHAR(64) NULL,
  allow_source_switch BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_parent_user_id (parent_user_id),
  UNIQUE KEY uq_users_parent_source (parent_user_id, source),
  KEY idx_users_allow_source_switch (allow_source_switch)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS plans (
  id CHAR(24) NOT NULL,
  name VARCHAR(64) NOT NULL,
  slug VARCHAR(32) NOT NULL,
  message_quota INT NOT NULL DEFAULT 500,
  source_limit INT NOT NULL DEFAULT 1,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plans_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_sources (
  user_id CHAR(24) NOT NULL,
  source VARCHAR(64) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  phone_number_id CHAR(24) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, source),
  KEY idx_user_sources_phone_number_id (phone_number_id),
  CONSTRAINT fk_user_sources_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS phone_numbers (
  id CHAR(24) NOT NULL,
  name VARCHAR(160) NOT NULL,
  phone VARCHAR(40) NULL,
  client_id VARCHAR(190) NOT NULL,
  status ENUM('disconnected', 'initializing', 'qr_ready', 'connected', 'auth_failure')
    NOT NULL DEFAULT 'disconnected',
  qr_code LONGTEXT NULL,
  session_path VARCHAR(500) NULL,
  last_connected DATETIME NULL,
  messages_sent INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  plan_id CHAR(24) NULL,
  plan_status VARCHAR(16) NOT NULL DEFAULT 'none',
  message_balance INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_phone_numbers_client_id (client_id),
  KEY idx_phone_numbers_plan_id (plan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS phone_number_users (
  phone_number_id CHAR(24) NOT NULL,
  user_id CHAR(24) NOT NULL,
  assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (phone_number_id, user_id),
  KEY idx_phone_number_users_user_id (user_id),
  CONSTRAINT fk_phone_number_users_number
    FOREIGN KEY (phone_number_id) REFERENCES phone_numbers (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_phone_number_users_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS apps (
  id CHAR(24) NOT NULL,
  phone_number_id CHAR(24) NOT NULL,
  user_id CHAR(24) NOT NULL,
  service VARCHAR(64) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  balance INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_apps_client_service (user_id, service),
  KEY idx_apps_phone_number_id (phone_number_id),
  KEY idx_apps_user_id (user_id),
  CONSTRAINT fk_apps_phone_number
    FOREIGN KEY (phone_number_id) REFERENCES phone_numbers (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_apps_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subscriptions (
  id CHAR(24) NOT NULL,
  user_id CHAR(24) NOT NULL,
  plan_id CHAR(24) NULL,
  credits INT NOT NULL DEFAULT 0,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_subscriptions_user_id (user_id),
  KEY idx_subscriptions_plan_id (plan_id),
  CONSTRAINT fk_subscriptions_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_subscriptions_plan
    FOREIGN KEY (plan_id) REFERENCES plans (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaigns (
  id CHAR(24) NOT NULL,
  user_id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
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
  source VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_campaigns_user_id (user_id),
  KEY idx_campaigns_client_id (client_id),
  CONSTRAINT fk_campaigns_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_campaigns_client
    FOREIGN KEY (client_id) REFERENCES phone_numbers (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contacts (
  id CHAR(24) NOT NULL,
  user_id CHAR(24) NOT NULL,
  campaign_id CHAR(24) NOT NULL,
  name VARCHAR(200) NULL,
  phone VARCHAR(40) NOT NULL,
  variables JSON NULL,
  status ENUM('pending', 'sent', 'failed', 'skipped') NOT NULL DEFAULT 'pending',
  sent_at DATETIME NULL,
  error TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_contacts_campaign_status (campaign_id, status),
  KEY idx_contacts_campaign_phone (campaign_id, phone),
  KEY idx_contacts_user_id (user_id),
  CONSTRAINT fk_contacts_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_contacts_campaign
    FOREIGN KEY (campaign_id) REFERENCES campaigns (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_logs (
  id CHAR(24) NOT NULL,
  user_id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  campaign_id CHAR(24) NULL,
  contact_id CHAR(24) NULL,
  phone VARCHAR(40) NOT NULL,
  message TEXT NOT NULL,
  direction ENUM('outgoing', 'incoming') NOT NULL DEFAULT 'outgoing',
  status ENUM('sent', 'failed', 'received') NOT NULL DEFAULT 'sent',
  whatsapp_message_id VARCHAR(255) NULL,
  error TEXT NULL,
  source VARCHAR(64) NULL,
  timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_message_logs_user_timestamp (user_id, timestamp),
  KEY idx_message_logs_campaign_timestamp (campaign_id, timestamp),
  KEY idx_message_logs_client_timestamp (client_id, timestamp),
  KEY idx_message_logs_user_source (user_id, source),
  CONSTRAINT fk_message_logs_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_message_logs_client
    FOREIGN KEY (client_id) REFERENCES phone_numbers (id)
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
  user_id CHAR(24) NOT NULL,
  client_id CHAR(24) NOT NULL,
  message TEXT NOT NULL,
  media_url VARCHAR(2048) NULL,
  status ENUM('queued', 'running', 'completed', 'failed', 'cancelled')
    NOT NULL DEFAULT 'queued',
  min_delay INT NOT NULL DEFAULT 20000,
  max_delay INT NOT NULL DEFAULT 30000,
  spread_hours DECIMAL(8,2) NOT NULL DEFAULT 16,
  estimated_completed_at DATETIME NULL,
  total_count INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  pending_count INT NOT NULL DEFAULT 0,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_message_jobs_user_id (user_id),
  KEY idx_message_jobs_client_id (client_id),
  KEY idx_message_jobs_status (status),
  CONSTRAINT fk_message_jobs_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_message_jobs_client
    FOREIGN KEY (client_id) REFERENCES phone_numbers (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS message_job_items (
  id CHAR(24) NOT NULL,
  job_id CHAR(24) NOT NULL,
  user_id CHAR(24) NOT NULL,
  phone VARCHAR(40) NOT NULL,
  status ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
  whatsapp_message_id VARCHAR(255) NULL,
  error TEXT NULL,
  scheduled_at DATETIME NULL,
  sent_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_message_job_items_job_status (job_id, status),
  KEY idx_message_job_items_user_id (user_id),
  KEY idx_message_job_items_scheduled (job_id, status, scheduled_at),
  CONSTRAINT fk_message_job_items_job
    FOREIGN KEY (job_id) REFERENCES message_jobs (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_message_job_items_user
    FOREIGN KEY (user_id) REFERENCES users (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
