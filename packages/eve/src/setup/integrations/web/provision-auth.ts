import { randomBytes } from "node:crypto";

import { z } from "#compiled/zod/index.js";
import { readVercelCliToken } from "#internal/model-auth/vercel-cli.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";

const APP_CONFLICT_RECOVERY =
  "Rename the Vercel project in its settings, then retry `eve add channel/web --skip-install`.";
const CALLBACK_PATH = "/api/auth/callback/vercel";
const TARGETS = ["production", "preview"] as const;
const KEYS = ["VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET", "BETTER_AUTH_SECRET"] as const;
const AUTH_METHOD_KEY = "VERCEL_APP_AUTH_METHOD";
const OidcProviderSchema = z.object({
  issuerUrl: z.string(),
  claims: z.record(z.string(), z.array(z.string())),
});
const AppSchema = z.object({
  clientId: z.string().min(1),
  teamId: z.string(),
  signInFrom: z.string().optional(),
  scopes: z.array(z.string()),
  grantTypes: z.record(z.string(), z.boolean()).optional(),
  clientAuthenticationMethods: z.record(z.string(), z.boolean()).optional(),
  projectRedirectUris: z.array(z.object({ projectId: z.string(), path: z.string() })).optional(),
  oidcProviders: z.array(OidcProviderSchema).optional(),
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
          : code === "app_name_taken" || code === "app_slug_taken"
            ? `A Vercel App with this name or slug already exists. ${APP_CONFLICT_RECOVERY}`
            : "Vercel could not configure Web Chat authentication. Retry `eve add channel/web --skip-install`.",
    );
    this.status = status;
    this.code = code;
  }
}

function assertMatchingApp(app: App, project: VercelProjectReference, configured: boolean): void {
  if (
    app.teamId !== project.orgId ||
    app.signInFrom !== "owning-team" ||
    !app.grantTypes?.authorization_code ||
    !["openid", "email", "profile"].every((scope) => app.scopes.includes(scope)) ||
    !app.projectRedirectUris?.some(
      (uri) => uri.projectId === project.projectId && uri.path === CALLBACK_PATH,
    )
  ) {
    throw new Error(
      `The existing Vercel App does not match this project's team-only Web Chat settings. ${configured ? "Check VERCEL_APP_CLIENT_ID and the app in team settings before retrying." : APP_CONFLICT_RECOVERY}`,
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
      const result = z
        .object({ app: AppSchema })
        .safeParse(await request(`/oauth-apps/${encodeURIComponent(id)}`));
      if (!result.success)
        throw new Error(
          "Vercel App configuration is unavailable. Check that you can read and manage this app, or ask a team owner to finish setup.",
        );
      return result.data.app;
    } catch (error) {
      if (error instanceof AppApiError && error.code === "invalid_client") return undefined;
      throw error;
    }
  };
  const projectPath = `/v9/projects/${encodeURIComponent(project.projectId)}`;
  const remote = z
    .object({
      id: z.string(),
      accountId: z.string(),
      name: z.string(),
      oidcTokenConfig: z
        .object({
          enabled: z.boolean().optional(),
          issuerMode: z.enum(["team", "global"]).optional(),
        })
        .optional(),
    })
    .parse(await request(projectPath));
  if (remote.id !== project.projectId || remote.accountId !== project.orgId) {
    throw new Error("The linked Vercel project is not available in the selected team.");
  }
  const allEnvs = z
    .object({ envs: z.array(EnvSchema) })
    .parse(await request(`${projectPath}/env`)).envs;
  const envs = allEnvs.filter((env) => !env.gitBranch && !env.customEnvironmentIds?.length);
  const forTarget = (key: string, target: string) => {
    const matches = envs.filter(
      (env) =>
        env.key === key &&
        (typeof env.target === "string" ? [env.target] : (env.target ?? [])).includes(target),
    );
    if (matches.length > 1)
      throw new Error(
        "Web Chat has conflicting environment variables. Check production and preview before retrying.",
      );
    return matches[0];
  };
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
          clientAuthenticationMethods: {},
          signInFrom: "owning-team",
        }),
      );
    } catch (error) {
      if (!(error instanceof AppApiError)) throw error;
      signal?.throwIfAborted();
      // Another attempt may have created the app before this failure.
      app = await getApp(slug).catch(() => {
        signal?.throwIfAborted();
        throw error;
      });
      if (!app) throw error;
    }
  }
  assertMatchingApp(app, project, configuredId !== undefined);
  const configuredMethods = TARGETS.map((target) => forTarget(AUTH_METHOD_KEY, target)?.value);
  if (
    configuredMethods.some(
      (method) =>
        method !== undefined && method !== "oidc_token" && method !== "client_secret_post",
    ) ||
    new Set(configuredMethods.filter(Boolean)).size > 1
  ) {
    throw new Error(
      "Web Chat has conflicting authentication methods. Check production and preview environment variables before retrying.",
    );
  }
  const method =
    configuredMethods.find(Boolean) ??
    (app.clientAuthenticationMethods?.client_secret_post ? "client_secret_post" : "oidc_token");
  if (
    method === "oidc_token" &&
    Object.entries(app.clientAuthenticationMethods ?? {}).some(
      ([key, enabled]) => enabled && key !== "oidc_token",
    )
  ) {
    throw new Error(
      "The Vercel App does not match OIDC client authentication. Check its settings before retrying.",
    );
  }
  if (method === "oidc_token") {
    if (
      TARGETS.some((target) => forTarget(KEYS[1], target)) ||
      remote.oidcTokenConfig?.enabled === false
    ) {
      throw new Error(
        "Web Chat OIDC setup requires project OIDC tokens and no existing client-secret configuration. Check the project settings before retrying.",
      );
    }
    const team = z
      .object({ id: z.string(), slug: z.string().min(1) })
      .parse(await request(`/v2/teams/${encodeURIComponent(project.orgId)}`));
    if (team.id !== project.orgId) throw new Error("The Vercel team is unavailable.");
    const provider = {
      issuerUrl:
        remote.oidcTokenConfig?.issuerMode === "global"
          ? "https://oidc.vercel.com"
          : `https://oidc.vercel.com/${team.slug}`,
      claims: {
        aud: [`https://vercel.com/${team.slug}`],
        owner_id: [team.id],
        project_id: [project.projectId],
        environment: [...TARGETS],
      },
    };
    const matches = (candidate: App): boolean =>
      candidate.clientAuthenticationMethods?.oidc_token === true &&
      Object.entries(candidate.clientAuthenticationMethods).every(
        ([key, enabled]) => !enabled || key === "oidc_token",
      ) &&
      candidate.oidcProviders?.length === 1 &&
      candidate.oidcProviders[0]?.issuerUrl === provider.issuerUrl &&
      Object.keys(candidate.oidcProviders[0].claims).length ===
        Object.keys(provider.claims).length &&
      Object.entries(provider.claims).every(([claim, values]) => {
        const actual = candidate.oidcProviders?.[0]?.claims[claim];
        return actual?.length === values.length && values.every((value) => actual.includes(value));
      });
    if (!matches(app)) {
      if (
        Object.values(app.clientAuthenticationMethods ?? {}).some(Boolean) ||
        app.oidcProviders?.length
      ) {
        throw new Error(
          "The Vercel App's OIDC trust does not match this project and environments. Check the app in team settings before retrying.",
        );
      }
      await request(`/oauth-apps/${encodeURIComponent(app.clientId)}`, "PATCH", {
        clientAuthenticationMethods: { oidc_token: true },
        oidcProviders: [provider],
      });
      const configured = await getApp(app.clientId);
      if (!configured || !matches(configured))
        throw new Error("Vercel App OIDC configuration is incomplete. Retry setup.");
      assertMatchingApp(configured, project, configuredId !== undefined);
    }
    const oidcValues = {
      VERCEL_APP_CLIENT_ID: app.clientId,
      VERCEL_APP_AUTH_METHOD: "oidc_token",
      BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    };
    const variables = Object.entries(oidcValues).flatMap(([key, value]) => {
      const target = TARGETS.filter((target) => !forTarget(key, target));
      return target.length
        ? [
            {
              key,
              value,
              target,
              type: key === "BETTER_AUTH_SECRET" ? "sensitive" : "plain",
              visibility: key === "BETTER_AUTH_SECRET" ? "secret" : "config",
            },
          ]
        : [];
    });
    if (!variables.length) return;
    const result = z
      .object({ created: z.array(EnvSchema), failed: z.array(z.unknown()) })
      .parse(
        await request(
          `/v10/projects/${encodeURIComponent(project.projectId)}/env`,
          "POST",
          variables,
        ),
      );
    // Preserve successful writes so retries reuse the session secret, even after partial failures.
    if (result.failed.length)
      throw new Error(
        "Web Chat auth environment setup is incomplete. Retry `eve add channel/web --skip-install`.",
      );
    return;
  }
  if (!app.clientAuthenticationMethods?.client_secret_post) {
    throw new Error(
      "The Vercel App does not match the project's existing client-secret authentication. Check its settings before retrying.",
    );
  }
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
  const rollback = async (created: z.infer<typeof EnvSchema>[]): Promise<void> => {
    const results = await Promise.allSettled(
      created.map((env) => request(`${projectPath}/env/${encodeURIComponent(env.id)}`, "DELETE")),
    );
    // Do not revoke a credential that may still be saved in the project.
    const secretStillSaved = results.some(
      (result, index) => result.status === "rejected" && created[index]?.key === KEYS[1],
    );
    if (clientSecret && !secretStillSaved) {
      results.push(
        ...(await Promise.allSettled([
          request(
            `/oauth-apps/${encodeURIComponent(app.clientId)}/secret/${encodeURIComponent(clientSecret.slice(-4))}`,
            "DELETE",
          ),
        ])),
      );
    }
    if (results.some((result) => result.status === "rejected")) {
      throw new Error(
        "Could not save Web Chat auth environment variables. Cleanup was incomplete. Check the project's environment variables and Vercel App client secrets in team settings before retrying.",
      );
    }
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
      ).catch(async (error: unknown) => {
        // Validation and permission rejections did not commit env writes.
        // Timeouts and server failures can happen after a write committed.
        if (
          error instanceof AppApiError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 499
        ) {
          await rollback([]);
        }
        throw error;
      }),
    );
  if (result.failed.length === 0) return;

  // Only roll back writes acknowledged by this attempt. An ambiguous network
  // failure may have committed the secret, so it must remain usable on retry.
  await rollback(result.created);
  throw new Error(
    "Could not save Web Chat auth environment variables. Retry `eve add channel/web --skip-install`.",
  );
}
