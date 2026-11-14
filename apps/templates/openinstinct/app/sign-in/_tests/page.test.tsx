import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SignInPage from "../page";

vi.mock("next/headers", () => ({ headers: () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`Redirect: ${url}`);
  },
}));
vi.mock("@db/services/auth/session", () => ({
  getAuthSession: () => ({ user: { id: "phone-user" } }),
}));
vi.mock("@shared/environment", () => ({
  env: {},
  localPhoneAuthBypassEnabled: true,
}));
vi.mock("@app/sign-in/_components/local-form", () => ({
  LocalPhoneAuthForm: ({ callbackUrl }: { readonly callbackUrl: string }) =>
    createElement("form", { action: callbackUrl }),
}));

describe("phone sign-in reauthentication", () => {
  it("allows an already signed-in user to verify again and return to Link", async () => {
    const html = renderToStaticMarkup(
      await SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({
          reauthenticate: "true",
          callbackUrl: "/link",
        }),
      })
    );

    expect(html).toContain("Sign in again");
    expect(html).toContain('action="/link"');
  });

  it("still redirects signed-in users outside the reauthentication flow", async () => {
    await expect(
      SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({ callbackUrl: "/link" }),
      })
    ).rejects.toThrow("Redirect: /");
  });

  it.each([
    "//attacker.example",
    "/\\attacker.example",
    "/\n/attacker.example",
    "/%0a/attacker.example",
    "/%5cattacker.example",
    "/link/..//attacker.example",
    "https://attacker.example",
  ])("keeps the callback %j on this app", async (callbackUrl) => {
    const html = renderToStaticMarkup(
      await SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({
          reauthenticate: "true",
          callbackUrl,
        }),
      })
    );

    expect(html).toContain('action="/"');
    expect(html).not.toContain("attacker.example");
    const action = /action="([^"]*)"/u.exec(html)?.[1];
    expect(new URL(action ?? "", "https://assistant.example").href).toBe(
      "https://assistant.example/"
    );
  });

  it("preserves a local callback's query and hash after URL normalization", async () => {
    const html = renderToStaticMarkup(
      await SignInPage({
        params: Promise.resolve({}),
        searchParams: Promise.resolve({
          reauthenticate: "true",
          callbackUrl: "/chat/../link?account=google#connect",
        }),
      })
    );
    const action = /action="([^"]*)"/u.exec(html)?.[1];
    expect(action).toBe("/link?account=google#connect");
    expect(new URL(action ?? "", "https://assistant.example").href).toBe(
      "https://assistant.example/link?account=google#connect"
    );
  });
});
