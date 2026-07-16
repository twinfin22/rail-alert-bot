ALTER TABLE poll_runs ADD COLUMN scheduled_for TEXT;
ALTER TABLE poll_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'github';
ALTER TABLE poll_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
ALTER TABLE poll_runs ADD COLUMN result_hash TEXT;
ALTER TABLE poll_runs ADD COLUMN failure_reason TEXT;

-- One authoritative record for each Railway provider/UTC-five-minute slot.
-- Legacy GitHub/manual runs use a private manual:<run_id> key instead, so the
-- old workflow-dispatch payload remains backwards compatible.
CREATE TABLE poll_slots (
  provider TEXT NOT NULL CHECK(provider IN ('bus','srt','ktx')),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('leased','accepted','no_work','failed')),
  source TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  run_id TEXT,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(provider, scheduled_for)
);
CREATE INDEX poll_slots_provider_latest ON poll_slots(provider, scheduled_for DESC);

-- Keep one subscription per person for an identical provider/query.
DELETE FROM watches
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM watches GROUP BY telegram_user_id, provider, query_key
);
CREATE UNIQUE INDEX watches_user_provider_query ON watches(telegram_user_id, provider, query_key);
