import type { JsonValue } from "../json";
import { isString, isObject } from "../values";
import { callApi } from "./api";
/**
 * Freeze dependency scope, verify saved versions, and publish dependencies before parents.
 * Approval and persistence belong to the adapters; execution never expands a saved plan.
 *
 * @packageDocumentation
 */
import {
  entryStatus,
  isLive,
  queryFieldReferences,
  readString,
} from "./content";
import type { QueryReference } from "./content";
import { contentfulPublishInputSchema } from "./input-schemas";
import type { ContentfulPublishInput } from "./input-schemas";
import { projectEntryLocale } from "./locale";
import {
  APP_HOST,
  CONTENTFUL_ID,
  pageKindInSpace,
  publicUrl,
  QUERY_SPACES,
  spacePath,
} from "./model";
import type { PageKind } from "./model";
import type { EntryStatus, LocalizedFields, RawEntry } from "./types";

/* Publication is entry-wide, so dependencies include every stored locale. */
const publicationReferences = (rawFields: LocalizedFields) => {
  const links = new Map<string, QueryReference>();
  for (const reference of queryFieldReferences(rawFields, "fields")) {
    if (
      !reference ||
      reference.id.length > 128 ||
      !CONTENTFUL_ID.test(reference.id)
    ) {
      throw new Error("Cannot publish an unsupported or malformed reference.");
    }
    links.set(`${reference.linkType}:${reference.id}`, reference);
    if (links.size > 500) {
      throw new Error(
        "Publishing is limited to 500 distinct references per entry."
      );
    }
  }
  return [...links.values()];
};

type PublicationKind = "Entry" | "Asset";

interface PublicationTarget {
  id: string;
  kind: PublicationKind;
}

interface PublicationItem extends PublicationTarget {
  /** Frozen version needs no publication write; dependency traversal may still find work. */
  alreadyPublished: boolean;
  assetId: string | null;
  contentfulUrl: string;
  contentTypeId: string | null;
  entryId: string | null;
  /** Exact version approved/planned for this item, rechecked before writes. */
  expectedVersion: number;
  page: PageKind | null;
  role: "requested" | "dependency";
  status: EntryStatus;
  title: string | null;
  url: string | null;
}

interface PublicationResult extends PublicationItem {
  /** Failure detail; an uncertain network outcome does not prove the write was rejected. */
  error?: string;
  outcome: "published" | "alreadyPublished" | "failed" | "notAttempted";
  version: number | null;
}

/* Serializable frozen scope and progress, persisted unchanged across approval pauses. */
/**
 * Serializable publication scope with frozen versions, dependency order, and outcomes retained across approval pauses.
 */
export interface ContentfulPublicationPlan {
  /** Serialized parsed input; must match when the saved call is rendered or executed. */
  inputFingerprint: string;
  /** Frozen publication order: dependencies precede their requested parents. */
  items: PublicationItem[];
  /** Live targets retained without publishing their pending edits. */
  liveReferences: (PublicationTarget & {
    publishedVersion: number;
    /** Page approvals pin current versions too; component-only plans use null. */
    expectedVersion: number | null;
  })[];
  /** True for a page-containing scope with at least one planned publication write. */
  requiresApproval: boolean;
  /** Attempted outcomes aligned with the prefix of items; never automatically retried. */
  results: PublicationResult[];
  space: ContentfulPublishInput["space"];
}

/* Outcomes for the entire frozen scope, including writes not attempted after failure. */
/**
 * Results for the complete frozen publication scope, including items left unattempted after a failure.
 */
export interface ContentfulPublicationOutcome {
  /** Every item was published or already current; no failures or unattempted items remain. */
  complete: boolean;
  /** A nonempty result list consists entirely of already-current versions. */
  nothingToPublish: boolean;
  results: PublicationResult[];
}

const publicationKey = (target: PublicationTarget) =>
  `${target.kind}:${target.id}`;

const publicationPath = (
  space: ContentfulPublishInput["space"],
  target: PublicationTarget
) =>
  `${spacePath(QUERY_SPACES[space])}/${target.kind === "Entry" ? "entries" : "assets"}/${target.id}`;

/**
 * Bind a saved plan to the parsed publication input.
 *
 * @param input - Input accepted by `contentfulPublishInputSchema`.
 * @returns Serialized parsed input, preserving schema property and requested-entry order.
 * @throws {@link Error} If input validation fails.
 * @remarks Persist this exact fingerprint; changing its construction invalidates saved plans.
 */
export const contentfulPublicationFingerprint = (input: JsonValue): string =>
  JSON.stringify(contentfulPublishInputSchema.parse(input));

const readPublicationTarget = async (
  space: ContentfulPublishInput["space"],
  target: PublicationTarget,
  signal?: AbortSignal
) => {
  signal?.throwIfAborted();
  const raw = await callApi<RawEntry>(
    publicationPath(space, target),
    {},
    signal
  );
  if (
    raw.sys?.id !== target.id ||
    !Number.isSafeInteger(raw.sys.version) ||
    (raw.sys.version ?? 0) < 1
  ) {
    throw new Error(
      `${publicationKey(target)} returned an invalid identity or version.`
    );
  }
  if (raw.sys.archivedVersion !== undefined) {
    throw new Error(`${publicationKey(target)} is archived.`);
  }
  if (
    raw.sys.publishedVersion !== undefined &&
    (!Number.isSafeInteger(raw.sys.publishedVersion) ||
      raw.sys.publishedVersion < 1 ||
      raw.sys.publishedVersion >= (raw.sys.version ?? 0))
  ) {
    throw new Error(
      `${publicationKey(target)} returned an invalid published version.`
    );
  }
  if (
    target.kind === "Entry" &&
    !(
      isString(raw.sys.contentType?.sys.id) &&
      raw.sys.contentType.sys.id.length <= 128 &&
      CONTENTFUL_ID.test(raw.sys.contentType.sys.id)
    )
  ) {
    throw new Error(`${publicationKey(target)} has no valid content type.`);
  }
  return raw;
};

const requireProcessedPublicationAsset = (id: string, raw: RawEntry) => {
  const files = Object.values(raw.fields?.file ?? {}).filter(
    (file) => file !== null && file !== undefined
  );
  if (
    files.length === 0 ||
    files.some(
      (file) =>
        !(
          file &&
          isObject(file) &&
          "url" in file &&
          isString(file.url) &&
          file.url.length > 0
        )
    )
  ) {
    throw new Error(
      `Asset ${id} is not processed. Process it in Contentful before publishing.`
    );
  }
};

const publicationItem = async (
  space: ContentfulPublishInput["space"],
  target: PublicationTarget,
  raw: RawEntry,
  requestedVersion: number | undefined,
  signal?: AbortSignal
): Promise<PublicationItem> => {
  // SAFETY: Planning only supplies resources read through readPublicationTarget, which validates a positive integer version.
  const expectedVersion = raw.sys.version as number;
  const requested = requestedVersion !== undefined;
  if (requested && requestedVersion !== expectedVersion) {
    throw new Error(
      `${publicationKey(target)} version has changed. Read it again and request fresh publication approval.`
    );
  }
  const contentTypeId =
    target.kind === "Entry" ? (raw.sys.contentType?.sys.id ?? null) : null;
  const page = contentTypeId
    ? pageKindInSpace(QUERY_SPACES[space], contentTypeId)
    : null;
  if (page && !requested) {
    throw new Error(
      `Unpublished linked page ${target.id} must be explicitly included with its expected version.`
    );
  }
  if (target.kind === "Asset") {
    requireProcessedPublicationAsset(target.id, raw);
  }
  const display =
    target.kind === "Entry"
      ? await projectEntryLocale(spacePath(QUERY_SPACES[space]), raw, signal)
      : raw;
  const slug = readString(display.fields, "slug");
  return {
    ...target,
    alreadyPublished: entryStatus(raw.sys) === "published",
    assetId: target.kind === "Asset" ? target.id : null,
    contentTypeId,
    contentfulUrl: `${APP_HOST}${publicationPath(space, target)}`,
    entryId: target.kind === "Entry" ? target.id : null,
    expectedVersion,
    page,
    role: requested ? "requested" : "dependency",
    status: entryStatus(raw.sys),
    title:
      readString(display.fields, "title") ?? readString(display.fields, "name"),
    url: page && slug ? publicUrl(page, slug) : null,
  };
};

/* Decide which version to retain and which children belong to this publication. */
const planPublicationTarget = async (
  plan: ContentfulPublicationPlan,
  target: PublicationTarget,
  raw: RawEntry,
  requestedVersion: number | undefined,
  signal?: AbortSignal
) => {
  const requested = requestedVersion !== undefined;
  const linkedPage =
    target.kind === "Entry" &&
    pageKindInSpace(
      QUERY_SPACES[plan.space],
      raw.sys.contentType?.sys.id ?? ""
    ) !== null;
  const retainLive =
    !requested &&
    isLive(raw.sys) &&
    (!plan.requiresApproval ||
      linkedPage ||
      entryStatus(raw.sys) === "published");
  if (retainLive) {
    plan.liveReferences.push({
      ...target,
      // SAFETY: readPublicationTarget validated sys.version before this dependency was planned.
      expectedVersion: plan.requiresApproval
        ? (raw.sys.version as number)
        : null,
      // SAFETY: retainLive requires isLive, and readPublicationTarget validated the published-version counter.
      publishedVersion: raw.sys.publishedVersion as number,
    });
  }
  const item = retainLive
    ? null
    : await publicationItem(plan.space, target, raw, requestedVersion, signal);
  // Unchanged components can link to edited children. Unrequested live pages
  // remain boundaries, while component-only calls retain live reference edits.
  const traverse = plan.requiresApproval
    ? requested || !linkedPage
    : item !== null && !item.alreadyPublished;
  return {
    item,
    references:
      target.kind === "Entry" && traverse
        ? publicationReferences(raw.fields ?? {})
        : [],
  };
};

/**
 * Freeze the complete publication scope before approval, without making writes.
 *
 * @param input - One space and 1–20 requested entry IDs with expected versions.
 * @param signal - Optional cancellation for root reads and dependency traversal.
 * @returns Dependency-first items, retained live versions, and the approval requirement.
 * @throws {@link Error} If input, identity, versions, references, or asset processing state are invalid.
 * @throws {@link Error} If a read fails, cancellation occurs, or traversal encounters a cycle or graph limit.
 * @remarks Page plans traverse unchanged components to find edited children. Unrequested
 * live pages remain boundaries. Approval is skipped for an unchanged scope only after
 * traversal completes. The caller must persist the returned plan before requesting approval.
 */
export const prepareContentfulPublication = async (
  input: JsonValue,
  signal?: AbortSignal
): Promise<ContentfulPublicationPlan> => {
  const parsed = contentfulPublishInputSchema.parse(input);
  const { space, entries } = parsed;
  const roots = new Map(
    entries.map((entry) => [`Entry:${entry.entryId}`, entry.expectedVersion])
  );
  const plan: ContentfulPublicationPlan = {
    inputFingerprint: contentfulPublicationFingerprint(parsed),
    items: [],
    liveReferences: [],
    requiresApproval: false,
    results: [],
    space,
  };
  // Classify every requested root before walking dependencies so batch order
  // cannot decide whether changed supporting references need approval.
  const rootEntries = new Map<string, RawEntry>();
  for await (const { entryId, expectedVersion } of entries) {
    const target = { id: entryId, kind: "Entry" as const };

    const raw = await readPublicationTarget(space, target, signal);
    const item = await publicationItem(
      space,
      target,
      raw,
      expectedVersion,
      signal
    );
    rootEntries.set(entryId, raw);
    plan.requiresApproval ||= item.page !== null;
  }
  const seen = new Set<string>();
  const visiting = new Set<string>();
  let publicationCount = 0;
  const visit = async (
    target: PublicationTarget,
    depth: number
  ): Promise<void> => {
    const key = publicationKey(target);
    if (visiting.has(key)) {
      throw new Error(`Publication dependency cycle at ${key}.`);
    }
    if (seen.has(key)) {
      return;
    }
    if (depth > 20 || seen.size + visiting.size >= 500) {
      throw new Error(
        "Publication graph exceeds 500 targets or 20 dependency levels."
      );
    }
    const raw =
      (target.kind === "Entry" ? rootEntries.get(target.id) : undefined) ??
      (await readPublicationTarget(space, target, signal));
    const requestedVersion = roots.get(key);
    const { item, references } = await planPublicationTarget(
      plan,
      target,
      raw,
      requestedVersion,
      signal
    );
    if (item) {
      publicationCount += 1;
    }
    if (publicationCount > 100) {
      throw new Error(
        "Publication plans are limited to 100 entries and assets, including requested entries."
      );
    }
    visiting.add(key);
    for await (const reference of references) {
      await visit({ id: reference.id, kind: reference.linkType }, depth + 1);
    }
    visiting.delete(key);
    seen.add(key);
    if (item) {
      plan.items.push(item);
    }
  };
  for await (const { entryId } of entries) {
    await visit({ id: entryId, kind: "Entry" }, 0);
  }
  // Check only after traversal: an unchanged page can have edited references.
  plan.requiresApproval &&= plan.items.some((item) => !item.alreadyPublished);
  return plan;
};

/* Recheck the frozen scope and retained live versions before the first write. */
const verifyContentfulPublication = async (
  plan: ContentfulPublicationPlan,
  signal?: AbortSignal
) => {
  for await (const item of plan.items) {
    const raw = await readPublicationTarget(plan.space, item, signal);
    if (raw.sys.version !== item.expectedVersion) {
      throw new Error(
        `${publicationKey(item)} version has changed. Nothing was published by this execution; read current state and request a new plan.`
      );
    }
  }
  for await (const item of plan.liveReferences) {
    const raw = await readPublicationTarget(plan.space, item, signal);
    if (
      raw.sys.publishedVersion !== item.publishedVersion ||
      (item.expectedVersion !== null &&
        raw.sys.version !== item.expectedVersion)
    ) {
      throw new Error(
        `${publicationKey(item)} retained reference has changed. Request a new publication plan.`
      );
    }
  }
};

const publicationOutcome = (
  plan: ContentfulPublicationPlan
): ContentfulPublicationOutcome => {
  const results = plan.items.map(
    (item, index) =>
      plan.results[index] ?? {
        ...item,
        outcome: "notAttempted" as const,
        version: null,
      }
  );
  return {
    complete: results.every(
      ({ outcome }) => outcome === "published" || outcome === "alreadyPublished"
    ),
    nothingToPublish:
      results.length > 0 &&
      results.every(({ outcome }) => outcome === "alreadyPublished"),
    results,
  };
};

/**
 * Verify and publish frozen versions once, recording partial or uncertain outcomes.
 *
 * @param plan - Saved scope; execution mutates its results but never expands its items.
 * @param record - Synchronous progress checkpoint, called before and after writes.
 * @param signal - Cancels verification/requests or stops between items.
 * @returns Ordered outcomes; an existing nonempty result list is reported without retrying.
 * @throws {@link Error} If preflight reads, cancellation, or version checks fail before writes begin.
 * @throws {@link Error} If progress cannot be checkpointed and the persistence error propagates.
 * @remarks Dependencies precede parents. During execution, write failures and cancellation
 * produce partial results; cancellation between items leaves them unattempted. Checkpoints
 * are not atomic with CMA writes. Uncertain outcomes require fresh reads, never a rebuilt
 * or expanded approval plan. Authorization and preview delivery are enforced by adapters.
 */
export const executeContentfulPublication = async (
  plan: ContentfulPublicationPlan,
  record: (plan: ContentfulPublicationPlan) => void,
  signal?: AbortSignal
): Promise<ContentfulPublicationOutcome> => {
  // A re-entered call reports progress; it never retries or resumes uncertain writes.
  if (plan.results.length > 0) {
    return publicationOutcome(plan);
  }
  await verifyContentfulPublication(plan, signal);
  for await (const item of plan.items) {
    if (signal?.aborted) {
      break;
    }
    if (item.alreadyPublished) {
      plan.results.push({
        ...item,
        outcome: "alreadyPublished",
        version: item.expectedVersion,
      });
      record(plan);
      continue;
    }
    const result: PublicationResult = {
      ...item,
      error:
        "Publication outcome unconfirmed. Read current Contentful state before attempting recovery.",
      outcome: "failed",
      version: null,
    };
    plan.results.push(result);
    record(plan);
    try {
      signal?.throwIfAborted();

      const published = await callApi<RawEntry>(
        `${publicationPath(plan.space, item)}/published`,
        {},
        signal,
        {
          headers: { "X-Contentful-Version": String(item.expectedVersion) },
          method: "PUT",
        }
      );
      if (
        published.sys?.id !== item.id ||
        published.sys.version !== item.expectedVersion + 1 ||
        published.sys.publishedVersion !== item.expectedVersion
      ) {
        throw new Error(
          "Contentful returned an unexpected publication response; outcome unconfirmed."
        );
      }
      plan.results[plan.results.length - 1] = {
        ...item,
        outcome: "published",
        version: published.sys.version,
      };
      record(plan);
    } catch (error) {
      result.error = `${error instanceof Error ? error.message : String(error)} Publication may be unconfirmed; read current state before recovery. No remaining items were attempted.`;
      record(plan);
      break;
    }
  }
  return publicationOutcome(plan);
};
