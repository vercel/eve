import { randomBytes } from "node:crypto";

import { z } from "#compiled/zod/index.js";
import { readVercelCliToken } from "#internal/model-auth/vercel-cli.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";

const CALLBACK_PATH = "/api/auth/callback/vercel";
const TARGETS = ["production", "preview"] as const;
const KEYS = ["VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET", "BETTER_AUTH_SECRET"] as const;
const AppSchema = z.object({
  clientId: z.string().min(1),
  teamId: z.string(),
  signInFrom: z.string().optional(),
  scopes: z.array(z.string()),
  grantTypes: z.record(z.string(), z.boolean()).optional(),
  clientAuthenticationMethods: z.record(z.string(), z.boolean()).optional(),
  projectRedirectUris: z.array(z.object({ projectId: z.string(), path: z.string() })).optional(),
  clientSecrets: z.array(z.object({ lastFourChars: z.string() })).optional(),
});
const EnvSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string().optional(),
  target: z.union([z.string(), z.array(z.string())]).optional(),
  gitBranch: z.string().nullable().optional(),
  customEnvironmentIds: z.array(z.string()).optional(),
});
type App = z.infer<typeof AppSchema>;

class AppApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(status: number, code?: string) {
    super(
      status === 401 || status === 403
        ? "Vercel denied Web Chat auth setup. Run `vercel login` and check that you can manage apps and environment variables in this team, or ask a team owner to run setup."
        : code === "app_limit_reached"
          ? "This team has reached its Vercel App limit. Remove an unused app in team settings and retry."
          : "Vercel could not configure Web Chat authentication. Retry `eve add channel/web --skip-install`.",
    );
    this.status = status;
    this.code = code;
  }
}

function assertMatchingApp(app: App, project: VercelProjectReference): void {
  if (
    app.teamId !== project.orgId ||
    app.signInFrom !== "owning-team" ||
    !app.grantTypes?.authorization_code ||
    !app.clientAuthenticationMethods?.client_secret_post ||
    !["openid", "email", "profile"].every((scope) => app.scopes.includes(scope)) ||
    !app.projectRedirectUris?.some(
      (uri) => uri.projectId === project.projectId && uri.path === CALLBACK_PATH,
    )
  ) {
    throw new Error(
      "The existing Vercel App does not match this project's team-only Web Chat settings. Check the app in team settings before retrying.",
    );
  }
}

/** Provisions team-only browser sign-in without rotating existing project credentials. */
export async function provisionWebChatAuth(
  project: VercelProjectReference,
  signal?: AbortSignal,
): Promise<void> {
  const token = await readVercelCliToken();
  if (!token) throw new Error("Run `vercel login` before setting up Sign in with Vercel.");
  const query = new URLSearchParams({ teamId: project.orgId });
  const request = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    const options: RequestInit = {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    const response = await fetch(`https://api.vercel.com${path}?${query}`, options).catch(() => {
      signal?.throwIfAborted();
      throw new AppApiError(0);
    });
    if (!response.ok) {
      const error = z
        .object({ error: z.object({ code: z.string().optional() }) })
        .safeParse(await response.json().catch(() => undefined));
      throw new AppApiError(response.status, error.success ? error.data.error.code : undefined);
    }
    if (response.status === 204) return undefined;
    return response.json().catch(() => {
      throw new AppApiError(response.status);
    });
  };
  const getApp = async (id: string): Promise<App | undefined> => {
    try {
      return z
        .object({ app: AppSchema })
        .parse(await request(`/oauth-apps/${encodeURIComponent(id)}`)).app;
    } catch (error) {
      if (error instanceof AppApiError && error.code === "invalid_client") return undefined;
      throw error;
    }
  };
  const projectPath = `/v9/projects/${encodeURIComponent(project.projectId)}`;
  const remote = z
    .object({ id: z.string(), accountId: z.string(), name: z.string() })
    .parse(await request(projectPath));
  if (remote.id !== project.projectId || remote.accountId !== project.orgId) {
    throw new Error("The linked Vercel project is not available in the selected team.");
  }
  const allEnvs = z
    .object({ envs: z.array(EnvSchema) })
    .parse(await request(`${projectPath}/env`)).envs;
  const envs = allEnvs.filter((env) => !env.gitBranch && !env.customEnvironmentIds?.length);
  const forTarget = (key: string, target: string) =>
    envs.find(
      (env) =>
        env.key === key &&
        (typeof env.target === "string" ? [env.target] : (env.target ?? [])).includes(target),
    );
  const clientIds = new Set(
    TARGETS.map((target) => forTarget(KEYS[0], target)?.value).filter(Boolean),
  );
  if (
    clientIds.size > 1 ||
    TARGETS.some(
      (target) =>
        (forTarget(KEYS[1], target) || forTarget(KEYS[0], target)) &&
        !forTarget(KEYS[0], target)?.value,
    )
  ) {
    throw new Error(
      "Web Chat has conflicting or incomplete Vercel App credentials. Check production and preview environment variables before retrying.",
    );
  }
  const suffix = project.projectId.replace(/^prj_/, "").toLowerCase();
  const slug = `${remote.name.slice(0, 100)}-web-chat-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-");
  const configuredId = [...clientIds][0];
  let app = await getApp(configuredId ?? slug);
  if (!app && configuredId) {
    throw new Error(
      "The configured Vercel App is unavailable. Check VERCEL_APP_CLIENT_ID before retrying.",
    );
  }
  if (!app) {
    try {
      app = AppSchema.parse(
        await request("/oauth-apps", "POST", {
          name: `${remote.name.slice(0, 100)} Web Chat ${suffix}`,
          slug,
          projectRedirectUris: [{ projectId: project.projectId, path: CALLBACK_PATH }],
          scopes: ["openid", "email", "profile"],
          grantTypes: { authorization_code: true },
          clientAuthenticationMethods: { client_secret_post: true },
          signInFrom: "owning-team",
        }),
      );
    } catch (error) {
      if (
        !(error instanceof AppApiError) ||
        !["app_slug_taken", "app_name_taken"].includes(error.code ?? "")
      )
        throw error;
      app = await getApp(slug);
      if (!app) throw error;
    }
  }
  assertMatchingApp(app, project);
  const missingTargets = (key: string) => TARGETS.filter((target) => !forTarget(key, target));
  if (KEYS.every((key) => missingTargets(key).length === 0)) return;
  const secretTargets = missingTargets(KEYS[1]);
  if (secretTargets.length && (app.clientSecrets?.length ?? 0) >= 2) {
    throw new Error(
      "This Vercel App has reached its client secret limit. Remove an unused secret in team settings and retry.",
    );
  }
  const clientSecret = secretTargets.length
    ? z
        .object({ clientSecret: z.string().min(4) })
        .parse(await request(`/v1/apps/${encodeURIComponent(app.clientId)}/secrets`, "POST", {}))
        .clientSecret
    : undefined;
  const values = {
    VERCEL_APP_CLIENT_ID: app.clientId,
    VERCEL_APP_CLIENT_SECRET: clientSecret,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  };
  // No upsert: concurrent setup must never replace a working credential.
  const result = z
    .object({
      created: z.array(EnvSchema),
      failed: z.array(z.unknown()),
    })
    .parse(
      await request(
        `/v10/projects/${encodeURIComponent(project.projectId)}/env`,
        "POST",
        KEYS.filter((key) => missingTargets(key).length).map((key) => ({
          key,
          value: values[key],
          target: missingTargets(key),
          type: key === KEYS[0] ? "plain" : "sensitive",
          visibility: key === KEYS[0] ? "config" : "secret",
        })),
      ),
    );
  if (result.failed.length === 0) return;

  // Only roll back writes acknowledged by this attempt. An ambiguous network
  // failure may have committed the secret, so it must remain usable on retry.
  for (const env of result.created) {
    await request(`${projectPath}/env/${encodeURIComponent(env.id)}`, "DELETE");
  }
  if (clientSecret) {
    await request(
      `/v1/apps/${encodeURIComponent(app.clientId)}/secrets/${encodeURIComponent(clientSecret.slice(-4))}`,
      "DELETE",
    );
  }
  throw new Error(
    "Could not save Web Chat auth environment variables. Retry `eve add channel/web --skip-install`.",
  );
}
