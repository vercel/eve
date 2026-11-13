import creditCardType from "credit-card-type";
import { z } from "zod";

export const vaultItemKinds = [
  "login",
  "payment",
  "address",
  "contact",
  "phone",
  "identity",
  "token",
] as const;

export const vaultItemKindSchema = z.enum(vaultItemKinds);

const vaultCreateItemKindSchema = vaultItemKindSchema.extract([
  "login",
  "payment",
  "address",
  "contact",
]);

const vaultItemSchema = z.object({
  account: z.string(),
  createdAt: z.string(),
  hasSecret: z.boolean(),
  id: z.string(),
  kind: vaultItemKindSchema,
  label: z.string(),
  updatedAt: z.string(),
});

const boundedValue = z.string().trim().min(1).max(20_000);
const optionalBoundedValue = z
  .string()
  .trim()
  .max(20_000)
  .optional()
  .transform((value) => (value?.length ? value : undefined));

export const loginIdentifierTypeSchema = z.enum(["email", "phone", "username"]);

export const loginOriginSchema = z.url().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol) && url.origin === value;
}, "Enter a website origin such as https://www.ubereats.com.");

const loginIdentifierValueSchema = z
  .string()
  .trim()
  .min(1, "Enter the sign-in identifier.")
  .max(300);

export const loginIdentifierSchema = z
  .object({
    type: loginIdentifierTypeSchema,
    value: loginIdentifierValueSchema,
  })
  .superRefine((identifier, context) => {
    if (
      identifier.type === "email" &&
      !z.email().safeParse(identifier.value).success
    ) {
      context.addIssue({
        code: "custom",
        message: "Enter a valid email identifier.",
        path: ["value"],
      });
    }
  });

const loginAuthenticationSchema = z.discriminatedUnion("type", [
  z.object({
    password: z.string().min(1).max(20_000),
    type: z.literal("password"),
  }),
  z.object({ type: z.literal("email_otp") }),
  z.object({ type: z.literal("sms_otp") }),
]);

const loginVaultPayloadBaseSchema = z.object({
  authentication: loginAuthenticationSchema,
  identifier: loginIdentifierSchema,
  kind: z.literal("login"),
});

const legacyLoginVaultPayloadSchema = loginVaultPayloadBaseSchema
  .extend({
    version: z.literal(1),
  })
  .superRefine(validateLoginVaultPayload);

export const loginVaultPayloadSchema = loginVaultPayloadBaseSchema
  .extend({
    origin: loginOriginSchema,
    version: z.literal(2),
  })
  .superRefine(validateLoginVaultPayload);

const readableLoginVaultPayloadSchema = z.union([
  loginVaultPayloadSchema,
  legacyLoginVaultPayloadSchema,
]);

function validateLoginVaultPayload(
  payload: z.infer<typeof loginVaultPayloadBaseSchema>,
  context: z.RefinementCtx
) {
  if (
    payload.authentication.type === "email_otp" &&
    payload.identifier.type !== "email"
  ) {
    context.addIssue({
      code: "custom",
      message: "Email OTP requires an email identifier.",
      path: ["identifier", "type"],
    });
  }
  if (
    payload.authentication.type === "sms_otp" &&
    payload.identifier.type !== "phone"
  ) {
    context.addIssue({
      code: "custom",
      message: "SMS OTP requires a phone identifier.",
      path: ["identifier", "type"],
    });
  }
}

export const addressVaultPayloadSchema = z.object({
  city: boundedValue,
  countryCode: z
    .string()
    .trim()
    .min(2)
    .max(2)
    .transform((value) => value.toUpperCase()),
  kind: z.literal("address"),
  line1: boundedValue,
  line2: optionalBoundedValue,
  postalCode: boundedValue,
  recipientName: boundedValue,
  region: boundedValue,
  version: z.literal(1),
});

export const contactVaultPayloadSchema = z
  .object({
    dateOfBirth: z.iso.date().optional(),
    email: optionalBoundedValue,
    fullName: optionalBoundedValue,
    kind: z.literal("contact"),
    phone: optionalBoundedValue,
    version: z.literal(1),
  })
  .superRefine((payload, context) => {
    if (payload.email && !z.email().safeParse(payload.email).success) {
      context.addIssue({
        code: "custom",
        message: "Enter a valid contact email.",
        path: ["email"],
      });
    }
  })
  .refine(
    (payload) =>
      [
        payload.dateOfBirth,
        payload.email,
        payload.fullName,
        payload.phone,
      ].some(Boolean),
    { message: "Enter at least one contact value." }
  );

export const loginVaultPayloadStringSchema = serializedPayloadSchema(
  loginVaultPayloadSchema,
  "Enter complete login details."
);
export const addressVaultPayloadStringSchema = serializedPayloadSchema(
  addressVaultPayloadSchema,
  "Enter a complete address."
);
export const contactVaultPayloadStringSchema = serializedPayloadSchema(
  contactVaultPayloadSchema,
  "Enter at least one contact value."
);

export const paymentCardSecretSchema = z.object({
  billingPostalCode: z.string().trim().min(1).max(20),
  cardholderName: z.string().trim().min(1).max(200),
  expirationMonth: z.number().int().min(1).max(12),
  expirationYear: z.number().int().min(2000).max(9999),
  kind: z.literal("payment-card"),
  number: z.string().regex(/^\d{12,19}$/u),
  securityCode: z.string().regex(/^\d{3,4}$/u),
  version: z.literal(1),
});

export const paymentCardSecretStringSchema = serializedPayloadSchema(
  paymentCardSecretSchema,
  "Enter complete, valid card details."
);

export const vaultCreateItemSchema = z
  .object({
    account: z.string().trim().max(200).default(""),
    kind: vaultCreateItemKindSchema,
    label: z.string().trim().min(1).max(120),
    secret: z.string().min(1).max(20_000),
  })
  .superRefine((input, context) => {
    const secretSchema = {
      address: addressVaultPayloadStringSchema,
      contact: contactVaultPayloadStringSchema,
      login: loginVaultPayloadStringSchema,
      payment: paymentCardSecretStringSchema,
    }[input.kind];
    if (!secretSchema.safeParse(input.secret).success) {
      context.addIssue({
        code: "custom",
        message: `Complete the ${input.kind} details before saving.`,
        path: ["secret"],
      });
    }
  });

export const vaultImportItemsSchema = z
  .array(
    vaultCreateItemSchema.refine((item) => item.kind === "login", {
      message: "Bulk imports support login credentials only.",
    })
  )
  .min(1)
  .max(3_000);

export const vaultSetupRequestSchema = z.union([
  z
    .object({
      identifierType: loginIdentifierTypeSchema,
      kind: z.literal("login"),
      label: z.string().trim().min(1).max(120),
      origin: loginOriginSchema,
      target: z.literal("vault"),
    })
    .strict(),
  z
    .object({
      kind: vaultCreateItemKindSchema.exclude(["login"]),
      label: z.string().trim().min(1).max(120).optional(),
      target: z.literal("vault"),
    })
    .strict(),
]);

export type VaultCreateItem = z.infer<typeof vaultCreateItemSchema>;
export type VaultImportItems = z.infer<typeof vaultImportItemsSchema>;
export type VaultItem = z.infer<typeof vaultItemSchema>;
export type VaultItemKind = z.infer<typeof vaultItemKindSchema>;
export type VaultSetupRequest = z.infer<typeof vaultSetupRequestSchema>;

export function serializeLoginVaultPayload(
  input: z.input<typeof loginVaultPayloadSchema>
) {
  return JSON.stringify(loginVaultPayloadSchema.parse(input));
}

export function serializeAddressVaultPayload(
  input: z.input<typeof addressVaultPayloadSchema>
) {
  return JSON.stringify(addressVaultPayloadSchema.parse(input));
}

export function serializeContactVaultPayload(
  input: z.input<typeof contactVaultPayloadSchema>
) {
  return JSON.stringify(contactVaultPayloadSchema.parse(input));
}

export function serializePaymentCard(
  input: z.input<typeof paymentCardSecretSchema>
) {
  return JSON.stringify(paymentCardSecretSchema.parse(input));
}

export function parsePaymentCardSecret(value: string) {
  const card = parseSerializedPayload(paymentCardSecretSchema, value);
  if (!card)
    throw new Error("The saved payment card is incomplete or invalid.");
  return card;
}

export function paymentCardBrand(number: string) {
  return paymentCardType(number)?.niceType ?? "Card";
}

export function paymentCardType(number: string) {
  const digits = number.replaceAll(/\D/gu, "");
  if (!digits) return undefined;

  const matches = creditCardType(digits);
  return matches.length === 1 ? matches[0] : undefined;
}

export function parseLoginVaultPayload(value: string) {
  return parseSerializedPayload(readableLoginVaultPayloadSchema, value);
}

export function parseAddressVaultPayload(value: string) {
  return parseSerializedPayload(addressVaultPayloadSchema, value);
}

export function parseContactVaultPayload(value: string) {
  return parseSerializedPayload(contactVaultPayloadSchema, value);
}

export function loginAccountHint(
  identifier: z.infer<typeof loginIdentifierSchema>,
  origin?: string
) {
  const identifierHint = (() => {
    switch (identifier.type) {
      case "email": {
        const [localPart, domain] = identifier.value.split("@", 2);
        if (!localPart || !domain) return "Saved email";
        return `${localPart.slice(0, 1)}•••@${domain}`;
      }
      case "phone":
        return `Phone · •••• ${lastCharacters(identifier.value, 4)}`;
      case "username":
        return `Username · ${identifier.value.slice(0, 2)}•••`;
    }
    throw new Error("Unsupported login identifier type.");
  })();
  return origin
    ? `${new URL(origin).hostname} · ${identifierHint}`
    : identifierHint;
}

export function parseVaultSetupSearchParams(
  query: Record<string, string | readonly string[] | undefined>
) {
  const identifierType = firstQueryValue(query.identifier_type);
  const origin = firstQueryValue(query.origin);
  const input = {
    kind: firstQueryValue(query.kind),
    label: firstQueryValue(query.label),
    target: firstQueryValue(query.setup),
  };

  return vaultSetupRequestSchema.safeParse(
    identifierType === undefined && origin === undefined
      ? input
      : { ...input, identifierType, origin }
  );
}

export function createVaultSetupUrl(
  baseUrl: string,
  request: VaultSetupRequest
) {
  const url = new URL("/vault", baseUrl);
  url.searchParams.set("setup", request.target);
  url.searchParams.set("kind", request.kind);
  if (request.kind === "login") {
    url.searchParams.set("identifier_type", request.identifierType);
    url.searchParams.set("origin", request.origin);
  }
  // The label goes last: a messaging client that runs following text into the
  // link only corrupts the editable nickname instead of a validated field.
  if (request.label) url.searchParams.set("label", request.label);
  return url.toString();
}

function lastCharacters(value: string, count: number) {
  return value.replaceAll(/\D/gu, "").slice(-count);
}

function firstQueryValue(value: string | readonly string[] | undefined) {
  const parsed = z.union([z.string(), z.array(z.string())]).safeParse(value);
  if (!parsed.success) return undefined;
  return Array.isArray(parsed.data) ? parsed.data[0] : parsed.data;
}

function serializedPayloadSchema(schema: z.ZodType, message: string) {
  return z.string().superRefine((value, context) => {
    if (!parseSerializedPayload(schema, value)) {
      context.addIssue({ code: "custom", message });
    }
  });
}

function parseSerializedPayload<T>(schema: z.ZodType<T>, value: string) {
  try {
    return schema.safeParse(JSON.parse(value)).data;
  } catch {
    return undefined;
  }
}
