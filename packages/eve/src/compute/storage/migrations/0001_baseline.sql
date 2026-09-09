-- v1 baseline. Apply only through the compute migration runner on a new database.
CREATE SCHEMA compute;
SET LOCAL search_path = compute, public;

CREATE TABLE schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE namespaces (
  namespace_id uuid PRIMARY KEY,
  project_id text NOT NULL,
  deployment_epoch bigint NOT NULL DEFAULT 0 CHECK (deployment_epoch >= 0),
  desired_deployment text,
  admission_mode text NOT NULL DEFAULT 'open'
    CHECK (admission_mode IN ('open', 'staging', 'frozen')),
  quota_bytes bigint NOT NULL DEFAULT 10737418240 CHECK (quota_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE namespace_usage (
  namespace_id uuid PRIMARY KEY REFERENCES namespaces(namespace_id),
  used_bytes bigint NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
);

CREATE TABLE deployments (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('registered', 'ready', 'retired')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, digest)
);

ALTER TABLE namespaces ADD CONSTRAINT namespace_deployment
  FOREIGN KEY (namespace_id, desired_deployment)
  REFERENCES deployments(namespace_id, digest);

CREATE TABLE payloads (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  payload_id uuid NOT NULL,
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  codec text NOT NULL CHECK (codec = 'eve-value-v1'),
  body bytea NOT NULL CHECK (octet_length(body) <= 16777216),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, payload_id)
);

CREATE INDEX payloads_hash ON payloads(namespace_id, content_hash);

CREATE TABLE workers (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  worker_id uuid NOT NULL,
  deployment_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'draining', 'dead')),
  heartbeat_at timestamptz NOT NULL,
  cell_slots integer NOT NULL CHECK (cell_slots >= 0),
  effect_slots integer NOT NULL CHECK (effect_slots >= 0),
  PRIMARY KEY (namespace_id, worker_id),
  FOREIGN KEY (namespace_id, deployment_digest) REFERENCES deployments(namespace_id, digest)
);

CREATE INDEX workers_ready ON workers(namespace_id, deployment_digest, heartbeat_at)
  WHERE status = 'ready';

CREATE TABLE cells (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  cell_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('cell', 'resumable_task')),
  definition_id text NOT NULL,
  cell_key text NOT NULL CHECK (octet_length(cell_key) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'quarantined', 'terminal')),
  state_ref uuid,
  state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  deployment_digest text NOT NULL,
  adopted_epoch bigint NOT NULL CHECK (adopted_epoch >= 0),
  owner_id uuid,
  assignment_id uuid,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until timestamptz,
  next_message_seq bigint NOT NULL DEFAULT 1 CHECK (next_message_seq > 0),
  processed_seq bigint NOT NULL DEFAULT 0 CHECK (processed_seq >= 0),
  next_event_seq bigint NOT NULL DEFAULT 1 CHECK (next_event_seq > 0),
  ready_at timestamptz,
  terminal_at timestamptz,
  PRIMARY KEY (namespace_id, cell_id),
  UNIQUE (namespace_id, definition_id, cell_key),
  FOREIGN KEY (namespace_id, state_ref) REFERENCES payloads(namespace_id, payload_id),
  FOREIGN KEY (namespace_id, deployment_digest) REFERENCES deployments(namespace_id, digest),
  FOREIGN KEY (namespace_id, owner_id) REFERENCES workers(namespace_id, worker_id),
  CHECK (processed_seq < next_message_seq),
  CHECK ((owner_id IS NULL AND assignment_id IS NULL AND lease_until IS NULL)
      OR (owner_id IS NOT NULL AND assignment_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((state_ref IS NULL AND state_version = 0)
      OR (state_ref IS NOT NULL AND state_version > 0)),
  CHECK (kind <> 'resumable_task' OR state_ref IS NULL)
);

CREATE INDEX cells_ready ON cells(namespace_id, ready_at, cell_id)
  WHERE status = 'active' AND ready_at IS NOT NULL;
CREATE INDEX cells_expired ON cells(namespace_id, lease_until)
  WHERE owner_id IS NOT NULL;

CREATE TABLE messages (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  message_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  delivery_key text NOT NULL CHECK (octet_length(delivery_key) BETWEEN 1 AND 512),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  origin jsonb NOT NULL CHECK (jsonb_typeof(origin) = 'object'),
  original_ref uuid NOT NULL,
  payload_ref uuid NOT NULL,
  message_version integer NOT NULL CHECK (message_version > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled')),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  applied_at timestamptz,
  PRIMARY KEY (namespace_id, message_id),
  UNIQUE (namespace_id, cell_id, sequence),
  UNIQUE (namespace_id, cell_id, delivery_key),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, original_ref) REFERENCES payloads(namespace_id, payload_id),
  FOREIGN KEY (namespace_id, payload_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE INDEX messages_head ON messages(namespace_id, cell_id, sequence)
  WHERE status = 'pending';

CREATE TABLE effects (
  namespace_id uuid NOT NULL,
  effect_id uuid NOT NULL,
  owner_cell_id uuid NOT NULL,
  effect_key text NOT NULL CHECK (octet_length(effect_key) BETWEEN 1 AND 512),
  definition_id text NOT NULL,
  input_version integer NOT NULL CHECK (input_version > 0),
  input_ref uuid NOT NULL,
  input_hash bytea NOT NULL CHECK (octet_length(input_hash) = 32),
  deployment_digest text NOT NULL,
  logical_generation bigint NOT NULL CHECK (logical_generation >= 0),
  retry_mode text NOT NULL CHECK (retry_mode IN ('manual', 'idempotent')),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 5),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 900000),
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'running', 'retry_wait', 'succeeded', 'failed',
                     'cancelled', 'indeterminate')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  attempt_id uuid,
  owner_id uuid,
  assignment_id uuid,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until timestamptz,
  ready_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deadline timestamptz NOT NULL,
  cancel_requested boolean NOT NULL DEFAULT false,
  authorized_attempt integer CHECK (authorized_attempt > 0),
  target_output_version integer NOT NULL CHECK (target_output_version > 0),
  result_ref uuid,
  output_version integer CHECK (output_version > 0),
  failure jsonb,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (namespace_id, effect_id),
  UNIQUE (namespace_id, owner_cell_id, effect_key),
  FOREIGN KEY (namespace_id, owner_cell_id) REFERENCES cells(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, input_ref) REFERENCES payloads(namespace_id, payload_id),
  FOREIGN KEY (namespace_id, result_ref) REFERENCES payloads(namespace_id, payload_id),
  FOREIGN KEY (namespace_id, deployment_digest) REFERENCES deployments(namespace_id, digest),
  FOREIGN KEY (namespace_id, owner_id) REFERENCES workers(namespace_id, worker_id),
  CHECK ((owner_id IS NULL AND assignment_id IS NULL AND lease_until IS NULL)
      OR (owner_id IS NOT NULL AND assignment_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status <> 'succeeded' OR (result_ref IS NOT NULL AND output_version IS NOT NULL)),
  CHECK (retry_mode <> 'manual' OR max_attempts = 1)
);

CREATE INDEX effects_ready ON effects(namespace_id, ready_at, effect_id)
  WHERE status IN ('ready', 'retry_wait');
CREATE INDEX effects_expired ON effects(namespace_id, lease_until)
  WHERE status = 'running';

CREATE TABLE effect_attempts (
  namespace_id uuid NOT NULL,
  effect_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  execution_epoch bigint NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'unknown')),
  result_ref uuid,
  PRIMARY KEY (namespace_id, attempt_id),
  UNIQUE (namespace_id, effect_id, attempt_number),
  FOREIGN KEY (namespace_id, effect_id) REFERENCES effects(namespace_id, effect_id),
  FOREIGN KEY (namespace_id, result_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE TABLE outbox (
  namespace_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  source_cell_id uuid NOT NULL,
  delivery_key text NOT NULL,
  target_definition text NOT NULL,
  target_key text NOT NULL,
  message_version integer NOT NULL CHECK (message_version > 0),
  payload_ref uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  origin jsonb NOT NULL CHECK (jsonb_typeof(origin) = 'object'),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'sending', 'sent', 'blocked')),
  ready_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_id uuid,
  claim_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace_id, delivery_id),
  UNIQUE (namespace_id, source_cell_id, delivery_key),
  FOREIGN KEY (namespace_id, source_cell_id) REFERENCES cells(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, payload_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE INDEX outbox_ready ON outbox(namespace_id, ready_at, delivery_id)
  WHERE status = 'ready';
CREATE INDEX outbox_expired ON outbox(namespace_id, claim_until)
  WHERE status = 'sending';

CREATE TABLE timers (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  timer_key text NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  deadline timestamptz NOT NULL,
  message_version integer NOT NULL CHECK (message_version > 0),
  payload_ref uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('armed', 'delivered', 'cancelled')),
  PRIMARY KEY (namespace_id, cell_id, timer_key),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, payload_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE INDEX timers_due ON timers(namespace_id, deadline) WHERE status = 'armed';

CREATE TABLE events (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id uuid NOT NULL,
  append_key text NOT NULL,
  payload_ref uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  source_operation_id uuid NOT NULL,
  source_attempt_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, cell_id, sequence),
  UNIQUE (namespace_id, cell_id, append_key),
  UNIQUE (namespace_id, event_id),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, payload_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE TABLE history (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  commit_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('append', 'compact', 'clear', 'import')),
  payload_ref uuid NOT NULL,
  PRIMARY KEY (namespace_id, cell_id, revision),
  UNIQUE (namespace_id, cell_id, commit_key),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, payload_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE TABLE aliases (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  alias text NOT NULL,
  cell_id uuid,
  generation bigint NOT NULL CHECK (generation > 0),
  PRIMARY KEY (namespace_id, alias),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id)
);

CREATE TABLE public_ids (
  namespace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('session', 'task')),
  public_id text NOT NULL,
  cell_id uuid NOT NULL,
  PRIMARY KEY (namespace_id, kind, public_id),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id)
);

CREATE TABLE resumable_tasks (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  definition_id text NOT NULL,
  input_version integer NOT NULL CHECK (input_version > 0),
  input_ref uuid NOT NULL,
  start_key text NOT NULL,
  start_hash bytea NOT NULL CHECK (octet_length(start_hash) = 32),
  checkpoint_ref uuid,
  checkpoint_version integer NOT NULL DEFAULT 0 CHECK (checkpoint_version >= 0),
  checkpoint_revision bigint NOT NULL DEFAULT 0 CHECK (checkpoint_revision >= 0),
  status text NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'blocked')),
  retry_count integer NOT NULL DEFAULT 0,
  parent_cell_id uuid,
  child_key text,
  detached boolean NOT NULL DEFAULT false,
  wait_generation bigint NOT NULL DEFAULT 0,
  result_ref uuid,
  failure jsonb,
  revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (namespace_id, cell_id),
  UNIQUE (namespace_id, start_key),
  UNIQUE (namespace_id, parent_cell_id, child_key),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, parent_cell_id) REFERENCES cells(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, input_ref) REFERENCES payloads(namespace_id, payload_id),
  FOREIGN KEY (namespace_id, checkpoint_ref) REFERENCES payloads(namespace_id, payload_id),
  FOREIGN KEY (namespace_id, result_ref) REFERENCES payloads(namespace_id, payload_id),
  CHECK ((checkpoint_ref IS NULL AND checkpoint_version = 0)
      OR (checkpoint_ref IS NOT NULL AND checkpoint_version > 0)),
  CHECK (status <> 'completed' OR result_ref IS NOT NULL)
);

CREATE TABLE resumable_task_waits (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  wait_key text NOT NULL,
  wait_generation bigint NOT NULL CHECK (wait_generation > 0),
  spec_hash bytea NOT NULL CHECK (octet_length(spec_hash) = 32),
  conditions jsonb NOT NULL CHECK (
    jsonb_typeof(conditions) = 'array' AND jsonb_array_length(conditions) BETWEEN 1 AND 100
  ),
  status text NOT NULL CHECK (status IN ('pending', 'resolved', 'acknowledged', 'cancelled')),
  PRIMARY KEY (namespace_id, cell_id, wait_key),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES resumable_tasks(namespace_id, cell_id)
);

CREATE UNIQUE INDEX one_pending_wait ON resumable_task_waits(namespace_id, cell_id)
  WHERE status = 'pending';

CREATE TABLE resumable_task_signals (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  signal_id text NOT NULL,
  signal_key text NOT NULL,
  cancellation_generation bigint NOT NULL,
  input_version integer NOT NULL CHECK (input_version > 0),
  payload_ref uuid NOT NULL,
  input_hash bytea NOT NULL CHECK (octet_length(input_hash) = 32),
  accepted_order bigint GENERATED ALWAYS AS IDENTITY,
  matched_wait_key text,
  matched_condition_id text,
  PRIMARY KEY (namespace_id, cell_id, signal_id),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES resumable_tasks(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, payload_ref) REFERENCES payloads(namespace_id, payload_id),
  FOREIGN KEY (namespace_id, cell_id, matched_wait_key)
    REFERENCES resumable_task_waits(namespace_id, cell_id, wait_key),
  CHECK ((matched_wait_key IS NULL) = (matched_condition_id IS NULL))
);

CREATE INDEX signals_unmatched ON resumable_task_signals(namespace_id, cell_id, signal_key, accepted_order)
  WHERE matched_wait_key IS NULL;

CREATE TABLE wait_results (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  wait_key text NOT NULL,
  condition_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed', 'cancelled')),
  payload_ref uuid,
  failure jsonb,
  PRIMARY KEY (namespace_id, cell_id, wait_key, condition_id),
  FOREIGN KEY (namespace_id, cell_id, wait_key)
    REFERENCES resumable_task_waits(namespace_id, cell_id, wait_key),
  FOREIGN KEY (namespace_id, payload_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE TABLE task_effect_dependencies (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  checkpoint_revision bigint NOT NULL,
  batch_key text NOT NULL,
  effect_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (namespace_id, cell_id, batch_key, effect_id),
  UNIQUE (namespace_id, cell_id, batch_key, position),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES resumable_tasks(namespace_id, cell_id),
  FOREIGN KEY (namespace_id, effect_id) REFERENCES effects(namespace_id, effect_id)
);

CREATE TABLE effect_batches (
  namespace_id uuid NOT NULL,
  cell_id uuid NOT NULL,
  batch_key text NOT NULL,
  spec_hash bytea NOT NULL CHECK (octet_length(spec_hash) = 32),
  effect_count integer NOT NULL CHECK (effect_count BETWEEN 1 AND 32),
  PRIMARY KEY (namespace_id, cell_id, batch_key),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES resumable_tasks(namespace_id, cell_id)
);

ALTER TABLE task_effect_dependencies ADD CONSTRAINT dependency_batch
  FOREIGN KEY (namespace_id, cell_id, batch_key)
  REFERENCES effect_batches(namespace_id, cell_id, batch_key);

CREATE TABLE execution_commands (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  assignment_id uuid NOT NULL,
  command_sequence bigint NOT NULL CHECK (command_sequence > 0),
  request_id uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  resource_id uuid NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, assignment_id, command_sequence),
  UNIQUE (namespace_id, request_id)
);

CREATE TABLE operation_receipts (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  response jsonb NOT NULL,
  PRIMARY KEY (namespace_id, operation, idempotency_key)
);

CREATE TABLE migration_batches (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  batch_id uuid NOT NULL,
  source_hash bytea NOT NULL CHECK (octet_length(source_hash) = 32),
  status text NOT NULL CHECK (status IN ('staging', 'frozen', 'imported', 'verified', 'active', 'failed')),
  manifest_ref uuid NOT NULL,
  PRIMARY KEY (namespace_id, batch_id),
  FOREIGN KEY (namespace_id, manifest_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE TABLE migration_imports (
  namespace_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  public_id text NOT NULL,
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  cell_id uuid NOT NULL,
  PRIMARY KEY (namespace_id, batch_id, public_id),
  FOREIGN KEY (namespace_id, batch_id) REFERENCES migration_batches(namespace_id, batch_id),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id)
);

CREATE TABLE staged_deliveries (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  stage_id uuid NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  target_public_id text NOT NULL,
  delivery_key text NOT NULL,
  payload_ref uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  released boolean NOT NULL DEFAULT false,
  PRIMARY KEY (namespace_id, stage_id),
  UNIQUE (namespace_id, target_public_id, delivery_key),
  FOREIGN KEY (namespace_id, payload_ref) REFERENCES payloads(namespace_id, payload_id)
);

CREATE INDEX staged_release ON staged_deliveries(namespace_id, sequence) WHERE NOT released;

CREATE TABLE callback_relays (
  namespace_id uuid NOT NULL,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  cell_id uuid NOT NULL,
  request_id text NOT NULL,
  cancellation_generation bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (namespace_id, token_hash),
  FOREIGN KEY (namespace_id, cell_id) REFERENCES cells(namespace_id, cell_id)
);

CREATE TABLE audit_events (
  namespace_id uuid NOT NULL REFERENCES namespaces(namespace_id),
  audit_id uuid NOT NULL,
  principal_id text NOT NULL,
  operation text NOT NULL,
  resource_id uuid,
  request_id uuid NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace_id, audit_id)
);
