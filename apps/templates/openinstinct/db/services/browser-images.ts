import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  browserImageArtifactReferenceSchema,
  browserImageArtifactUrl,
  browserImageMediaTypeSchema,
  browserImageSourceKindSchema,
  type BrowserImageArtifactReference,
} from "@shared/browser/artifact";
import { browserImageArtifacts, db } from "@db";

type ArtifactRow = typeof browserImageArtifacts.$inferSelect;

export type BrowserImageArtifactReservation = Pick<
  ArtifactRow,
  "id" | "storagePathname"
>;

export type ReservedBrowserImageArtifact =
  | {
      readonly image: BrowserImageArtifactReference;
      readonly status: "ready";
    }
  | {
      readonly reservation: BrowserImageArtifactReservation;
      readonly status: "pending";
    };

export async function reserveBrowserImageArtifact(
  scope: AccessScope,
  input: {
    readonly browserSessionId: string;
    readonly idempotencyKey: string;
    readonly label: string;
    readonly rootSessionId: string;
    readonly sourceKind: string;
    readonly workerSessionId: string;
  }
): Promise<ReservedBrowserImageArtifact> {
  const existing = await readByIdempotencyKey(scope, input.idempotencyKey);
  if (existing) return reservedResult(existing, input);

  const id = randomUUID();
  const workspaceKey = createHash("sha256")
    .update(scope.workspaceId)
    .digest("hex")
    .slice(0, 32);
  const rows = await db
    .insert(browserImageArtifacts)
    .values({
      browserSessionId: input.browserSessionId,
      createdAt: new Date(),
      createdByUserId: scope.userId,
      id,
      idempotencyKey: input.idempotencyKey,
      label: input.label,
      rootSessionId: input.rootSessionId,
      sourceKind: browserImageSourceKindSchema.parse(input.sourceKind),
      status: "pending",
      storagePathname: `browser-images/${workspaceKey}/${id}`,
      workerSessionId: input.workerSessionId,
      workspaceId: scope.workspaceId,
    })
    .onConflictDoNothing({
      target: [
        browserImageArtifacts.workspaceId,
        browserImageArtifacts.idempotencyKey,
      ],
    })
    .returning();
  const row =
    rows[0] ?? (await readByIdempotencyKey(scope, input.idempotencyKey));
  if (!row) throw new Error("The browser image reservation was not stored.");
  return reservedResult(row, input);
}

export async function finalizeBrowserImageArtifact(
  scope: AccessScope,
  reservation: BrowserImageArtifactReservation,
  input: {
    readonly byteSize: number;
    readonly contentHash: string;
    readonly filename: string;
    readonly mediaType: string;
    readonly sourceKind: string;
    readonly storagePathname: string;
  }
) {
  const rows = await db
    .update(browserImageArtifacts)
    .set({
      byteSize: input.byteSize,
      contentHash: input.contentHash,
      filename: input.filename,
      mediaType: browserImageMediaTypeSchema.parse(input.mediaType),
      sourceKind: browserImageSourceKindSchema.parse(input.sourceKind),
      status: "ready",
      storagePathname: input.storagePathname,
    })
    .where(
      and(
        eq(browserImageArtifacts.id, reservation.id),
        eq(browserImageArtifacts.workspaceId, scope.workspaceId),
        eq(browserImageArtifacts.createdByUserId, scope.userId),
        eq(browserImageArtifacts.status, "pending")
      )
    )
    .returning();
  const row =
    rows[0] ?? (await readReadyBrowserImageArtifactRow(scope, reservation.id));
  if (!row) throw new Error("The browser image manifest was not finalized.");
  return { image: toReference(row), storagePathname: row.storagePathname };
}

export async function readReadyBrowserImageArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {}
) {
  const row = await readReadyBrowserImageArtifactRow(
    scope,
    artifactId,
    options
  );
  return row ? { ...row, createdAt: row.createdAt.toISOString() } : undefined;
}

async function readReadyBrowserImageArtifactRow(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {}
) {
  const conditions = [
    eq(browserImageArtifacts.id, artifactId),
    eq(browserImageArtifacts.workspaceId, scope.workspaceId),
    eq(browserImageArtifacts.createdByUserId, scope.userId),
    eq(browserImageArtifacts.status, "ready"),
  ];
  if (options.rootSessionId) {
    conditions.push(
      eq(browserImageArtifacts.rootSessionId, options.rootSessionId)
    );
  }
  const rows = await db
    .select()
    .from(browserImageArtifacts)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}

function reservedResult(
  row: ArtifactRow,
  input: {
    readonly browserSessionId: string;
    readonly label: string;
    readonly rootSessionId: string;
    readonly workerSessionId: string;
  }
): ReservedBrowserImageArtifact {
  if (
    row.browserSessionId !== input.browserSessionId ||
    row.rootSessionId !== input.rootSessionId ||
    row.workerSessionId !== input.workerSessionId
  ) {
    throw new Error("The browser image idempotency key is already in use.");
  }
  if (row.status === "ready")
    return { image: toReference(row), status: "ready" };
  return {
    reservation: { id: row.id, storagePathname: row.storagePathname },
    status: "pending",
  };
}

function toReference(row: ArtifactRow) {
  return browserImageArtifactReferenceSchema.parse({
    byteSize: row.byteSize,
    filename: row.filename,
    id: row.id,
    label: row.label,
    mediaType: row.mediaType,
    url: browserImageArtifactUrl(row.id),
  });
}

async function readByIdempotencyKey(
  scope: AccessScope,
  idempotencyKey: string
) {
  const rows = await db
    .select()
    .from(browserImageArtifacts)
    .where(
      and(
        eq(browserImageArtifacts.workspaceId, scope.workspaceId),
        eq(browserImageArtifacts.createdByUserId, scope.userId),
        eq(browserImageArtifacts.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  return rows[0];
}
