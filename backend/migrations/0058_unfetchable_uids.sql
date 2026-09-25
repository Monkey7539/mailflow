-- Remember UIDs the server lists but will not hand over, so the integrity check stops
-- rediscovering the same gap forever.
--
-- Observed on a production iCloud account: five UIDs appear in both the flag FETCH and the
-- UID SEARCH, so the folder integrity check counts them as present on the server and
-- missing locally. It schedules a UID backfill, the backfill requests exactly those five,
-- the server returns nothing for any of them, zero rows are saved, and the next integrity
-- pass finds the same gap. Thirty-five cycles in five hours, and it would run forever:
--
--   Backfill: 5 missing of 22892 (22887 already in DB)
--   Backfill: 5/5 UID candidates processed; 0 messages saved
--
-- Note these are not phantom SEARCH results. The integrity check throws if SEARCH and the
-- flag FETCH disagree, so the server is consistent about their existing; it simply cannot
-- produce their content. Messages expunged server-side but still indexed look like this.
--
-- The backfill records a miss here per attempt. Once a UID has been asked for and refused
-- enough times, the integrity check stops counting it as missing, which is what breaks the
-- loop. Rows are scoped by uid_validity so a mailbox renumbering invalidates them, and
-- carry timestamps so a periodic retry can clear stale entries and let the server heal.

CREATE TABLE IF NOT EXISTS unfetchable_uids (
  account_id      UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  folder          VARCHAR(500) NOT NULL,
  uid             BIGINT NOT NULL,
  -- UIDs are only meaningful within a uidvalidity generation; if the server renumbers the
  -- mailbox, these rows describe UIDs that no longer exist and must not suppress anything.
  uid_validity    BIGINT,
  attempts        INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, folder, uid)
);

-- The integrity check reads this per account+folder on every pass, so keep that lookup cheap.
CREATE INDEX IF NOT EXISTS idx_unfetchable_uids_lookup
  ON unfetchable_uids (account_id, folder);
