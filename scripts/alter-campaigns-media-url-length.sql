-- Run once if media_url was truncated or INSERT failed for long CDN URLs.
-- MySQL / MariaDB:
ALTER TABLE campaigns
  MODIFY COLUMN media_url VARCHAR(2048) NULL;
