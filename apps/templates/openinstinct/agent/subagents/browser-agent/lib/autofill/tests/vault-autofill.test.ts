import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AccessScope } from "@shared/identity/access-scope";
import {
  serializeAddressVaultPayload,
  serializeContactVaultPayload,
  serializeLoginVaultPayload,
  serializePaymentCard,
  type VaultItemKind,
} from "@shared/vault/schema";
import {
  classifyNativeLoginControl,
  frameOriginExpression,
  nativeLoginFillFunctionDeclaration,
  selectNativeLoginFills,
  type NativeLoginControlDescriptor,
} from "@agent/subagents/browser-agent/lib/autofill/login";
import {
  buildNativeAutofillPayload,
  nativeAutofillSecretMarkingExpression,
  nativeAutofillTokens,
} from "@agent/subagents/browser-agent/lib/autofill/native";
import {
  listAutofillSuggestions,
  materializeAutofillClaims,
  type AutofillVaultAdapter,
} from "@agent/subagents/browser-agent/lib/autofill/service";
import { vaultAutofillProvider } from "@agent/subagents/browser-agent/lib/autofill/provider";

interface VaultStore {
  items: { id: string }[];
  secret: string;
}

function createVaultStore(): VaultStore {
  return {
    items: [],
    secret: "",
  };
}

const vaultStore = vi.hoisted(createVaultStore);

vi.mock("@db/services/vault", () => ({
  hasVaultSecret: async () => true,
  listVaultItems: async () => vaultStore.items,
  readVaultItem: async (_scope: AccessScope, id: string) =>
    vaultStore.items.find((item) => item.id === id),
  readVaultSecret: async () => vaultStore.secret,
}));

const scope: AccessScope = {
  userId: "user-1",
  workspaceId: "workspace-1",
};

const paymentSurface = {
  fields: [
    { score: 100, token: "cc-number" },
    { score: 100, token: "cc-exp" },
  ],
  id: "payment-card",
  kind: "payment-card" as const,
};
const credentialsSurface = surface("credentials", [
  "username",
  "current-password",
]);
const contactSurface = surface("contact", [
  "email",
  "tel",
  "bday-day",
  "bday-month",
  "bday-year",
]);
const addressSurface = surface("postal-address", [
  "street-address",
  "address-line1",
  "address-line2",
  "address-level2",
  "address-level1",
  "postal-code",
  "country",
  "country-name",
]);

describe("vault browser autofill", () => {
  it("uses the encrypted local vault instead of a development card fixture", async () => {
    const card = {
      account: "Visa · •••• 1111",
      createdAt: "2026-08-27T00:00:00.000Z",
      id: "real-card-id",
      kind: "payment" as const,
      label: "Travel card",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    const provider = providerFor(
      card,
      serializePaymentCard({
        billingPostalCode: "10001",
        cardholderName: "Grace Hopper",
        expirationMonth: 9,
        expirationYear: 2031,
        kind: "payment-card",
        number: "4111111111111111",
        securityCode: "321",
        version: 1,
      })
    );

    await expect(
      provider.listSuggestions(
        scope,
        "https://merchant.example",
        paymentSurface
      )
    ).resolves.toEqual([
      {
        candidateId: "real-card-id",
        label: "Travel card",
        matchReason: "Saved payment card",
        summary: "Visa · •••• 1111",
      },
    ]);

    const claims = await provider.materializeClaims(scope, "real-card-id", {
      availableTokens: new Set([
        "cc-name",
        "cc-number",
        "cc-exp",
        "cc-csc",
        "postal-code",
      ]),
      origin: "https://merchant.example",
      surface: paymentSurface,
    });
    expect(
      Object.fromEntries(claims.map(({ token, value }) => [token, value]))
    ).toEqual({
      "cc-csc": "321",
      "cc-exp": "09/31",
      "cc-name": "Grace Hopper",
      "cc-number": "4111111111111111",
      "postal-code": "10001",
    });
    const nativeClaims = await provider.materializeClaims(
      scope,
      "real-card-id",
      {
        availableTokens: new Set(nativeAutofillTokens.payment),
        origin: "https://merchant.example",
        surface: {
          ...paymentSurface,
          fields: nativeAutofillTokens.payment.map((token) => ({
            score: 100,
            token,
          })),
        },
      }
    );
    expect(
      Object.fromEntries(nativeClaims.map(({ token, value }) => [token, value]))
    ).toEqual({
      "cc-name": "Grace Hopper",
      "cc-number": "4111111111111111",
      "cc-exp-month": "09",
      "cc-exp-year": "2031",
      "cc-csc": "321",
      "postal-code": "10001",
    });
  });

  it("keeps structured logins bound to their saved origin", async () => {
    const login = vaultItem(
      "login",
      "Primary login",
      "checkout.example · a•••@example.com"
    );
    const provider = providerFor(
      login,
      serializeLoginVaultPayload({
        authentication: { password: "correct horse", type: "password" },
        identifier: { type: "email", value: "ada@example.com" },
        kind: "login",
        origin: "https://checkout.example",
        version: 2,
      })
    );

    await expect(
      provider.listSuggestions(
        scope,
        "https://checkout.example",
        credentialsSurface
      )
    ).resolves.toEqual([
      expect.objectContaining({
        candidateId: login.id,
        summary: "checkout.example · a•••@example.com",
      }),
    ]);
    await expect(
      provider.listSuggestions(
        scope,
        "https://attacker.example",
        credentialsSurface
      )
    ).resolves.toEqual([]);

    const claims = await provider.materializeClaims(scope, login.id, {
      availableTokens: new Set(["username", "current-password"]),
      origin: "https://checkout.example",
      surface: credentialsSurface,
    });
    expect(claimValues(claims)).toEqual({
      "current-password": "correct horse",
      username: "ada@example.com",
    });

    await expect(
      provider.materializeClaims(scope, login.id, {
        availableTokens: new Set(["username"]),
        origin: "https://attacker.example",
        surface: credentialsSurface,
      })
    ).rejects.toThrow("restricted to https://checkout.example");
  });

  it("materializes passwordless identifiers without an OTP", async () => {
    const login = vaultItem("login", "Email code", "a•••@example.com");
    const provider = providerFor(
      login,
      serializeLoginVaultPayload({
        authentication: { type: "email_otp" },
        identifier: { type: "email", value: "ada@example.com" },
        kind: "login",
        origin: "https://checkout.example",
        version: 2,
      })
    );

    const claims = await provider.materializeClaims(scope, login.id, {
      availableTokens: new Set(["email", "one-time-code"]),
      origin: "https://checkout.example",
      surface: contactSurface,
    });
    expect(claimValues(claims)).toEqual({ email: "ada@example.com" });
  });

  it("fails closed for legacy logins without an origin", async () => {
    const login = vaultItem("login", "Legacy", "a•••@example.com");
    const provider = providerFor(
      login,
      JSON.stringify({
        authentication: { password: "correct horse", type: "password" },
        identifier: { type: "email", value: "ada@example.com" },
        kind: "login",
        version: 1,
      })
    );

    await expect(
      provider.listSuggestions(
        scope,
        "https://checkout.example",
        credentialsSurface
      )
    ).resolves.toEqual([]);
    await expect(
      provider.materializeClaims(scope, login.id, {
        availableTokens: new Set(["username"]),
        origin: "https://checkout.example",
        surface: credentialsSurface,
      })
    ).rejects.toThrow("not assigned to a website");
  });

  it("maps structured addresses and contacts to standard tokens", async () => {
    const address = vaultItem("address", "Home", "");
    const addressProvider = providerFor(
      address,
      serializeAddressVaultPayload({
        city: "London",
        countryCode: "GB",
        kind: "address",
        line1: "12 St James's Square",
        line2: "Floor 2",
        postalCode: "SW1Y 4LB",
        recipientName: "Ada Lovelace",
        region: "London",
        version: 1,
      })
    );
    const addressClaims = await addressProvider.materializeClaims(
      scope,
      address.id,
      {
        availableTokens: new Set(
          addressSurface.fields.map(({ token }) => token)
        ),
        origin: "https://merchant.example",
        surface: addressSurface,
      }
    );
    expect(claimValues(addressClaims)).toEqual({
      "address-level1": "London",
      "address-level2": "London",
      "address-line1": "12 St James's Square",
      "address-line2": "Floor 2",
      country: "GB",
      "country-name": "United Kingdom",
      "postal-code": "SW1Y 4LB",
      "street-address": "12 St James's Square\nFloor 2",
    });

    const contact = vaultItem("contact", "Checkout", "");
    const contactProvider = providerFor(
      contact,
      serializeContactVaultPayload({
        dateOfBirth: "1815-12-10",
        email: "ada@example.com",
        fullName: "Ada Lovelace",
        kind: "contact",
        phone: "+442079460000",
        version: 1,
      })
    );
    const contactClaims = await contactProvider.materializeClaims(
      scope,
      contact.id,
      {
        availableTokens: new Set(
          contactSurface.fields.map(({ token }) => token)
        ),
        origin: "https://merchant.example",
        surface: contactSurface,
      }
    );
    expect(claimValues(contactClaims)).toEqual({
      "bday-day": "10",
      "bday-month": "12",
      "bday-year": "1815",
      email: "ada@example.com",
      tel: "+442079460000",
    });
  });

  it("lets a vault-owned adapter supply masked suggestions and claims", async () => {
    const adapter: AutofillVaultAdapter = {
      async listSuggestions(_scope, origin, targetSurface) {
        expect(origin).toBe("https://merchant.example");
        expect(targetSurface.kind).toBe("payment-card");
        return [
          {
            candidateId: "opaque-card",
            label: "Personal Visa",
            matchReason: "Preferred payment method",
            summary: "Visa •••• 4242",
          },
        ];
      },
      async materializeClaims(_scope, candidateId, target) {
        expect(candidateId).toBe("opaque-card");
        expect(target.surface.kind).toBe("payment-card");
        return [
          {
            id: "84e90f49-68d0-45ba-a183-3ca18ef087dc",
            token: "cc-number",
            value: "4242424242424242",
          },
        ];
      },
    };

    await expect(
      listAutofillSuggestions(
        scope,
        "https://merchant.example",
        paymentSurface,
        adapter
      )
    ).resolves.toEqual([
      {
        candidateId: "opaque-card",
        label: "Personal Visa",
        matchReason: "Preferred payment method",
        summary: "Visa •••• 4242",
      },
    ]);
    await expect(
      materializeAutofillClaims(
        scope,
        "opaque-card",
        {
          availableTokens: new Set(["cc-number", "cc-exp"]),
          origin: "https://merchant.example",
          surface: paymentSurface,
        },
        adapter
      )
    ).resolves.toEqual([
      {
        id: "84e90f49-68d0-45ba-a183-3ca18ef087dc",
        token: "cc-number",
        value: "4242424242424242",
      },
    ]);
  });

  it("builds Chromium card autofill parameters from vault claims", () => {
    expect(
      buildNativeAutofillPayload("payment", [
        claim("cc-name", "Grace Hopper"),
        claim("cc-number", "4111111111111111"),
        claim("cc-exp-month", "09"),
        claim("cc-exp-year", "2031"),
        claim("cc-csc", "321"),
      ])
    ).toEqual({
      card: {
        cvc: "321",
        expiryMonth: "09",
        expiryYear: "2031",
        name: "Grace Hopper",
        number: "4111111111111111",
      },
    });
    expect(nativeAutofillTokens.payment).toContain("cc-exp-month");
  });

  it("builds Chromium address fields from structured vault claims", () => {
    expect(
      buildNativeAutofillPayload("address", [
        claim("name", "Ada Lovelace"),
        claim("address-line1", "12 St James's Square"),
        claim("address-line2", "Floor 2"),
        claim("address-level2", "London"),
        claim("address-level1", "London"),
        claim("postal-code", "SW1Y 4LB"),
        claim("country", "GB"),
      ])
    ).toEqual({
      address: {
        fields: [
          { name: "NAME_FULL", value: "Ada Lovelace" },
          {
            name: "ADDRESS_HOME_LINE1",
            value: "12 St James's Square",
          },
          { name: "ADDRESS_HOME_LINE2", value: "Floor 2" },
          { name: "ADDRESS_HOME_CITY", value: "London" },
          { name: "ADDRESS_HOME_STATE", value: "London" },
          { name: "ADDRESS_HOME_ZIP", value: "SW1Y 4LB" },
          { name: "ADDRESS_HOME_COUNTRY", value: "GB" },
        ],
      },
    });
  });

  it("builds Chromium contact and birthdate fields from vault claims", () => {
    expect(
      buildNativeAutofillPayload("contact", [
        claim("name", "Ada Lovelace"),
        claim("email", "ada@example.com"),
        claim("tel", "+442079460000"),
        claim("bday-day", "10"),
        claim("bday-month", "12"),
        claim("bday-year", "1815"),
      ])
    ).toEqual({
      address: {
        fields: [
          { name: "NAME_FULL", value: "Ada Lovelace" },
          { name: "EMAIL_ADDRESS", value: "ada@example.com" },
          { name: "PHONE_HOME_WHOLE_NUMBER", value: "+442079460000" },
          { name: "BIRTHDATE_DAY", value: "10" },
          { name: "BIRTHDATE_MONTH", value: "12" },
          { name: "BIRTHDATE_4_DIGIT_YEAR", value: "1815" },
        ],
      },
    });
    expect(nativeAutofillTokens.contact).toContain("bday-year");
  });

  it.each(["address", "contact", "payment"])(
    "marks every %s form control before native autofill",
    () => {
      class FakeInput {
        readonly dataset: Record<string, string> = {};
        disabled = false;
        form: { querySelectorAll: () => FakeNodeList } | null = null;
        readOnly = false;
        type = "text";

        constructor(readonly value: string) {}

        closest() {
          return this.form;
        }
      }
      class FakeNodeList extends Array<FakeInput> {
        item(index: number) {
          return this[index] ?? null;
        }
      }
      const controls = new FakeNodeList(
        new FakeInput("4111111111111111"),
        new FakeInput("09/31"),
        new FakeInput("")
      );
      const form = { querySelectorAll: () => controls };
      for (const control of controls) control.form = form;
      const document = { querySelectorAll: () => controls };
      const markedCount = z.number().parse(
        runInNewContext(nativeAutofillSecretMarkingExpression(0), {
          document,
          HTMLInputElement: FakeInput,
        })
      );

      expect(markedCount).toBe(3);
      expect(controls.map(({ dataset }) => dataset.vaultSecret)).toEqual([
        "true",
        "true",
        "true",
      ]);
    }
  );

  it("writes login values only into a document served from the saved origin", () => {
    class FakeInput {
      readonly dataset: Record<string, string> = {};
      #value = "";

      get value() {
        return this.#value;
      }

      set value(next: string) {
        this.#value = next;
      }

      click() {
        this.dataset.clicked = "true";
      }

      focus() {
        this.dataset.focused = "true";
      }

      dispatchEvent() {
        return true;
      }
    }
    class FakeEvent {
      readonly bubbles = true;
    }
    const fill = (documentOrigin: string, expectedOrigin: string) => {
      const input = new FakeInput();
      const accepted = z.boolean().parse(
        runInNewContext(
          `(${nativeLoginFillFunctionDeclaration}).call(input, "hunter2", expectedOrigin)`,
          {
            Event: FakeEvent,
            expectedOrigin,
            HTMLInputElement: FakeInput,
            InputEvent: FakeEvent,
            input,
            self: { origin: documentOrigin },
          }
        )
      );
      return { accepted, value: input.value };
    };

    expect(
      fill("https://www.bank.example", "https://www.bank.example")
    ).toEqual({ accepted: true, value: "hunter2" });
    expect(
      fill("https://widget.bank.example", "https://www.bank.example")
    ).toEqual({ accepted: false, value: "" });
    expect(fill("null", "https://www.bank.example")).toEqual({
      accepted: false,
      value: "",
    });
    expect(
      runInNewContext(frameOriginExpression, { self: { origin: "null" } })
    ).toBe("null");
  });

  it("builds a Chromium address from the current free-form vault value", () => {
    expect(
      buildNativeAutofillPayload("address", [
        claim("street-address", "12 St James's Square\nLondon SW1Y 4LB"),
      ])
    ).toEqual({
      address: {
        fields: [
          {
            name: "ADDRESS_HOME_STREET_ADDRESS",
            value: "12 St James's Square\nLondon SW1Y 4LB",
          },
        ],
      },
    });
  });

  it("classifies current login controls without accepting OTP or new-password fields", () => {
    expect(
      classifyNativeLoginControl(
        loginControl({ autocomplete: "username webauthn" })
      )
    ).toMatchObject({ score: 100, token: "username" });
    expect(
      classifyNativeLoginControl(loginControl({ type: "password" }))
    ).toMatchObject({ score: 90, token: "current-password" });
    expect(
      classifyNativeLoginControl(
        loginControl({ autocomplete: "one-time-code", type: "text" })
      )
    ).toBeNull();
    expect(
      classifyNativeLoginControl(
        loginControl({ autocomplete: "new-password", type: "password" })
      )
    ).toBeNull();
  });

  it("selects one identifier and current password from the focused login form", () => {
    const controls = [
      classifiedLoginControl({
        focused: true,
        formIndex: 0,
        index: 0,
        token: "email",
      }),
      classifiedLoginControl({
        formIndex: 0,
        index: 1,
        token: "current-password",
      }),
      classifiedLoginControl({
        formIndex: 1,
        index: 2,
        score: 100,
        token: "current-password",
      }),
    ];

    expect(
      selectNativeLoginFills(controls, [
        claim("email", "ada@example.com"),
        claim("current-password", "correct horse"),
      ])
    ).toEqual([
      { control: controls[0], value: "ada@example.com" },
      { control: controls[1], value: "correct horse" },
    ]);
  });

  it("requires a focused login control and supports identifier-only steps", () => {
    const identifier = classifiedLoginControl({ token: "username" });
    expect(
      selectNativeLoginFills([identifier], [claim("username", "member-1")])
    ).toEqual([]);

    const focusedIdentifier = { ...identifier, focused: true };
    expect(
      selectNativeLoginFills(
        [focusedIdentifier],
        [
          claim("username", "member-1"),
          claim("current-password", "correct horse"),
        ]
      )
    ).toEqual([{ control: focusedIdentifier, value: "member-1" }]);
  });

  it("fills a username into a combined email-or-membership field", () => {
    const combinedIdentifier = classifiedLoginControl({
      focused: true,
      label: "Email or MileagePlus number",
      token: "email",
    });
    expect(
      selectNativeLoginFills(
        [combinedIdentifier],
        [claim("username", "member-1")]
      )
    ).toEqual([{ control: combinedIdentifier, value: "member-1" }]);
  });
});

function claim(token: string, value: string) {
  return { token, value };
}

function loginControl(
  overrides: Partial<NativeLoginControlDescriptor> = {}
): NativeLoginControlDescriptor {
  return {
    autocomplete: "",
    focused: false,
    formIndex: 0,
    index: 0,
    label: "",
    name: "",
    type: "text",
    ...overrides,
  };
}

function classifiedLoginControl(
  overrides: Partial<
    NonNullable<ReturnType<typeof classifyNativeLoginControl>>
  > = {}
) {
  return {
    ...loginControl(),
    score: 70,
    token: "username" as const,
    ...overrides,
  };
}

function surface(kind: string, tokens: readonly string[]) {
  return {
    fields: tokens.map((token) => ({ score: 100, token })),
    id: kind,
    kind,
  };
}

function vaultItem(kind: VaultItemKind, label: string, account: string) {
  return {
    account,
    createdAt: "2026-08-27T00:00:00.000Z",
    id: `vault-${kind}`,
    kind,
    label,
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

function providerFor(item: ReturnType<typeof vaultItem>, secret: string) {
  vaultStore.items = [item];
  vaultStore.secret = secret;
  return vaultAutofillProvider;
}

function claimValues(
  claims: readonly { readonly token: string; readonly value: string }[]
) {
  return Object.fromEntries(claims.map(({ token, value }) => [token, value]));
}
