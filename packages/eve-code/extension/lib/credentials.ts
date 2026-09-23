import type { MutableNetworkSandboxSession, SandboxSession } from "eve/sandbox";

import { toolingPaths } from "./tooling.ts";

export interface BrokeredCredentialOptions {
  readonly token: string;
  /**
   * `firewall` keeps the token outside the sandbox. `command` writes it into
   * git config or the CLI environment for backends without network policies.
   */
  readonly delivery?: "firewall" | "command";
  /** Consumer-owned network-policy merge for hosts and their injected headers. */
  readonly broker?: (
    sandbox: SandboxSession,
    rules: Record<string, Record<string, string>>,
  ) => Promise<void>;
}

// Keyed by session object because eve sessions expose no sandbox identity.
const headersBySandbox = new WeakMap<SandboxSession, Map<string, Record<string, string>>>();
const policyQueues = new WeakMap<SandboxSession, Promise<void>>();
const environmentQueues = new WeakMap<SandboxSession, Promise<void>>();

export async function authenticateGitHub(
  sandbox: SandboxSession,
  options: BrokeredCredentialOptions,
): Promise<void> {
  const authorization = `Basic ${Buffer.from(`x-access-token:${options.token}`).toString("base64")}`;
  if (options.delivery === "command") {
    const configured = await sandbox.run({
      command: `git config --global http.https://github.com/.extraheader ${shellQuote(`Authorization: ${authorization}`)}`,
    });
    if (configured.exitCode !== 0) {
      throw new Error(`Failed to configure GitHub authentication for git: ${configured.stderr}`);
    }
    await writeToolEnvironment(sandbox, "GH_TOKEN", options.token);
    return;
  }
  await brokerRules(
    sandbox,
    {
      "github.com": { authorization },
      "api.github.com": { authorization },
    },
    options.broker,
  );
}

export async function authenticateVercel(
  sandbox: SandboxSession,
  options: BrokeredCredentialOptions,
): Promise<void> {
  if (options.delivery === "command") {
    await writeToolEnvironment(sandbox, "VERCEL_TOKEN", options.token);
    return;
  }
  const headers = { authorization: `Bearer ${options.token}` };
  await brokerRules(sandbox, { "api.vercel.com": headers, "vercel.com": headers }, options.broker);
}

async function brokerRules(
  sandbox: SandboxSession,
  rules: Record<string, Record<string, string>>,
  custom: BrokeredCredentialOptions["broker"],
): Promise<void> {
  if (custom !== undefined) {
    await custom(sandbox, rules);
    return;
  }
  if (!hasMutableNetworkPolicy(sandbox)) {
    throw new Error(
      'eve-code firewall credential delivery requires a sandbox provider with mutable network policy (setNetworkPolicy). Use delivery: "command" or pass a broker callback.',
    );
  }

  const byHost = headersBySandbox.get(sandbox) ?? new Map();
  for (const [host, headers] of Object.entries(rules)) {
    byHost.set(host, { ...byHost.get(host), ...headers });
  }
  headersBySandbox.set(sandbox, byHost);
  const previous = policyQueues.get(sandbox) ?? Promise.resolve();
  const next = previous.then(async () => {
    const allow: Record<string, { transform: { headers: Record<string, string> }[] }[]> = {
      "*": [],
    };
    for (const [host, headers] of byHost) {
      allow[host] = [{ transform: [{ headers }] }];
    }
    await sandbox.setNetworkPolicy({ allow });
  });
  policyQueues.set(sandbox, next);
  try {
    await next;
  } finally {
    if (policyQueues.get(sandbox) === next) policyQueues.delete(sandbox);
  }
}

async function writeToolEnvironment(
  sandbox: SandboxSession,
  name: "GH_TOKEN" | "VERCEL_TOKEN",
  value: string,
): Promise<void> {
  const previous = environmentQueues.get(sandbox) ?? Promise.resolve();
  const next = previous.then(async () => {
    const path = toolingPaths(sandbox).env;
    const existing = (await sandbox.readTextFile({ path })) ?? "";
    const lines = existing
      .split("\n")
      .filter((line) => line.length > 0 && !line.startsWith(`export ${name}=`));
    lines.push(`export ${name}=${shellQuote(value)}`);
    await sandbox.writeTextFile({ path, content: `${lines.join("\n")}\n` });
    const secured = await sandbox.run({ command: `chmod 600 ${shellQuote(path)}` });
    if (secured.exitCode !== 0) {
      throw new Error(`Failed to secure eve-code CLI environment: ${secured.stderr}`);
    }
  });
  environmentQueues.set(sandbox, next);
  try {
    await next;
  } finally {
    if (environmentQueues.get(sandbox) === next) environmentQueues.delete(sandbox);
  }
}

function hasMutableNetworkPolicy(sandbox: SandboxSession): sandbox is MutableNetworkSandboxSession {
  return sandbox.setNetworkPolicy !== undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
