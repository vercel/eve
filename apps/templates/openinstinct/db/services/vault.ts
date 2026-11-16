import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  loginAccountHint,
  parsePaymentCardSecret,
  parseLoginVaultPayload,
  paymentCardBrand,
  vaultItemKindSchema,
  type VaultCreateItem,
} from "@shared/vault/schema";
import type { AccessScope } from "@shared/identity/access-scope";
import { db, vaultItems } from "@db";
import {
  deleteEncryptedSecret,
  readEncryptedSecret,
  writeEncryptedSecret,
} from "@db/services/secrets";
import { ensureScope } from "@db/services/scope";
import { getInstallationSecrets } from "@db/services/installation-secrets";

const vaultRecordSchema = z.object({
  account: z.string(),
  createdAt: z.string(),
  id: z.string(),
  kind: vaultItemKindSchema,
  label: z.string(),
  updatedAt: z.string(),
});

type VaultRecord = z.infer<typeof vaultRecordSchema>;

const selection = {
  account: vaultItems.account,
  createdAt: vaultItems.createdAt,
  id: vaultItems.id,
  kind: vaultItems.kind,
  label: vaultItems.label,
  updatedAt: vaultItems.updatedAt,
};

async function createVaultRecord(scope: AccessScope, record: VaultRecord) {
  await db.insert(vaultItems).values({
    ...record,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
    workspaceId: scope.workspaceId,
  });
}

export async function listVaultItems(scope: AccessScope) {
  return vaultRecordSchema
    .array()
    .parse(
      (
        await db
          .select(selection)
          .from(vaultItems)
          .where(eq(vaultItems.workspaceId, scope.workspaceId))
          .orderBy(desc(vaultItems.updatedAt))
      ).map(serializeVaultRecord)
    );
}

export async function readVaultItems(scope: AccessScope) {
  await ensureScope(scope);
  const records = await listVaultItems(scope);
  return Promise.all(
    records.map(async (record) =>
      Object.assign({}, record, {
        hasSecret: await hasVaultSecret(scope, record.id),
      })
    )
  );
}

export async function readVaultItem(scope: AccessScope, id: string) {
  const rows = await db
    .select(selection)
    .from(vaultItems)
    .where(
      and(eq(vaultItems.workspaceId, scope.workspaceId), eq(vaultItems.id, id))
    )
    .limit(1);
  return vaultRecordSchema
    .optional()
    .parse(rows[0] ? serializeVaultRecord(rows[0]) : undefined);
}

export async function deleteVaultItem(scope: AccessScope, id: string) {
  const rows = await db
    .delete(vaultItems)
    .where(
      and(eq(vaultItems.workspaceId, scope.workspaceId), eq(vaultItems.id, id))
    )
    .returning({ id: vaultItems.id });
  if (rows.length === 0) return false;
  await deleteEncryptedSecret(scope, id);
  return true;
}

export async function saveVaultItem(
  scope: AccessScope,
  input: VaultCreateItem
) {
  await ensureScope(scope);
  const id = randomUUID();
  const now = new Date().toISOString();
  await writeVaultSecret(scope, id, input.secret);

  try {
    await createVaultRecord(scope, {
      account: vaultAccountHint(input),
      createdAt: now,
      id,
      kind: input.kind,
      label: input.label,
      updatedAt: now,
    });
  } catch (error) {
    await deleteEncryptedSecret(scope, id);
    throw error;
  }
}

export async function readVaultSecret(scope: AccessScope, id: string) {
  const encrypted = await readEncryptedSecret(scope, id);
  if (!encrypted) return undefined;
  const { secretEncryptionKey } = await getInstallationSecrets();
  return decryptVaultSecret(scope, id, encrypted, secretEncryptionKey);
}

export async function hasVaultSecret(scope: AccessScope, id: string) {
  return (await readEncryptedSecret(scope, id)) !== undefined;
}

async function writeVaultSecret(scope: AccessScope, id: string, value: string) {
  const { secretEncryptionKey } = await getInstallationSecrets();
  await writeEncryptedSecret(
    scope,
    id,
    encryptVaultSecret(scope, id, value, secretEncryptionKey)
  );
}

function vaultAccountHint(input: VaultCreateItem) {
  switch (input.kind) {
    case "login": {
      const payload = parseLoginVaultPayload(input.secret);
      if (!payload)
        throw new Error("The saved login is incomplete or invalid.");
      return loginAccountHint(
        payload.identifier,
        "origin" in payload ? payload.origin : undefined
      );
    }
    case "payment": {
      const card = parsePaymentCardSecret(input.secret);
      return `${paymentCardBrand(card.number)} · •••• ${card.number.slice(-4)}`;
    }
    case "address":
    case "contact":
      return "";
  }
  throw new Error("Unsupported vault item kind.");
}

function encryptVaultSecret(
  scope: AccessScope,
  id: string,
  value: string,
  secretEncryptionKey: string
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    iv
  );
  cipher.setAAD(vaultSecretAad(scope, id));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptVaultSecret(
  scope: AccessScope,
  id: string,
  value: string,
  secretEncryptionKey: string
) {
  const [version, encodedIv, encodedTag, encodedCiphertext] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("The stored secret uses an unsupported format.");
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(secretEncryptionKey, "base64"),
    Buffer.from(encodedIv, "base64url")
  );
  decipher.setAAD(vaultSecretAad(scope, id));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function vaultSecretAad(scope: AccessScope, id: string) {
  return Buffer.from(`${scope.workspaceId}\u0000vault\u0000${id}`);
}

function serializeVaultRecord<T extends { createdAt: Date; updatedAt: Date }>(
  record: T
) {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
