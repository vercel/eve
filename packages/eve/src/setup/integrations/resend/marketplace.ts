import { setTimeout as delay } from "node:timers/promises";

import { createPromptCommandOutput, type ChannelSetupLog, withPhase } from "#setup/cli/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import { captureVercel, runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

const ResourceSchema = z.object({
  id: z.string().min(1),
  externalResourceId: z.string().min(1).optional(),
  name: z.string().min(1),
  status: z.string().nullish(),
  externalResourceStatus: z.string().nullish(),
  metadata: z.object({ domain: z.string().min(1).optional() }).optional(),
  product: z
    .object({
      slug: z.string().optional(),
      integrationConfigurationId: z.string().optional(),
      integration: z.object({ slug: z.string().optional() }).optional(),
    })
    .optional(),
  projectsMetadata: z
    .array(
      z.object({
        projectId: z.string(),
        environments: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});
const ResourceListSchema = z.object({ stores: z.array(z.unknown()) });
const DomainListSchema = z.object({ domains: z.array(z.object({ name: z.string().min(1) })) });
const InspectedResourceSchema = z.object({
  resource: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.string().min(1),
  }),
});
const ProvisionedSchema = z.object({
  resource: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    externalResourceId: z.string().min(1),
  }),
  installation: z.object({ id: z.string().min(1) }),
  dashboardUrl: z.string().url().optional(),
});

/** Resend Marketplace resource visible to the current Vercel team. */
export type ResendMarketplaceResource = z.infer<typeof ResourceSchema>;

export interface ResendMarketplaceDeps {
  captureVercel: typeof captureVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
  delay(ms: number, signal?: AbortSignal): Promise<void>;
}

const defaultDeps: ResendMarketplaceDeps = {
  captureVercel,
  runVercelCaptureStdout,
  delay: (ms, signal) => delay(ms, undefined, { signal }),
};

const MARKETPLACE_POLL_INTERVAL_MS = 3_000;
const MARKETPLACE_POLL_TIMEOUT_MS = 10 * 60_000;
const DOMAIN_READY_POLL_TIMEOUT_MS = 15 * 60_000;
const READY_RESOURCE_STATUSES = new Set(["active", "available", "ready"]);

/** Lists existing Resend Marketplace resources without reading their secrets. */
export async function listResendMarketplaceResources(input: {
  projectRoot: string;
  project: VercelProjectReference;
  signal?: AbortSignal;
  deps?: Pick<ResendMarketplaceDeps, "captureVercel">;
}): Promise<ResendMarketplaceResource[]> {
  const deps = input.deps ?? defaultDeps;
  const result = await deps.captureVercel(
    ["api", "/v1/storage/stores", "--scope", input.project.orgId],
    { cwd: input.projectRoot, signal: input.signal },
  );
  if (!result.ok) throw new Error("Could not inspect Vercel Marketplace resources.");
  let body: unknown;
  try {
    body = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Vercel returned invalid JSON for Marketplace resources.");
  }
  const parsed = ResourceListSchema.safeParse(body);
  if (!parsed.success) throw new Error("Vercel returned an invalid Marketplace resource list.");
  const resources: ResendMarketplaceResource[] = [];
  for (const candidate of parsed.data.stores) {
    const resource = ResourceSchema.safeParse(candidate);
    if (!resource.success) continue;
    if (
      resource.data.product?.slug === "resend-email" ||
      resource.data.product?.integration?.slug === "resend"
    ) {
      resources.push(resource.data);
    }
  }
  return resources;
}

/** Lists domains owned by the linked Vercel team. */
export async function listVercelDomains(input: {
  projectRoot: string;
  project: VercelProjectReference;
  signal?: AbortSignal;
  deps?: Pick<ResendMarketplaceDeps, "captureVercel">;
}): Promise<string[]> {
  const deps = input.deps ?? defaultDeps;
  const result = await deps.captureVercel(
    ["domains", "list", "--format", "json", "--limit", "100", "--scope", input.project.orgId],
    { cwd: input.projectRoot, signal: input.signal },
  );
  if (!result.ok) throw new Error("Could not inspect Vercel domains.");
  let body: unknown;
  try {
    body = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Vercel returned invalid JSON for the domain list.");
  }
  const parsed = DomainListSchema.safeParse(body);
  if (!parsed.success) throw new Error("Vercel returned an invalid domain list.");
  return parsed.data.domains.map((domain) => domain.name);
}

/** Provisions and connects a Resend Marketplace resource through Vercel CLI. */
export async function provisionResendMarketplaceResource(input: {
  domain: string;
  log: ChannelSetupLog;
  projectRoot: string;
  project: VercelProjectReference;
  signal?: AbortSignal;
  deps?: ResendMarketplaceDeps;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<ResendMarketplaceResource> {
  const deps = input.deps ?? defaultDeps;
  const result = await withPhase(input.log, "Setting up Resend in Vercel Marketplace...", () =>
    deps.runVercelCaptureStdout(
      [
        "integration",
        "add",
        "resend",
        "--metadata",
        `domain=${input.domain}`,
        "--metadata",
        "region=us-east-1",
        "--environment",
        "production",
        "--format",
        "json",
        "--scope",
        input.project.orgId,
      ],
      {
        cwd: input.projectRoot,
        onOutput: createPromptCommandOutput(input.log),
        signal: input.signal,
      },
    ),
  );
  if (!result.ok) {
    input.log.info(
      `Complete Resend setup in the browser for ${input.domain}. This can take several minutes.`,
    );
    input.log.info(
      "You can safely stop waiting and rerun `eve add channel/resend`; setup will reuse the new Marketplace resource.",
    );
    const deadline = Date.now() + (input.pollTimeoutMs ?? MARKETPLACE_POLL_TIMEOUT_MS);
    const pollIntervalMs = input.pollIntervalMs ?? MARKETPLACE_POLL_INTERVAL_MS;
    return withPhase(
      input.log,
      "Waiting for Resend Marketplace setup in the browser...",
      async () => {
        while (Date.now() < deadline) {
          input.signal?.throwIfAborted();
          const resources = await listResendMarketplaceResources({
            projectRoot: input.projectRoot,
            project: input.project,
            signal: input.signal,
            deps,
          });
          const resource = resources.find(
            (candidate) => candidate.metadata?.domain?.toLowerCase() === input.domain.toLowerCase(),
          );
          if (resource !== undefined) return resource;
          await deps.delay(pollIntervalMs, input.signal);
        }
        throw new Error(
          `Resend Marketplace setup is still pending for ${input.domain}. Finish it in the browser, then rerun \`eve add channel/resend\`; the existing resource will be reused.`,
        );
      },
      { kind: "external-action", emphasis: "browser" },
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("Vercel returned invalid JSON after Resend Marketplace setup.");
  }
  const parsed = ProvisionedSchema.safeParse(body);
  if (!parsed.success) throw new Error("Vercel returned an invalid Resend Marketplace result.");
  return {
    id: parsed.data.resource.id,
    externalResourceId: parsed.data.resource.externalResourceId,
    metadata: { domain: input.domain },
    name: parsed.data.resource.name,
    product: {
      slug: "resend-email",
      integrationConfigurationId: parsed.data.installation.id,
    },
    projectsMetadata: [{ projectId: input.project.projectId, environments: ["production"] }],
  };
}

/** Reads live provider-backed status instead of the eventually consistent store summary. */
export async function inspectResendMarketplaceResource(input: {
  resource: ResendMarketplaceResource;
  projectRoot: string;
  project: VercelProjectReference;
  signal?: AbortSignal;
  deps?: Pick<ResendMarketplaceDeps, "captureVercel">;
}): Promise<ResendMarketplaceResource | undefined> {
  const deps = input.deps ?? defaultDeps;
  const result = await deps.captureVercel(
    [
      "integration",
      "resource",
      "inspect",
      input.resource.name,
      "--format",
      "json",
      "--scope",
      input.project.orgId,
    ],
    { cwd: input.projectRoot, signal: input.signal },
  );
  if (!result.ok) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
  const parsed = InspectedResourceSchema.safeParse(body);
  return parsed.success
    ? { ...input.resource, id: parsed.data.resource.id, status: parsed.data.resource.status }
    : undefined;
}

/** Whether Resend reports its Marketplace resource ready. */
export function isResendMarketplaceResourceReady(resource: ResendMarketplaceResource): boolean {
  return READY_RESOURCE_STATUSES.has(resource.status ?? "");
}

/** Waits for Resend and its DNS verification to become ready, supporting safe reruns on timeout. */
export async function waitForResendMarketplaceDomain(input: {
  resource: ResendMarketplaceResource;
  domain: string;
  log: ChannelSetupLog;
  projectRoot: string;
  project: VercelProjectReference;
  signal?: AbortSignal;
  deps?: Pick<ResendMarketplaceDeps, "captureVercel" | "delay">;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<ResendMarketplaceResource> {
  if (isResendMarketplaceResourceReady(input.resource)) return input.resource;
  const deps = input.deps ?? defaultDeps;
  const deadline = Date.now() + (input.pollTimeoutMs ?? DOMAIN_READY_POLL_TIMEOUT_MS);
  const pollIntervalMs = input.pollIntervalMs ?? MARKETPLACE_POLL_INTERVAL_MS;
  input.log.info(
    `Resend is configuring DNS for ${input.domain}. Verification can take several minutes.`,
  );
  input.log.info(
    "You can safely stop waiting and rerun `eve add channel/resend`; setup will resume from this resource.",
  );
  return withPhase(
    input.log,
    `Waiting for Resend domain DNS (${input.domain})...`,
    async () => {
      while (Date.now() < deadline) {
        input.signal?.throwIfAborted();
        await deps.delay(pollIntervalMs, input.signal);
        const current = await inspectResendMarketplaceResource({
          resource: input.resource,
          projectRoot: input.projectRoot,
          project: input.project,
          signal: input.signal,
          deps,
        });
        if (current !== undefined && isResendMarketplaceResourceReady(current)) return current;
      }
      throw new Error(
        `Resend is still verifying DNS for ${input.domain}. Finish any requested DNS setup in Resend, then rerun \`eve add channel/resend\`; setup will reuse this resource.`,
      );
    },
    { kind: "external-action", emphasis: "browser" },
  );
}

/** Connects an existing Marketplace resource to the linked project for production. */
export async function connectResendMarketplaceResource(input: {
  resource: ResendMarketplaceResource;
  log: ChannelSetupLog;
  projectRoot: string;
  project: VercelProjectReference;
  signal?: AbortSignal;
  deps?: Pick<ResendMarketplaceDeps, "runVercelCaptureStdout">;
}): Promise<void> {
  if (
    input.resource.projectsMetadata?.some((entry) => entry.projectId === input.project.projectId)
  ) {
    return;
  }
  const deps = input.deps ?? defaultDeps;
  const result = await withPhase(input.log, "Connecting Resend to this project...", () =>
    deps.runVercelCaptureStdout(
      [
        "integration",
        "resource",
        "connect",
        input.resource.name,
        "--environment",
        "production",
        "--yes",
        "--format",
        "json",
        "--scope",
        input.project.orgId,
      ],
      {
        cwd: input.projectRoot,
        nonInteractive: true,
        onOutput: createPromptCommandOutput(input.log),
        signal: input.signal,
      },
    ),
  );
  if (!result.ok) {
    throw new Error(
      `Could not connect Marketplace resource ${input.resource.name}. Run \`vercel integration resource connect ${input.resource.name} --environment production --yes\`.`,
    );
  }
}
