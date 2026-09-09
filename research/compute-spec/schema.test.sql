-- Constraint and transaction smoke tests; fixtures are rolled back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path = compute, public;

INSERT INTO namespaces(namespace_id, project_id)
VALUES ('00000000-0000-0000-0000-000000000001', 'spec');
INSERT INTO namespace_usage(namespace_id)
VALUES ('00000000-0000-0000-0000-000000000001');
INSERT INTO deployments(namespace_id, digest, manifest, manifest_hash, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'sha256:' || repeat('a', 64),
        '{}', 'sha256:' || repeat('b', 64), 'ready');
UPDATE namespaces
SET desired_deployment = 'sha256:' || repeat('a', 64), deployment_epoch = 1;
INSERT INTO payloads(namespace_id, payload_id, content_hash, codec, body)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000010', decode(repeat('00', 32), 'hex'),
        'eve-value-v1', convert_to('null', 'UTF8'));
INSERT INTO cells(namespace_id, cell_id, kind, definition_id, cell_key, deployment_digest,
                  adopted_epoch, next_message_seq)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000020', 'cell', 'sessions', 'session-1',
        'sha256:' || repeat('a', 64), 1, 2);
INSERT INTO messages(namespace_id, cell_id, message_id, sequence, delivery_key, request_hash,
                     origin, original_ref, payload_ref, message_version)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000020',
        '00000000-0000-0000-0000-000000000030', 1, 'delivery-1',
        decode(repeat('00', 32), 'hex'), '{"kind":"external","principalId":"test"}',
        '00000000-0000-0000-0000-000000000010',
        '00000000-0000-0000-0000-000000000010', 1);

DO $$
BEGIN
  BEGIN
    INSERT INTO messages
    SELECT namespace_id, cell_id, '00000000-0000-0000-0000-000000000031'::uuid,
           2, delivery_key, request_hash, origin, original_ref, payload_ref, message_version,
           status, accepted_at, applied_at
    FROM messages;
    RAISE EXCEPTION 'duplicate delivery was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE cells SET owner_id = '00000000-0000-0000-0000-000000000099';
    RAISE EXCEPTION 'partial ownership tuple was accepted';
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN NULL;
  END;
END $$;

SAVEPOINT before_transition;
UPDATE cells SET revision = 1, processed_seq = 1, state_version = 1,
  state_ref = '00000000-0000-0000-0000-000000000010';
UPDATE messages SET status = 'applied';
INSERT INTO outbox(namespace_id, delivery_id, source_cell_id, delivery_key,
                   target_definition, target_key, message_version, payload_ref, request_hash, origin)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000040',
        '00000000-0000-0000-0000-000000000020', 'out-1', 'sessions', 'session-2', 1,
        '00000000-0000-0000-0000-000000000010', decode(repeat('00', 32), 'hex'),
        '{"kind":"cell","sourceCellId":"00000000-0000-0000-0000-000000000020"}');
ROLLBACK TO SAVEPOINT before_transition;
DO $$
BEGIN
  IF EXISTS (SELECT FROM cells WHERE revision <> 0 OR processed_seq <> 0)
     OR EXISTS (SELECT FROM messages WHERE status <> 'pending')
     OR EXISTS (SELECT FROM outbox) THEN
    RAISE EXCEPTION 'partial transition escaped rollback';
  END IF;
END $$;

INSERT INTO cells(namespace_id, cell_id, kind, definition_id, cell_key, deployment_digest,
                  adopted_epoch)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000050', 'resumable_task', 'platform/task', 'task-1',
        'sha256:' || repeat('a', 64), 1);
INSERT INTO resumable_tasks(namespace_id, cell_id, definition_id, input_version, input_ref,
                            start_key, start_hash)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000050', 'reports', 1,
        '00000000-0000-0000-0000-000000000010', 'start-1',
        decode(repeat('00', 32), 'hex'));
INSERT INTO resumable_task_waits(namespace_id, cell_id, wait_key, wait_generation,
                                 spec_hash, conditions, status)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000050', 'wait-1', 1,
        decode(repeat('00', 32), 'hex'),
        '[{"id":"answer","kind":"signal","signalKey":"reply"}]', 'pending');
DO $$
BEGIN
  BEGIN
    INSERT INTO resumable_task_waits
    SELECT namespace_id, cell_id, 'wait-2', 2, spec_hash, conditions, status
    FROM resumable_task_waits;
    RAISE EXCEPTION 'two pending waits were accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE resumable_tasks SET status = 'completed';
    RAISE EXCEPTION 'completion without result was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

INSERT INTO namespaces(namespace_id, project_id)
VALUES ('00000000-0000-0000-0000-000000000002', 'other-spec');
INSERT INTO deployments(namespace_id, digest, manifest, manifest_hash, status)
VALUES ('00000000-0000-0000-0000-000000000002', 'sha256:' || repeat('a', 64),
        '{}', 'sha256:' || repeat('b', 64), 'ready');
DO $$
BEGIN
  BEGIN
    INSERT INTO cells(namespace_id, cell_id, kind, definition_id, cell_key,
                      deployment_digest, adopted_epoch, state_version, state_ref)
    VALUES ('00000000-0000-0000-0000-000000000002',
            '00000000-0000-0000-0000-000000000070', 'cell', 'sessions', 'other-session',
            'sha256:' || repeat('a', 64), 1, 1,
            '00000000-0000-0000-0000-000000000010');
    RAISE EXCEPTION 'cross-namespace payload reference was accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END $$;
ROLLBACK;
\echo 'Schema constraints and atomic rollback checks passed.'
