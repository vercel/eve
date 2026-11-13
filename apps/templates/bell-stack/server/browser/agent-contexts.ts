import { requireReusableContexts } from "../onepassword/browser-policy";
import Browserbase from "@browserbasehq/sdk";

import { getContextMetadataStore } from "./context-metadata-store.js";

export interface AgentContextRecord {
  id: string;
  name: string;
  selected: boolean;
  writerActive: false;
  status: "draft" | "saved";
}

const DEFAULT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export async function listAgentContexts(): Promise<AgentContextRecord[]> {
  requireReusableContexts();
  const sdk = browserbase();
  const metadata = getContextMetadataStore();
  const local = await metadata.read();
  const configuredId = process.env.BROWSERBASE_CONTEXT_ID;
  if (configuredId && !local.contexts[configuredId]) {
    await metadata.add(configuredId, "Configured Context");
    return listAgentContexts();
  }
  const records = await Promise.all(
    Object.entries(local.contexts).map(async ([id, item]) => {
      if (item.status === "draft") return undefined;
      try {
        const remote = await sdk.contexts.retrieve(id);
        return {
          id,
          name: item.name || remote.name || "Saved Context",
          selected: local.selectedContextId === id,
          writerActive: false,
          status: "saved",
        } satisfies AgentContextRecord;
      } catch {
        return undefined;
      }
    }),
  );
  return records.filter((item) => item !== undefined);
}

export async function createAgentContext(name: string): Promise<AgentContextRecord> {
  requireReusableContexts();
  const cleanName = validateName(name);
  const remote = await browserbase().contexts.create({
    name: cleanName,
    ...(process.env.BROWSERBASE_PROJECT_ID
      ? { projectId: process.env.BROWSERBASE_PROJECT_ID }
      : {}),
  });
  const metadata = getContextMetadataStore();
  await metadata.add(remote.id, cleanName);
  await metadata.select(remote.id);
  return {
    id: remote.id,
    name: cleanName,
    selected: true,
    writerActive: false,
    status: "saved",
  };
}

export async function ensureAgentContext(
  ownerSessionId: string,
  currentContextId?: string,
): Promise<AgentContextRecord> {
  const sdk = browserbase();
  const metadata = getContextMetadataStore();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + draftTtlMs());
  const local = await metadata.read();
  const current = currentContextId ? local.contexts[currentContextId] : undefined;

  if (currentContextId) {
    if (
      current?.status === "draft" &&
      current.expiresAt &&
      Date.parse(current.expiresAt) <= now.getTime()
    ) {
      await deleteContext(currentContextId);
      await metadata.remove(currentContextId);
    } else {
      try {
        const remote = await sdk.contexts.retrieve(currentContextId);
        if (current?.status === "draft")
          await metadata.touchDraft(currentContextId, expiresAt, now);
        return {
          id: currentContextId,
          name: current?.name || remote.name || "Saved Context",
          selected: local.selectedContextId === currentContextId,
          writerActive: false,
          status: current?.status === "draft" ? "draft" : "saved",
        };
      } catch (error) {
        if (current?.status !== "draft" || !(error instanceof Browserbase.APIError) || error.status !== 404)
          throw error;
        await metadata.remove(currentContextId);
      }
    }
  }

  await deleteExpiredDraftContexts(now);
  const name = `Bell draft ${shortSessionId(ownerSessionId)}`;
  const remote = await sdk.contexts.create({
    name,
    ...(process.env.BROWSERBASE_PROJECT_ID
      ? { projectId: process.env.BROWSERBASE_PROJECT_ID }
      : {}),
  });
  await metadata.addDraft(remote.id, name, ownerSessionId, expiresAt, now);
  return {
    id: remote.id,
    name,
    selected: false,
    writerActive: false,
    status: "draft",
  };
}

export async function promoteAgentContext(id: string, name?: string): Promise<AgentContextRecord> {
  requireReusableContexts();
  validateId(id);
  const sdk = browserbase();
  const remote = await sdk.contexts.retrieve(id);
  const metadata = getContextMetadataStore();
  const local = await metadata.read();
  const cleanName = validateName(
    name?.trim() || local.contexts[id]?.name || remote.name || "Saved Context",
  );
  if (!local.contexts[id]) await metadata.add(id, cleanName);
  await metadata.promote(id, cleanName);
  return {
    id,
    name: cleanName,
    selected: true,
    writerActive: false,
    status: "saved",
  };
}

export async function isDraftAgentContext(id: string, ownerSessionId?: string): Promise<boolean> {
  const context = (await getContextMetadataStore().read()).contexts[id];
  return Boolean(
    context?.status === "draft" && (!ownerSessionId || context.ownerSessionId === ownerSessionId),
  );
}

export async function selectAgentContext(id: string): Promise<void> {
  requireReusableContexts();
  validateId(id);
  await browserbase().contexts.retrieve(id);
  await getContextMetadataStore().select(id);
}

async function deleteExpiredDraftContexts(now: Date): Promise<void> {
  const metadata = getContextMetadataStore();
  const local = await metadata.read();
  const expired = Object.entries(local.contexts).filter(([, item]) => {
    const expiresAt = item.expiresAt;
    return (
      item.status === "draft" && Boolean(expiresAt) && Date.parse(expiresAt ?? "") <= now.getTime()
    );
  });
  for (const [id] of expired) {
    try {
      await deleteContext(id);
    } catch {
      // Keep the record so another request can retry deleting the remote data.
      continue;
    }
    await metadata.remove(id);
  }
}

async function deleteContext(id: string): Promise<void> {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) return;
  const response = await fetch(
    `https://api.browserbase.com/v1/contexts/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { "x-bb-api-key": apiKey } },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(`Context cleanup failed with status ${response.status}.`);
}

function draftTtlMs(): number {
  const configured = Number(process.env.BELL_DRAFT_CONTEXT_TTL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_DRAFT_TTL_MS;
}

function shortSessionId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "");
  return safe.slice(-12) || new Date().toISOString().slice(0, 10);
}

function browserbase(): Browserbase {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  if (!apiKey) throw new Error("Browserbase is not configured.");
  return new Browserbase({ apiKey });
}

function validateName(value: string): string {
  const clean = value.trim();
  if (clean.length < 1 || clean.length > 80)
    throw new Error("Context name must be 1–80 characters.");
  return clean;
}

function validateId(value: string): void {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new Error("Invalid Context ID.");
}
