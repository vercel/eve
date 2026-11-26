import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const UNSCOPED_EVENTS = new Set([
  "ping",
  "security_advisory",
  "installation",
  "installation_repositories",
  "installation_target",
]);
const scopesModulePath = join(
  packageRoot,
  "src",
  "public",
  "channels",
  "github",
  "webhook-scopes.ts",
);

export function deriveWebhookScopes() {
  const document = require("@octokit/openapi-webhooks/generated/api.github.com.json");

  const resolve = (schema) => {
    if (schema === undefined) return [];
    if (schema.$ref !== undefined) {
      const name = schema.$ref.replace("#/components/schemas/", "");
      return resolve(document.components.schemas[name]);
    }
    const branches = [...(schema.allOf ?? []), ...(schema.oneOf ?? []), ...(schema.anyOf ?? [])];
    return [schema, ...branches.flatMap(resolve)];
  };
  const properties = (schema) => {
    const merged = new Map();
    for (const part of resolve(schema)) {
      for (const [name, child] of Object.entries(part.properties ?? {})) {
        merged.set(name, [...(merged.get(name) ?? []), child]);
      }
    }
    return merged;
  };
  const items = (schema) => resolve(schema).flatMap((part) => resolve(part.items));
  const hasNumber = (schemas) => schemas.some((schema) => properties(schema).has("number"));
  const listsPullRequests = (children) => children.some((child) => hasNumber(items(child)));

  const scopes = {};
  for (const operation of Object.values(document.webhooks)) {
    const name = operation.post.operationId
      .replace("/sample.collected", "")
      .replace("/", ".")
      .replaceAll("-", "_");
    const payload = operation.post.requestBody.content["application/json"].schema;
    const top = properties(payload);
    const types = operation.post["x-github"]["supported-webhook-types"];
    if (UNSCOPED_EVENTS.has(name.split(".")[0])) continue;
    if (!types.some((type) => ["repository", "organization", "app"].includes(type))) continue;
    if (!top.has("repository") && !top.has("organization")) continue;

    const numbers = new Set();
    for (const [key, children] of top) {
      if ((key === "issue" || key === "pull_request") && hasNumber(children)) numbers.add(key);
      if (key === "pull_requests" && listsPullRequests(children)) numbers.add(key);
      for (const nested of properties({ allOf: children }).get("pull_requests") ?? []) {
        if (hasNumber(items(nested))) numbers.add(`${key}.pull_requests`);
      }
    }
    scopes[name] = { repo: top.has("repository"), numbers: [...numbers].sort() };
  }
  return Object.fromEntries(Object.entries(scopes).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function renderWebhookScopes(scopes) {
  const rows = Object.entries(scopes).map(
    ([name, { repo, numbers }]) =>
      `  ${JSON.stringify(name)}: { repo: ${repo}, numbers: [${numbers.map((path) => JSON.stringify(path)).join(", ")}] },`,
  );
  return [
    "export interface GitHubWebhookScope {",
    "  readonly repo: boolean;",
    "  readonly numbers: readonly string[];",
    "}",
    "",
    "export const GITHUB_WEBHOOK_SCOPES = {",
    ...rows,
    "} as const satisfies Record<string, GitHubWebhookScope>;",
    "",
    "type GitHubWebhookScopeName = keyof typeof GITHUB_WEBHOOK_SCOPES;",
    "",
    "type GitHubWebhookName<Name extends string> = Name extends `${infer Event}.${string}`",
    "  ? Event",
    "  : Name;",
    "",
    "/** A GitHub webhook event with its action, such as `check_suite.completed`, or an event for all its actions, such as `check_suite`. */",
    "export type GitHubWebhookEventName =",
    "  | GitHubWebhookScopeName",
    "  | GitHubWebhookName<GitHubWebhookScopeName>;",
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(scopesModulePath, renderWebhookScopes(deriveWebhookScopes()));
}
