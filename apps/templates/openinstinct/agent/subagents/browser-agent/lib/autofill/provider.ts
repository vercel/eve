import {
  hasVaultSecret,
  listVaultItems,
  readVaultItem,
  readVaultSecret,
} from "@db/services/vault";
import {
  parseAddressVaultPayload,
  parseContactVaultPayload,
  parseLoginVaultPayload,
  parsePaymentCardSecret,
  type VaultItemKind,
} from "@shared/vault/schema";
import type { DetectedAutofillSurface } from "./protocol";
import type { AutofillVaultAdapter } from "./service";

interface VaultAutofillCodec {
  readonly claims: (
    item: NonNullable<Awaited<ReturnType<typeof readVaultItem>>>,
    secret: string,
    origin: string
  ) => ReadonlyMap<string, string>;
  readonly isAvailableAtOrigin?: (secret: string, origin: string) => boolean;
  readonly matchReason: string;
  readonly surfaceKinds: readonly DetectedAutofillSurface["kind"][];
  readonly tokens: readonly string[];
  readonly vaultKind: VaultItemKind;
}

const codecs: readonly VaultAutofillCodec[] = [
  {
    claims(_item, secret) {
      const card = parsePaymentCardSecret(secret);
      return new Map([
        ["cc-name", card.cardholderName],
        ["cc-number", card.number],
        [
          "cc-exp",
          `${String(card.expirationMonth).padStart(2, "0")}/${String(card.expirationYear).slice(-2)}`,
        ],
        ["cc-exp-month", String(card.expirationMonth).padStart(2, "0")],
        ["cc-exp-year", String(card.expirationYear)],
        ["cc-csc", card.securityCode],
        ["postal-code", card.billingPostalCode],
      ]);
    },
    matchReason: "Saved payment card",
    surfaceKinds: ["payment-card"],
    tokens: [
      "cc-name",
      "cc-number",
      "cc-exp",
      "cc-exp-month",
      "cc-exp-year",
      "cc-csc",
      "postal-code",
    ],
    vaultKind: "payment",
  },
  {
    claims(_item, secret, origin) {
      const login = requireBoundLogin(secret, origin);
      const values = new Map<string, string>([
        ["username", login.identifier.value],
      ]);
      if (login.identifier.type === "email") {
        values.set("email", login.identifier.value);
      }
      if (login.identifier.type === "phone") {
        values.set("tel", login.identifier.value);
      }
      if (login.authentication.type === "password") {
        values.set("current-password", login.authentication.password);
      }
      return values;
    },
    isAvailableAtOrigin: isBoundLoginForOrigin,
    matchReason: "Saved login",
    surfaceKinds: ["credentials", "contact"],
    tokens: ["username", "current-password", "email", "tel"],
    vaultKind: "login",
  },
  {
    claims(_item, secret) {
      const address = parseAddressVaultPayload(secret);
      if (!address) return new Map([["street-address", secret]]);

      const values = new Map<string, string>([
        ["name", address.recipientName],
        ["street-address", formatStreetAddress(address)],
        ["address-line1", address.line1],
        ["address-level2", address.city],
        ["address-level1", address.region],
        ["postal-code", address.postalCode],
        ["country", address.countryCode],
        ["country-name", countryName(address.countryCode)],
      ]);
      if (address.line2) values.set("address-line2", address.line2);
      return values;
    },
    matchReason: "Saved address",
    surfaceKinds: ["postal-address", "identity"],
    tokens: [
      "name",
      "street-address",
      "address-line1",
      "address-line2",
      "address-level2",
      "address-level1",
      "postal-code",
      "country",
      "country-name",
    ],
    vaultKind: "address",
  },
  {
    claims(_item, secret) {
      return new Map([["tel", secret]]);
    },
    matchReason: "Saved phone number",
    surfaceKinds: ["contact"],
    tokens: ["tel"],
    vaultKind: "phone",
  },
  {
    claims(_item, secret) {
      const contact = parseContactVaultPayload(secret);
      if (!contact) {
        throw new Error("The saved contact is incomplete or invalid.");
      }
      const values = new Map<string, string>();
      if (contact.fullName) values.set("name", contact.fullName);
      if (contact.email) values.set("email", contact.email);
      if (contact.phone) values.set("tel", contact.phone);
      if (contact.dateOfBirth) {
        const [year, month, day] = contact.dateOfBirth.split("-");
        if (year && month && day) {
          values.set("bday-day", day);
          values.set("bday-month", month);
          values.set("bday-year", year);
        }
      }
      return values;
    },
    matchReason: "Saved contact",
    surfaceKinds: ["contact", "identity"],
    tokens: ["name", "email", "tel", "bday-day", "bday-month", "bday-year"],
    vaultKind: "contact",
  },
  {
    claims(_item, secret) {
      return new Map([["name", secret]]);
    },
    matchReason: "Saved identity",
    surfaceKinds: ["identity"],
    tokens: ["name"],
    vaultKind: "identity",
  },
  {
    claims(_item, secret) {
      return new Map([["eve-secret", secret]]);
    },
    matchReason: "Saved secret",
    surfaceKinds: ["secret"],
    tokens: ["eve-secret"],
    vaultKind: "token",
  },
];

export const vaultAutofillProvider: AutofillVaultAdapter = {
  async listSuggestions(scope, origin, surface) {
    const compatibleCodecs = codecsForSurface(surface);
    if (compatibleCodecs.length === 0) return [];

    const items = await listVaultItems(scope);
    const compatibleItems = items.flatMap((item) => {
      const codec = compatibleCodecs.find(
        (candidate) =>
          candidate.vaultKind === item.kind &&
          surface.fields.some(({ token }) => candidate.tokens.includes(token))
      );
      return codec ? [{ codec, item }] : [];
    });
    const availability = await Promise.all(
      compatibleItems.map(async ({ codec, item }) => {
        if (!codec.isAvailableAtOrigin) {
          return hasVaultSecret(scope, item.id);
        }
        const secret = await readVaultSecret(scope, item.id);
        return (
          secret !== undefined && codec.isAvailableAtOrigin(secret, origin)
        );
      })
    );

    return compatibleItems.flatMap(({ codec, item }, index) => {
      if (!availability[index]) return [];
      return [
        {
          candidateId: item.id,
          label: item.label,
          matchReason: codec.matchReason,
          summary: item.account,
        },
      ];
    });
  },

  async materializeClaims(scope, candidateId, target) {
    const item = await readVaultItem(scope, candidateId);
    if (!item) throw new Error("The selected vault item was not found.");

    const codec = codecs.find(
      (candidate) =>
        candidate.vaultKind === item.kind &&
        candidate.surfaceKinds.includes(target.surface.kind)
    );
    if (!codec) {
      throw new Error(
        "The selected vault item is not compatible with this form."
      );
    }

    const secret = await readVaultSecret(scope, item.id);
    if (!secret) throw new Error("The selected vault item has no secret.");

    const values = codec.claims(item, secret, target.origin);
    return [...target.availableTokens].flatMap((token) => {
      const value = values.get(token);
      return value ? [{ id: crypto.randomUUID(), token, value }] : [];
    });
  },
};

function codecsForSurface(surface: DetectedAutofillSurface) {
  return codecs.filter((codec) => codec.surfaceKinds.includes(surface.kind));
}

function isBoundLoginForOrigin(secret: string, origin: string) {
  const login = parseLoginVaultPayload(secret);
  return Boolean(login && "origin" in login && login.origin === origin);
}

function requireBoundLogin(secret: string, origin: string) {
  const login = parseLoginVaultPayload(secret);
  if (!login || !("origin" in login)) {
    throw new Error(
      "This saved login is not assigned to a website. Re-save it before autofill."
    );
  }
  if (login.origin !== origin) {
    throw new Error(`This saved login is restricted to ${login.origin}.`);
  }
  return login;
}

function formatStreetAddress(
  address: NonNullable<ReturnType<typeof parseAddressVaultPayload>>
) {
  return [address.line1, address.line2].filter(Boolean).join("\n");
}

function countryName(countryCode: string) {
  try {
    return (
      new Intl.DisplayNames("en", { type: "region" }).of(countryCode) ??
      countryCode
    );
  } catch {
    return countryCode;
  }
}
