-- phpMyAdmin import
-- Select the existing database first.
-- Maps schema.dbml names onto the live tables:
--   client       = users
--   OTP_NUMBER   = phone_numbers
--   App          = apps
--   plan         = plans
--   subscription = subscriptions

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

-- If tables already existed from an older import, add the new columns:
-- ALTER TABLE apps ADD COLUMN service VARCHAR(64) NULL;
-- ALTER TABLE users ADD COLUMN current_app_id CHAR(24) NULL;
-- ALTER TABLE subscriptions ADD COLUMN user_id CHAR(24) NULL;

INSERT IGNORE INTO plans
  (id, name, slug, message_quota, source_limit, amount, is_active, sort_order)
VALUES
  ('64a000000000000000000001', 'Mini', 'mini', 500, 1, 0.00, 1, 1),
  ('64a000000000000000000002', 'Medium', 'medium', 1000, 2, 0.00, 1, 2),
  ('64a000000000000000000003', 'Max', 'max', 1500, 3, 0.00, 1, 3);
