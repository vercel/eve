ALTER TABLE compute.cells
  ADD COLUMN quarantine_reason jsonb;

ALTER TABLE compute.cells
  ADD CONSTRAINT cells_quarantine_reason_object
  CHECK (quarantine_reason IS NULL OR jsonb_typeof(quarantine_reason) = 'object');
