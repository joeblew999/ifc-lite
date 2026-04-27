-- Telemetry events from the desktop app.
-- Queryable via: wrangler d1 execute ifc-lite-telemetry --remote --command "..."
-- or via the CF MCP d1_database_query tool (database_id: d7f1c6da-e4c0-46d8-b1bd-2f434382c542).

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_version TEXT    NOT NULL,
  os          TEXT    NOT NULL,
  arch        TEXT    NOT NULL DEFAULT '',
  level       TEXT    NOT NULL,
  message     TEXT    NOT NULL,
  timestamp   TEXT    NOT NULL,
  session_id  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_level   ON events (level);
CREATE INDEX IF NOT EXISTS idx_events_ts      ON events (timestamp);
CREATE INDEX IF NOT EXISTS idx_events_version ON events (app_version);
