BEGIN;
ALTER TABLE bell_monitors ADD COLUMN IF NOT EXISTS creation_frequency text NOT NULL DEFAULT '1d';
ALTER TABLE bell_monitors ADD COLUMN IF NOT EXISTS frequency text NOT NULL DEFAULT '1d';
ALTER TABLE bell_monitors ADD COLUMN IF NOT EXISTS pending_frequency text;
ALTER TABLE bell_monitor_jobs DROP CONSTRAINT IF EXISTS bell_monitor_jobs_kind_check;
ALTER TABLE bell_monitor_jobs ADD CONSTRAINT bell_monitor_jobs_kind_check
  CHECK (kind IN ('inbox','reconcile','sync','send','cancel','update'));
COMMIT;
