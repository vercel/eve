CREATE TABLE IF NOT EXISTS bell_monitors (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  owner_id text NOT NULL,
  operation text NOT NULL,
  query text NOT NULL,
  destination jsonb NOT NULL,
  remote_id text UNIQUE,
  status text NOT NULL CHECK (status IN ('prepared','dispatched','uncertain','active','cancel_pending','cancelled','failed')),
  stopped boolean NOT NULL DEFAULT false,
  health text,
  health_at timestamptz,
  last_scan_at timestamptz,
  scan_anchor text,
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  recovery_gap boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, owner_id, operation)
);
CREATE TABLE IF NOT EXISTS bell_monitor_inbox (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bell_monitor_events (
  watch_id uuid NOT NULL REFERENCES bell_monitors(id),
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watch_id, event_id)
);
CREATE TABLE IF NOT EXISTS bell_monitor_jobs (
  id text PRIMARY KEY,
  watch_id uuid REFERENCES bell_monitors(id),
  kind text NOT NULL CHECK (kind IN ('inbox','reconcile','sync','send','cancel')),
  payload jsonb NOT NULL DEFAULT '{}',
  next_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  failed boolean NOT NULL DEFAULT false,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bell_monitor_jobs_due ON bell_monitor_jobs(next_at) WHERE NOT failed;
CREATE INDEX IF NOT EXISTS bell_monitors_owner ON bell_monitors(issuer, owner_id, created_at DESC);
