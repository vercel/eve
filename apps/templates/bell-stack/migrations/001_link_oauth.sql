BEGIN;

CREATE TABLE IF NOT EXISTS bell_link_grants (
  issuer text NOT NULL,
  principal_id text NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('active', 'reconnect', 'disconnecting', 'disconnected')),
  encrypted_tokens text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer, principal_id)
);

CREATE TABLE IF NOT EXISTS bell_link_oauth_attempts (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  principal_id text NOT NULL,
  generation integer NOT NULL,
  state_hash text NOT NULL UNIQUE,
  callback_hash text NOT NULL UNIQUE,
  result_hash text,
  encrypted_secrets text,
  status text NOT NULL CHECK (status IN ('pending', 'forwarded', 'exchanging', 'completed', 'failed')),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (issuer, principal_id) REFERENCES bell_link_grants (issuer, principal_id)
);
CREATE INDEX IF NOT EXISTS bell_link_attempts_expiry ON bell_link_oauth_attempts (expires_at);

COMMIT;
