import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AccessScope } from "@/lib/auth/scope";
import {
  browserImageArtifactReferenceSchema,
  browserImageArtifactUrl,
  browserImageMediaTypeSchema,
  browserImageSourceKindSchema,
  type BrowserImageArtifactReference,
} from "@/lib/browser/artifact";
import { db } from "@/lib/db";
import { browserImages } from "@/lib/db/schema";

type ArtifactRow = typeof browserImages.$inferSelect;

export type BrowserImageArtifactReservation = Pick<ArtifactRow, "id" | "storagePathname">;

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
    readonly idempotencyKey: string;
    readonly label: string;
    readonly rootSessionId: string;
    readonly sourceKind: string;
    readonly workerSessionId: string;
  },
): Promise<ReservedBrowserImageArtifact> {
  const existing = await readByIdempotencyKey(scope, input.idempotencyKey);
  if (existing) return reservedResult(existing, input);

  const id = randomUUID();
  const workspaceKey = createHash("sha256").update(scope.workspaceId).digest("hex").slice(0, 32);
  const rows = await db
    .insert(browserImages)
    .values({
      createdAt: new Date(),
      id,
      idempotencyKey: input.idempotencyKey,
      label: input.label,
      rootSessionId: input.rootSessionId,
      sourceKind: browserImageSourceKindSchema.parse(input.sourceKind),
      status: "pending",
      storagePathname: `browser-images/${workspaceKey}/${id}`,
      workerSessionId: input.workerSessionId,
      shopperId: scope.userId,
    })
    .onConflictDoNothing({
      target: [browserImages.shopperId, browserImages.idempotencyKey],
    })
    .returning();
  const row = rows[0] ?? (await readByIdempotencyKey(scope, input.idempotencyKey));
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
  },
) {
  const rows = await db
    .update(browserImages)
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
        eq(browserImages.id, reservation.id),
        eq(browserImages.shopperId, scope.userId),
        eq(browserImages.status, "pending"),
      ),
    )
    .returning();
  const row = rows[0] ?? (await readReadyBrowserImageArtifactRow(scope, reservation.id));
  if (!row) throw new Error("The browser image manifest was not finalized.");
  return { image: toReference(row), storagePathname: row.storagePathname };
}

export async function readReadyBrowserImageArtifact(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {},
) {
  const row = await readReadyBrowserImageArtifactRow(scope, artifactId, options);
  return row ? { ...row, createdAt: row.createdAt.toISOString() } : undefined;
}

async function readReadyBrowserImageArtifactRow(
  scope: AccessScope,
  artifactId: string,
  options: { readonly rootSessionId?: string } = {},
) {
  const conditions = [
    eq(browserImages.id, artifactId),
    eq(browserImages.shopperId, scope.userId),
    eq(browserImages.status, "ready"),
  ];
  if (options.rootSessionId) {
    conditions.push(eq(browserImages.rootSessionId, options.rootSessionId));
  }
  const rows = await db
    .select()
    .from(browserImages)
    .where(and(...conditions))
    .limit(1);
  return rows[0];
}

function reservedResult(
  row: ArtifactRow,
  input: {
    readonly sourceKind: string;
    readonly rootSessionId: string;
    readonly workerSessionId: string;
  },
): ReservedBrowserImageArtifact {
  if (
    row.sourceKind !== input.sourceKind ||
    row.rootSessionId !== input.rootSessionId ||
    row.workerSessionId !== input.workerSessionId
  ) {
    throw new Error("The browser image idempotency key is already in use.");
  }
  if (row.status === "ready") return { image: toReference(row), status: "ready" };
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

async function readByIdempotencyKey(scope: AccessScope, idempotencyKey: string) {
  const rows = await db
    .select()
    .from(browserImages)
    .where(
      and(
        eq(browserImages.shopperId, scope.userId),
        eq(browserImages.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return rows[0];
}
