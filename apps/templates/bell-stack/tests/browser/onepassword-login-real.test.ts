import { describe, expect, it } from "vitest";

import { BrowserSession } from "../../server/browser/browser-session.js";
import type { ConversationState } from "../../server/browser/types.js";
import { onePasswordVault } from "../../server/browser/vault/onepassword.js";

const live =
  process.env.BELL_LIVE_ONEPASSWORD === "1" &&
  Boolean(process.env.BROWSERBASE_API_KEY) &&
  Boolean(process.env.OP_SERVICE_ACCOUNT_TOKEN || process.env.OP_ACCOUNT);

describe("opt-in live 1Password login", () => {
  it.runIf(live)(
    "uses a Login item without exposing credentials to the model",
    async () => {
      const items = await onePasswordVault.list(),
        item = items.find((candidate) =>
          candidate.label === "Bell integration test (authenticationtest.com)" &&
          candidate.allowedHosts.includes("authenticationtest.com"));
      expect(item).toBeDefined();
      expect(item?.fields).toEqual({
        username: true,
        password: true,
        totp: true,
      });
      if (!item?.vaultId) throw new Error("The test Login item is missing.");
      const state: ConversationState = {
        id: "live-onepassword-login",
        traces: [],
        browser: { provider: "not-started", status: "idle" },
      };
      const session = new BrowserSession(state);
      try {
        await session.run([
          {
            action: "goto",
            url: "https://authenticationtest.com/totpChallenge/",
          },
        ]);
        const login = await onePasswordVault.login(item.vaultId, item.itemId);
        const result = await session.secureLogin({
          ...login,
          usernameTarget: "#email",
          passwordTarget: "#password",
          totpTarget: "#totpmfa",
          submitTarget: 'input[type="submit"]',
          successTarget: "div.alert.alert-success",
        });
        const page = await session.snapshot();
        expect(result.status).toBe("complete");
        expect(new URL(result.url).pathname).toBe("/loginSuccess/");
        expect(page.tree).toContain("Login Success");
        expect(page.tree).toContain("You are now logged in");
        const visible = JSON.stringify({ result, traces: state.traces });
        expect([login.username, login.password, login.totp]
          .some((secret) => secret && visible.includes(secret))).toBe(false);
        console.log(
          JSON.stringify(
            {
              status: "pass",
              host: result.host,
              finalPath: new URL(result.url).pathname,
              pagePreview: page.tree.slice(0, 500),
              secretValuesPrinted: false,
            },
            null,
            2,
          ),
        );
      } finally {
        await session.close();
      }
    },
    120_000,
  );
});
