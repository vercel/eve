DO $$
DECLARE
	was_validated boolean;
BEGIN
	SELECT convalidated
	INTO was_validated
	FROM pg_constraint
	WHERE conrelid = 'public.vault_items'::regclass
		AND conname = 'vault_items_kind_check';

	ALTER TABLE "vault_items" DROP CONSTRAINT IF EXISTS "vault_items_kind_check";
	ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_kind_check" CHECK ("vault_items"."kind" IN ('login', 'payment', 'address', 'contact', 'phone', 'identity', 'token')) NOT VALID;

	IF was_validated THEN
		ALTER TABLE "vault_items" VALIDATE CONSTRAINT "vault_items_kind_check";
	END IF;
END
$$;
