CREATE TABLE IF NOT EXISTS bell_onepassword_connections (
  owner text PRIMARY KEY,
  encrypted_state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bell_onepassword_tickets (
  hash text PRIMARY KEY,
  owner text NOT NULL REFERENCES bell_onepassword_connections(owner) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS bell_onepassword_ticket_expiry ON bell_onepassword_tickets(expires_at);

CREATE TABLE IF NOT EXISTS bell_onepassword_browser_guards (
  session_id text PRIMARY KEY,
  blocked_at timestamptz NOT NULL DEFAULT now()
);
