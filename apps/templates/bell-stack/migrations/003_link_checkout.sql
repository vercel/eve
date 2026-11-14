CREATE TABLE IF NOT EXISTS bell_browser_privacy_guards (
  session_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
