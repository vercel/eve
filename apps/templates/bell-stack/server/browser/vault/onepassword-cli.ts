import { execFile } from "node:child_process";

import { z } from "zod";

import type { OnePasswordLogin, SafeLoginItem } from "./onepassword";

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const vaultSchema = z.object({
  id,
  name: z.string().optional(),
  title: z.string().optional(),
});
const fieldSchema = z.object({
  id: z.string().optional(),
  purpose: z.string().optional(),
  type: z.string().optional(),
  value: z.string().optional(),
});
const itemSchema = z.object({
  id,
  vault: z.object({ id }),
  title: z.string(),
  category: z.literal("LOGIN"),
  fields: z.array(fieldSchema),
  urls: z.array(z.object({
    href: z.string(),
    autofillBehavior: z.string().optional(),
  })).default([]),
});
type CliItem = z.infer<typeof itemSchema>;

export async function listCliLogins(): Promise<SafeLoginItem[]> {
  const run = configuredCli();
  try {
    const vaults = vaultSchema.array().parse(JSON.parse(await run(["vault", "list", "--format=json"])));
    const result: SafeLoginItem[] = [];
    for (const vault of vaults) {
      const items = z.object({ id }).array().parse(JSON.parse(await run([
        "item", "list", `--vault=${vault.id}`, "--categories=Login", "--format=json",
      ])));
      for (const overview of items) {
        const item = await readItem(run, vault.id, overview.id);
        result.push({
          itemId: item.id,
          vaultId: vault.id,
          vaultName: vault.name || vault.title || vault.id,
          label: item.title,
          allowedHosts: allowedHosts(item),
          fields: {
            username: Boolean(fieldValue(item, "username")),
            password: Boolean(fieldValue(item, "password")),
            totp: item.fields.some((field) => field.type?.toUpperCase() === "OTP"),
          },
        });
      }
    }
    return result;
  } catch {
    throw new Error("Could not list 1Password CLI logins. Check the CLI installation, configured account, and vault permissions.");
  }
}

export async function readCliLogin(vaultId: string, itemId: string): Promise<OnePasswordLogin> {
  const run = configuredCli();
  if (!id.safeParse(vaultId).success || !id.safeParse(itemId).success)
    throw new Error("Invalid 1Password vault or item ID.");
  try {
    const item = await readItem(run, vaultId, itemId),
      username = fieldValue(item, "username"),
      password = fieldValue(item, "password");
    if (!username || !password) throw new Error();
    let totp: string | undefined;
    if (item.fields.some((field) => field.type?.toUpperCase() === "OTP")) {
      // Ask the CLI for a generated code; never pass the stored OTP seed to the browser.
      const code = await run(["item", "get", `--vault=${vaultId}`, "--otp", "--", itemId])
        .then((value) => value.trim()).catch(() => "");
      if (/^\d{6,8}$/.test(code)) totp = code;
    }
    return { allowedHosts: allowedHosts(item), username, password, ...(totp ? { totp } : {}) };
  } catch {
    throw new Error("Could not read the 1Password CLI login. Check the item handle, configured account, and vault permissions.");
  }
}

async function readItem(run: ReturnType<typeof configuredCli>, vaultId: string, itemId: string) {
  const item = itemSchema.parse(JSON.parse(await run([
    "item", "get", `--vault=${vaultId}`, "--format=json", "--", itemId,
  ])));
  if (item.id !== itemId || item.vault.id !== vaultId) throw new Error();
  return item;
}

function fieldValue(item: CliItem, name: "username" | "password") {
  return item.fields.find((field) => field.id === name || field.purpose?.toLowerCase() === name)?.value;
}

function allowedHosts(item: CliItem): string[] {
  // CLI versions may omit autofill policies. This explicit compatibility mode uses saved
  // website hosts; use the default SDK mode to enforce 1Password's Never autofill policy.
  return [...new Set(item.urls.flatMap((site) => {
    if (site.autofillBehavior?.toLowerCase() === "never") return [];
    try {
      return [new URL(site.href).hostname.toLowerCase()].filter(Boolean);
    } catch {
      return [];
    }
  }))];
}

function configuredCli() {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim(),
    account = process.env.OP_ACCOUNT?.trim();
  if (!token && !account)
    throw new Error("Set OP_SERVICE_ACCOUNT_TOKEN or an explicit OP_ACCOUNT account ID for 1Password CLI access.");
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === "OP_CONNECT_HOST" || name === "OP_CONNECT_TOKEN" || name.startsWith("OP_SESSION"))
      delete env[name];
  }
  delete env.OP_ACCOUNT;
  delete env.OP_SERVICE_ACCOUNT_TOKEN;
  env.OP_DEBUG = "false";
  if (token) env.OP_SERVICE_ACCOUNT_TOKEN = token;
  const accountArgs = token ? [] : [`--account=${account}`];
  return (args: string[]): Promise<string> => new Promise((resolve, reject) => {
    execFile("op", [...accountArgs, ...args], {
      env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error) reject(new Error("The 1Password CLI request failed."));
      else resolve(stdout);
    });
  });
}
