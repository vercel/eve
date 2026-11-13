import type { Client, Item } from "@1password/sdk";

import { listCliLogins, readCliLogin } from "./onepassword-cli";

export interface SafeLoginItem {
  itemId: string;
  vaultId: string;
  vaultName: string;
  label: string;
  allowedHosts: string[];
  fields: { username: boolean; password: boolean; totp: boolean };
}

export interface OnePasswordLogin {
  allowedHosts: string[];
  username: string;
  password: string;
  totp?: string;
}

export class OnePasswordVault {
  private client?: Promise<Client>;

  async list(): Promise<SafeLoginItem[]> {
    if (backend() === "cli") return listCliLogins();
    const client = await this.getClient();
    try {
      const sdk = await import("@1password/sdk"),
        vaults = await client.vaults.list({ decryptDetails: true }),
        items: SafeLoginItem[] = [];
      for (const vault of vaults) {
        for (const overview of await client.items.list(vault.id)) {
          if (overview.category !== sdk.ItemCategory.Login) continue;
          const item = await client.items.get(vault.id, overview.id);
          if (item.category !== sdk.ItemCategory.Login) continue;
          items.push({
            itemId: item.id,
            vaultId: vault.id,
            vaultName: vault.title,
            label: item.title,
            allowedHosts: allowedHosts(item),
            fields: {
              username: Boolean(item.fields.find((field) => field.id === "username")?.value),
              password: Boolean(item.fields.find((field) => field.id === "password")?.value),
              totp: item.fields.some((field) => field.fieldType === sdk.ItemFieldType.Totp),
            },
          });
        }
      }
      return items;
    } catch {
      throw new Error("Could not list 1Password logins. Check the configured account and vault permissions.");
    }
  }

  async login(vaultId: string, itemId: string): Promise<OnePasswordLogin> {
    if (backend() === "cli") return readCliLogin(vaultId, itemId);
    const client = await this.getClient(),
      sdk = await import("@1password/sdk");
    let item: Item;
    try {
      item = await client.items.get(vaultId, itemId);
    } catch {
      throw new Error("Could not read the 1Password login. Check the item handle and vault permissions.");
    }
    if (item.category !== sdk.ItemCategory.Login)
      throw new Error("The selected 1Password item is not a Login.");
    const username = item.fields.find((field) => field.id === "username")?.value,
      password = item.fields.find((field) => field.id === "password")?.value;
    if (!username || !password)
      throw new Error("The selected 1Password Login must contain a username and password.");
    const otp = item.fields.find((field) => field.fieldType === sdk.ItemFieldType.Totp),
      totp = otp?.details?.type === "Otp" ? otp.details.content.code : undefined;
    return { allowedHosts: allowedHosts(item), username, password, ...(totp ? { totp } : {}) };
  }

  private getClient(): Promise<Client> {
    if (!this.client) {
      const token = process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim(),
        account = process.env.OP_ACCOUNT?.trim();
      if (!token && !account)
        throw new Error("Set OP_SERVICE_ACCOUNT_TOKEN for hosted 1Password access or OP_ACCOUNT for the local desktop app.");
      this.client = (async () => {
        try {
          const sdk = await import("@1password/sdk");
          return await sdk.createClient({
            auth: token || new sdk.DesktopAuth(account!),
            integrationName: "Bell",
            integrationVersion: "0.1.0",
          });
        } catch {
          this.client = undefined;
          throw new Error("Could not connect to 1Password. Check the configured account and authorization.");
        }
      })();
    }
    return this.client;
  }
}

export const onePasswordVault = new OnePasswordVault();

function backend(): "sdk" | "cli" {
  const value = process.env.BELL_ONEPASSWORD_BACKEND?.trim() || "sdk";
  if (value !== "sdk" && value !== "cli")
    throw new Error("BELL_ONEPASSWORD_BACKEND must be sdk or cli.");
  return value;
}

function allowedHosts(item: Item): string[] {
  return [...new Set(item.websites.flatMap((site) => {
    if (site.autofillBehavior === "Never") return [];
    try {
      const host = new URL(site.url).hostname.toLowerCase();
      return host ? [host] : [];
    } catch {
      return [];
    }
  }))];
}
