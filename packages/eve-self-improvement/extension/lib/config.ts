import { createHash } from "node:crypto";
import { z } from "zod";
import type { SelfImprovementOptions } from "./types.js";
import type { AgentStaticModelDefinition } from "eve";

const segment = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);
const origin = z.string().refine((value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && u.origin === value && !u.username && !u.password;
  } catch {
    return false;
  }
}, "Use a clean HTTPS origin without path, query or credentials");
const callback = <T extends (...args: any[]) => any>() =>
  z.custom<T>((v) => typeof v === "function", "Expected a trusted callback");
const staticModel = z.union([
  z.string().min(1),
  z.custom<Exclude<AgentStaticModelDefinition, string>>(
    (v) =>
      !!v &&
      typeof v === "object" &&
      "specificationVersion" in v &&
      ["v2", "v3", "v4"].includes(String(v.specificationVersion)) &&
      "doGenerate" in v &&
      typeof v.doGenerate === "function" &&
      "doStream" in v &&
      typeof v.doStream === "function",
    "Expected an AI Gateway model ID or eve language model",
  ),
]);
const model = z.union([
  staticModel,
  z.object({
    model: staticModel,
    modelContextWindowTokens: z.number().int().positive().optional(),
    reasoning: z
      .enum(["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"])
      .optional(),
  }),
]);
/** Validates the host configuration and refuses automatic shipping without independent proof and a trusted release service. */
export const configSchema = z
  .object({
    instance: segment,
    project: z.object({
      teamId: z.string().regex(/^team_[A-Za-z0-9]+$/),
      projectId: z.string().regex(/^prj_[A-Za-z0-9]+$/),
      productionUrl: origin,
    }),
    repository: z.object({
      owner: segment,
      name: segment,
      branch: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
        .default("main"),
      directory: z
        .string()
        .default(".")
        .refine((v) => v === "." || safePath(v), "Expected a relative application directory"),
    }),
    owner: z.object({ authenticator: z.string().min(1), principalId: z.string().min(1) }),
    models: z.object({ analyst: model, maintainer: model }),
    cron: z
      .string()
      .regex(/^\S+( \S+){4}$/)
      .default("0 10 * * *"),
    credentials: z
      .object({
        github:
          callback<
            NonNullable<NonNullable<SelfImprovementOptions["credentials"]>["github"]>
          >().optional(),
        vercel:
          callback<
            NonNullable<NonNullable<SelfImprovementOptions["credentials"]>["vercel"]>
          >().optional(),
      })
      .default({}),
    database: z.enum(["blob", "postgres", "vercel-postgres"]).optional(),
    databaseUrl: callback<() => string>().optional(),
    privacy: z
      .object({
        retentionDays: z.number().int().min(1).max(90).default(7),
        ledgerDays: z.number().int().min(30).max(365).default(90),
        hmacSecret: callback<() => string>().optional(),
      })
      .prefault({}),
    policy: z
      .object({
        mode: z.enum(["propose", "ship"]).default("propose"),
        requiredChecks: z.array(z.string().min(1)).default([]),
        protectedPaths: z.array(z.string().min(1)).default([]),
        maxAttempts: z.number().int().min(1).max(5).default(3),
        maxFiles: z.number().int().min(1).max(100).default(50),
        maxBytes: z.number().int().min(1).max(1_000_000).default(500_000),
      })
      .prefault({}),
    release: z
      .object({ deploy: callback<NonNullable<SelfImprovementOptions["release"]>["deploy"]>() })
      .optional(),
    verification: z
      .object({
        commands: z.array(z.string().min(1)).min(1).optional(),
        authHeaders:
          callback<
            NonNullable<NonNullable<SelfImprovementOptions["verification"]>["authHeaders"]>
          >().optional(),
        smoke: z
          .object({
            message: z.string().min(1),
            toolName: z.string().min(1),
            expectedOutput: z.unknown(),
          })
          .optional(),
        change:
          callback<
            NonNullable<NonNullable<SelfImprovementOptions["verification"]>["change"]>
          >().optional(),
        runtime:
          callback<
            NonNullable<NonNullable<SelfImprovementOptions["verification"]>["runtime"]>
          >().optional(),
        delivery:
          callback<
            NonNullable<NonNullable<SelfImprovementOptions["verification"]>["delivery"]>
          >().optional(),
        publisher:
          callback<
            NonNullable<NonNullable<SelfImprovementOptions["verification"]>["publisher"]>
          >().optional(),
      })
      .default({}),
    report: callback<NonNullable<SelfImprovementOptions["report"]>>().optional(),
  })
  .superRefine((c, ctx) => {
    if (
      c.policy.mode === "ship" &&
      (!c.policy.requiredChecks.length ||
        !c.release ||
        !c.verification.change ||
        !c.verification.smoke ||
        !c.verification.authHeaders ||
        !c.verification.runtime ||
        !c.verification.publisher ||
        !c.report)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Shipping needs a trusted release.deploy executor, requiredChecks, authenticated smoke, change, runtime and publisher verifiers, and a report callback for rollback failures",
      });
  });
/** Validated host settings with defaults applied. */
export type Config = z.output<typeof configSchema>;
export function safePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    // oxlint-disable-next-line no-control-regex
    !/[\x00-\x1f\x7f]/.test(value) &&
    value.split("/").every((p) => p !== "" && p !== "." && p !== "..")
  );
}
export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function namespace(c: Config): string {
  return digest([
    c.project.teamId,
    c.project.projectId,
    c.repository.owner.toLowerCase(),
    c.repository.name.toLowerCase(),
    c.instance,
  ]).slice(0, 32);
}
export function hmacSecret(c: Config): string {
  const secret = c.privacy.hmacSecret?.() ?? process.env.EVE_EVOLUTION_HMAC_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("A private EVE_EVOLUTION_HMAC_SECRET of at least 32 characters is required");
  return secret;
}
export async function credential(c: Config, kind: "github" | "vercel"): Promise<string> {
  const value =
    (await c.credentials[kind]?.()) ??
    process.env[kind === "github" ? "EVE_EVOLUTION_GITHUB_TOKEN" : "EVE_EVOLUTION_VERCEL_TOKEN"];
  if (!value?.trim()) throw new Error(`Missing ${kind} credentials for self-improvement`);
  return value.trim();
}
export function owned(
  c: Config,
  auth: { authenticator?: string; principalId?: string } | null,
): boolean {
  return auth?.authenticator === c.owner.authenticator && auth.principalId === c.owner.principalId;
}
export function checkPath(c: Config, path: string): void {
  if (
    !safePath(path) ||
    path
      .split("/")
      .some(
        (p) =>
          [".git", ".eve", ".vercel", "node_modules"].includes(p) ||
          p === ".env" ||
          p.startsWith(".env."),
      ) ||
    path.startsWith(".github/workflows/") ||
    c.policy.protectedPaths.some((p) => path === p || path.startsWith(`${p.replace(/\/$/, "")}/`))
  )
    throw new Error("A candidate path is outside the configured change policy");
}
