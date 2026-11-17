import { kernel } from "@agent/subagents/browser-agent/lib/kernel";
import { z } from "zod";
import type { AutofillClaim } from "./protocol";
import {
  classifyNativeLoginControl,
  frameOriginExpression,
  nativeLoginAutofillTokens,
  nativeLoginControlInspectionExpression,
  nativeLoginFillFunctionDeclaration,
  selectNativeLoginFills,
  type ClassifiedNativeLoginControl,
} from "./login";

const targetListSchema = z.object({
  targetInfos: z.array(
    z.object({
      targetId: z.string(),
      parentId: z.string().optional(),
      parentFrameId: z.string().optional(),
      type: z.string(),
      url: z.string(),
    })
  ),
});

const attachedTargetSchema = z.object({ sessionId: z.string() });

type CdpCommandValue =
  | boolean
  | number
  | string
  | null
  | undefined
  | readonly CdpCommandValue[]
  | { readonly [key: string]: CdpCommandValue };

const frameSchema = z.object({
  id: z.string(),
  url: z.string(),
  urlFragment: z.string().optional(),
  parentId: z.string().optional(),
});
const frameTreeSchema = z.object({
  frameTree: z.lazy(() => frameTreeNodeSchema),
});
const frameTreeNodeSchema: z.ZodType<{
  childFrames?: z.infer<typeof frameTreeNodeSchema>[];
  frame: z.infer<typeof frameSchema>;
}> = z.object({
  childFrames: z.array(z.lazy(() => frameTreeNodeSchema)).optional(),
  frame: frameSchema,
});

const isolatedWorldSchema = z.object({ executionContextId: z.number() });
const cdpValueSchema = z.json();
const evaluatedValueSchema = z.object({
  result: z.object({ value: cdpValueSchema }),
});
const evaluatedBooleanSchema = z.object({
  result: z.object({ value: z.boolean() }),
});
const evaluatedStringSchema = z.object({
  result: z.object({ value: z.string() }),
});
const evaluatedNumberSchema = z.object({
  result: z.object({ value: z.number().int().nonnegative() }),
});
const evaluatedObjectSchema = z.object({
  result: z.object({ objectId: z.string().optional() }),
});
const describedNodeSchema = z.object({
  node: z.object({ backendNodeId: z.number().int().positive() }),
});
const controlDescriptorsSchema = z.array(
  z.object({
    autocomplete: z.string(),
    focused: z.boolean(),
    index: z.number().int().nonnegative(),
  })
);
const loginControlDescriptorsSchema = z.array(
  z.object({
    autocomplete: z.string(),
    focused: z.boolean(),
    formIndex: z.number().int().nonnegative().nullable(),
    index: z.number().int().nonnegative(),
    label: z.string(),
    name: z.string(),
    type: z.string(),
  })
);

// A payment fill failure whose message describes only checkout state, never
// card values or page content, so callers may show it to the worker.
export class PaymentFillError extends Error {}

const cardTokens = [
  "cc-name",
  "cc-number",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
] as const;

const addressTokenToChromiumField = {
  name: "NAME_FULL",
  "street-address": "ADDRESS_HOME_STREET_ADDRESS",
  "address-line1": "ADDRESS_HOME_LINE1",
  "address-line2": "ADDRESS_HOME_LINE2",
  "address-level2": "ADDRESS_HOME_CITY",
  "address-level1": "ADDRESS_HOME_STATE",
  "postal-code": "ADDRESS_HOME_ZIP",
  country: "ADDRESS_HOME_COUNTRY",
} as const;

const contactTokenToChromiumField = {
  name: "NAME_FULL",
  email: "EMAIL_ADDRESS",
  tel: "PHONE_HOME_WHOLE_NUMBER",
  "bday-day": "BIRTHDATE_DAY",
  "bday-month": "BIRTHDATE_MONTH",
  "bday-year": "BIRTHDATE_4_DIGIT_YEAR",
} as const;

export const nativeAutofillTokens = {
  address: Object.keys(addressTokenToChromiumField),
  contact: Object.keys(contactTokenToChromiumField),
  login: nativeLoginAutofillTokens,
  payment: [...cardTokens, "postal-code"],
} as const;

type NativeAutofillKind = "address" | "contact" | "login" | "payment";

export async function currentKernelPageOrigin({
  browserSessionId,
  signal,
  pageUrl,
}: {
  readonly browserSessionId: string;
  readonly signal?: AbortSignal;
  readonly pageUrl?: string;
}) {
  return withKernelPage(
    browserSessionId,
    signal,
    async ({ origin }) => origin,
    pageUrl
  );
}

export async function fillWithKernelNativeAutofill({
  browserSessionId,
  claims,
  expectedOrigin,
  kind,
  signal,
  pageUrl,
}: {
  readonly browserSessionId: string;
  readonly claims: readonly AutofillClaim[];
  readonly expectedOrigin: string;
  readonly kind: NativeAutofillKind;
  readonly signal?: AbortSignal;
  readonly pageUrl?: string;
}) {
  const payload =
    kind === "login" ? undefined : buildNativeAutofillPayload(kind, claims);

  return withKernelPage(
    browserSessionId,
    signal,
    async ({ connection, origin, sessionId }) => {
      if (origin !== expectedOrigin) {
        throw new Error(
          "The active tab no longer matches the approved origin."
        );
      }

      if (kind === "login") {
        const filledClaims = await fillNativeLoginControls(
          connection,
          sessionId,
          claims,
          expectedOrigin
        );
        return { filledClaims, origin };
      }

      const controls = await inspectControls(
        connection,
        sessionId,
        kind,
        expectedOrigin
      );
      if (controls.length === 0) {
        throw new Error("No visible form control is available for autofill.");
      }

      let lastError: unknown;
      /* oxlint-disable eslint/no-await-in-loop -- Autofill tries controls in priority order and stops after the first accepted target. */
      for (const control of controls) {
        try {
          await markNativeAutofilledControls(connection, control);
          if (kind === "payment")
            await fillNativeBillingPostalCode(
              connection,
              control,
              claims.find(({ token }) => token === "postal-code")?.value,
              expectedOrigin
            );
          await connection.send(
            "Autofill.trigger",
            {
              fieldId: control.backendNodeId,
              frameId: control.frameId,
              ...payload,
            },
            control.sessionId
          );
        } catch (error) {
          // A payment fill may have written values before its response failed.
          // Reconcile the checkout instead of retrying another control.
          if (kind === "payment") throw error;
          lastError = error;
          continue;
        }
        if (kind === "payment")
          await confirmNativeCardFill(connection, control);
        return { filledClaims: claims.length, origin };
      }
      /* oxlint-enable eslint/no-await-in-loop */

      throw new Error(
        "Chromium could not autofill any visible control. Focus a field in the intended card or address form and retry.",
        { cause: lastError }
      );
    },
    pageUrl
  );
}

async function fillNativeBillingPostalCode(
  connection: CdpConnection,
  control: Awaited<ReturnType<typeof inspectControls>>[number],
  postalCode: string | undefined,
  expectedOrigin: string
) {
  const { object } = resolvedNodeSchema.parse(
    await connection.send(
      "DOM.resolveNode",
      {
        backendNodeId: control.backendNodeId,
        executionContextId: control.executionContextId,
      },
      control.sessionId
    )
  );
  try {
    const status = z
      .enum(["absent", "filled", "missing", "ambiguous", "changed"])
      .parse(
        evaluatedValueSchema.parse(
          await connection.send(
            "Runtime.callFunctionOn",
            {
              objectId: object.objectId,
              arguments: [
                { value: postalCode ?? null },
                { value: expectedOrigin },
              ],
              functionDeclaration: nativeBillingPostalCodeFunction,
              returnByValue: true,
            },
            control.sessionId
          )
        ).result.value
      );
    if (status === "missing")
      throw new PaymentFillError(
        "The checkout requires a billing ZIP that the payment credential has not supplied; do not substitute personal or shipping information."
      );
    if (status === "ambiguous")
      throw new PaymentFillError(
        "Billing ZIP is ambiguous; supply an explicit postal_code field binding."
      );
    if (status === "changed")
      throw new PaymentFillError(
        "The checkout changed before billing ZIP filling; inspect it before continuing."
      );
  } finally {
    await connection
      .send(
        "Runtime.releaseObject",
        { objectId: object.objectId },
        control.sessionId
      )
      .catch(() => undefined);
  }
}

const nativeBillingPostalCodeFunction = `function(postalCode, expectedOrigin) {
    if (!this.isConnected || location.origin !== expectedOrigin) return "changed";
    const root = this.form || this.closest("form") || this.ownerDocument;
    const candidates = Array.from(root.querySelectorAll("input")).filter((element) => {
      if (!(element instanceof HTMLInputElement) || element.matches(":disabled") || element.readOnly) return false;
      if (!["text", "tel", "number", "password"].includes(element.type)) return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return false;
      const autocomplete = (element.autocomplete || "").toLowerCase().split(/\\s+/);
      if (autocomplete.includes("shipping")) return false;
      const metadata = [element.id, element.name, element.getAttribute("aria-label"), ...Array.from(element.labels || [], (label) => label.textContent)].filter(Boolean).map((value) => value.toLowerCase().replace(/[\\s_-]/g, ""));
      if (metadata.some((value) => /shipping/.test(value))) return false;
      return autocomplete.at(-1) === "postal-code" || metadata.some((value) => /billing.*(?:zip|postal|postcode)|^(?:zip(?:code)?|postal(?:code)?|postcode)$/.test(value));
    });
    if (candidates.length === 0) return "absent";
    if (candidates.length !== 1) return "ambiguous";
    if (!postalCode) return "missing";
    const element = candidates[0];
    element.dataset.vaultSecret = "true";
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, postalCode);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return this.isConnected && element.isConnected && location.origin === expectedOrigin && element.value === postalCode ? "filled" : "changed";
  }`;

const cardFillStatusSchema = z
  .record(
    z.enum(["number", "expiry", "securityCode"]),
    z.enum(["absent", "empty", "filled"])
  )
  .nullable();

// Chromium applies an autofill asynchronously after Autofill.trigger returns.
// Wait briefly for the card form's annotated fields, then report any that
// stayed empty. Unannotated fields cannot be checked and are not required.
async function confirmNativeCardFill(
  connection: CdpConnection,
  control: Awaited<ReturnType<typeof inspectControls>>[number]
) {
  // Resolve the actual autofilled input, since input handlers may reorder forms.
  const { object } = resolvedNodeSchema.parse(
    await connection.send(
      "DOM.resolveNode",
      {
        backendNodeId: control.backendNodeId,
        executionContextId: control.executionContextId,
      },
      control.sessionId
    )
  );
  let status: z.infer<typeof cardFillStatusSchema> | undefined;
  try {
    /* oxlint-disable eslint/no-await-in-loop -- Each check waits for Chromium to apply the fill before reading the next status. */
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (attempt > 0)
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      status = cardFillStatusSchema.parse(
        evaluatedValueSchema.parse(
          await connection.send(
            "Runtime.callFunctionOn",
            {
              objectId: object.objectId,
              functionDeclaration: nativeCardFillStatusFunction,
              returnByValue: true,
            },
            control.sessionId
          )
        ).result.value
      );
      if (status === null)
        throw new PaymentFillError(
          "The autofilled card input disappeared; inspect the existing checkout before continuing."
        );
      if (!Object.values(status).includes("empty")) return;
    }
    /* oxlint-enable eslint/no-await-in-loop */
    const empty = (
      [
        ["number", "card number"],
        ["expiry", "expiration"],
        ["securityCode", "security code"],
      ] as const
    ).flatMap(([field, label]) => (status?.[field] === "empty" ? [label] : []));
    throw new PaymentFillError(
      `Card autofill left required fields empty: ${empty.join(", ")}.`
    );
  } finally {
    await connection
      .send(
        "Runtime.releaseObject",
        { objectId: object.objectId },
        control.sessionId
      )
      .catch(() => undefined);
  }
}

const nativeCardFillStatusFunction = `function() {
    if (!this.isConnected) return null;
    const root = this.form || this.closest("form") || this.ownerDocument;
    const fields = Array.from(root.querySelectorAll("input, select")).flatMap((element) => {
      if (element.matches(":disabled") || ("readOnly" in element && element.readOnly)) return [];
      if (element instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) return [];
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return [];
      const token = (element.autocomplete || "").toLowerCase().split(/\\s+/).filter(Boolean).pop() || "";
      return token.startsWith("cc-") ? [{ token, filled: element.value.trim().length > 0 }] : [];
    });
    const state = (...tokens) => {
      const matches = fields.filter((field) => tokens.includes(field.token));
      if (matches.length === 0) return "absent";
      return matches.some((field) => field.filled) ? "filled" : "empty";
    };
    const parts = [state("cc-exp"), state("cc-exp-month"), state("cc-exp-year")].filter((part) => part !== "absent");
    const expiry = parts.length === 0 ? "absent" : parts.includes("empty") ? "empty" : "filled";
    return { number: state("cc-number"), expiry, securityCode: state("cc-csc") };
  }`;

const paymentFrameOrigins = new Set([
  "https://assets.braintreegateway.com",
  "https://checkout.pci.shopifyinc.com",
  "https://checkout.shopifycs.com",
  "https://checkout.shopify.com",
  "https://www.paypal.com",
  "https://www.sandbox.paypal.com",
  "https://js.stripe.com",
  "https://hooks.stripe.com",
]);

const paymentBindingMatchesSchema = z.array(
  z.object({
    bindingIndex: z.number().int().nonnegative(),
    inputIndex: z.number().int().nonnegative(),
  })
);

// Link's approved one-time card can be delivered to recognized payment frames.
// Saved vault credentials retain their existing same-origin policy above.
export async function fillKernelPaymentFields({
  browserSessionId,
  expectedOrigin,
  pageUrl,
  fields,
  signal,
}: {
  readonly browserSessionId: string;
  readonly expectedOrigin: string;
  readonly pageUrl: string;
  readonly fields: readonly {
    readonly selector: string;
    readonly frameUrl?: string;
    readonly value: string;
    readonly token?: AutofillClaim["token"];
  }[];
  readonly signal?: AbortSignal;
}) {
  const page = new URL(pageUrl);
  if (
    page.protocol !== "https:" ||
    page.origin !== expectedOrigin ||
    page.username ||
    page.password
  ) {
    throw new PaymentFillError(
      "Payment field bindings require the approved HTTPS checkout."
    );
  }
  return withKernelPage(
    browserSessionId,
    signal,
    async ({
      connection,
      origin,
      sessionId,
      frameId,
      frameParents,
      frameSessions,
    }) => {
      if (origin !== expectedOrigin)
        throw new PaymentFillError(
          "The checkout no longer matches the approved merchant."
        );
      const topSessionId = sessionId[0];
      if (!topSessionId)
        throw new PaymentFillError("The checkout page is unavailable.");
      const topWorld = isolatedWorldSchema.parse(
        await connection.send(
          "Page.createIsolatedWorld",
          {
            frameId,
            worldName: "open-instinct-link-checkout",
          },
          topSessionId
        )
      );
      const frames = (
        await Promise.all(
          sessionId.map(async (attachedSessionId) => {
            const { frameTree } = frameTreeSchema.parse(
              await connection.send(
                "Page.getFrameTree",
                undefined,
                attachedSessionId
              )
            );
            return flattenFrames(frameTree).map((frame) => ({
              id: frame.id,
              url: frame.url,
              sessionId: attachedSessionId,
            }));
          })
        )
      ).flat();
      const matches = (
        await Promise.all(
          frames.map(async (frame) => {
            if (
              !(await isPaymentFrameVisible(
                connection,
                frame.id,
                frameId,
                frameParents,
                frameSessions
              ))
            )
              return [];
            const world = await connection
              .send(
                "Page.createIsolatedWorld",
                {
                  frameId: frame.id,
                  worldName: "open-instinct-link-fields",
                },
                frame.sessionId
              )
              .catch(() => undefined);
            const parsedWorld = isolatedWorldSchema.safeParse(world);
            if (!parsedWorld.success) return [];
            const executionContextId = parsedWorld.data.executionContextId;
            const frameOrigin = evaluatedStringSchema.parse(
              await connection.send(
                "Runtime.evaluate",
                {
                  contextId: executionContextId,
                  expression: frameOriginExpression,
                  returnByValue: true,
                },
                frame.sessionId
              )
            ).result.value;
            if (
              frameOrigin !== expectedOrigin &&
              !paymentFrameOrigins.has(frameOrigin)
            )
              return [];
            const response = evaluatedValueSchema.parse(
              await connection.send(
                "Runtime.evaluate",
                {
                  contextId: executionContextId,
                  expression: `(() => {
          const bindings = ${JSON.stringify(fields.map(({ selector, frameUrl }) => ({ selector, frameUrl })))};
          const inputs = Array.from(document.querySelectorAll("input, select"));
          return bindings.flatMap((binding, bindingIndex) => {
            if (binding.frameUrl && binding.frameUrl !== location.href) return [];
            return Array.from(document.querySelectorAll(binding.selector)).flatMap((element) => {
              if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) return [];
              if (element.disabled || element.readOnly || element.getClientRects().length === 0) return [];
              if (element instanceof HTMLInputElement && !["text", "tel", "number", "password"].includes(element.type)) return [];
              const style = getComputedStyle(element);
              if (style.display === "none" || style.visibility === "hidden") return [];
              return [{ bindingIndex, inputIndex: inputs.indexOf(element) }];
            });
          });
        })()`,
                  returnByValue: true,
                },
                frame.sessionId
              )
            );
            return Promise.all(
              paymentBindingMatchesSchema
                .parse(response.result.value)
                .map(async (match) => {
                  const evaluated = evaluatedObjectSchema.parse(
                    await connection.send(
                      "Runtime.evaluate",
                      {
                        contextId: executionContextId,
                        expression: `document.querySelectorAll("input, select").item(${String(match.inputIndex)})`,
                      },
                      frame.sessionId
                    )
                  );
                  if (!evaluated.result.objectId)
                    throw new PaymentFillError("A payment input disappeared.");
                  const { node } = describedNodeSchema.parse(
                    await connection.send(
                      "DOM.describeNode",
                      { objectId: evaluated.result.objectId },
                      frame.sessionId
                    )
                  );
                  return {
                    bindingIndex: match.bindingIndex,
                    inputIndex: match.inputIndex,
                    frameId: frame.id,
                    frameOrigin,
                    frameUrl: frame.url,
                    executionContextId,
                    sessionId: frame.sessionId,
                    objectId: evaluated.result.objectId,
                    backendNodeId: node.backendNodeId,
                  };
                })
            );
          })
        )
      ).flat();
      try {
        const controls = fields.map((_field, bindingIndex) => {
          const candidates = [
            ...new Map(
              matches
                .filter((match) => match.bindingIndex === bindingIndex)
                .map((match) => [
                  `${match.frameId}:${String(match.backendNodeId)}`,
                  match,
                ])
            ).values(),
          ];
          if (candidates.length !== 1)
            throw new PaymentFillError(
              `Each binding must identify one visible payment input in the approved checkout; binding ${String(bindingIndex + 1)} matched ${String(candidates.length)}.`
            );
          const candidate = candidates[0];
          if (!candidate)
            throw new PaymentFillError("A payment input is unavailable.");
          return candidate;
        });
        if (
          new Set(
            controls.map(
              ({ frameId: id, backendNodeId }) =>
                `${id}:${String(backendNodeId)}`
            )
          ).size !== controls.length
        ) {
          throw new PaymentFillError(
            "Payment bindings must target distinct inputs."
          );
        }
        /* oxlint-disable eslint/no-await-in-loop -- Payment fields are written once in order; any uncertain field stops the operation. */
        for (const [index, control] of controls.entries()) {
          const topUrl = evaluatedStringSchema.parse(
            await connection.send(
              "Runtime.evaluate",
              {
                contextId: topWorld.executionContextId,
                expression: "location.href",
                returnByValue: true,
              },
              topSessionId
            )
          ).result.value;
          if (topUrl !== pageUrl)
            throw new PaymentFillError(
              "The checkout changed before payment filling."
            );
          const field = fields[index];
          if (!field)
            throw new PaymentFillError("A payment binding is unavailable.");
          if (
            !(await isPaymentFrameVisible(
              connection,
              control.frameId,
              frameId,
              frameParents,
              frameSessions
            ))
          ) {
            throw new PaymentFillError(
              "A payment frame became hidden before filling."
            );
          }
          const result = evaluatedBooleanSchema.parse(
            await connection.send(
              "Runtime.callFunctionOn",
              {
                objectId: control.objectId,
                arguments: [
                  { value: field.value },
                  { value: control.frameOrigin },
                  { value: control.frameUrl },
                  { value: field.selector },
                  { value: field.token ?? null },
                ],
                functionDeclaration: paymentFieldFunction,
                returnByValue: true,
              },
              control.sessionId
            )
          );
          if (!result.result.value)
            throw new PaymentFillError(
              "A payment field rejected filling; inspect the existing checkout before continuing."
            );
        }
        /* oxlint-enable eslint/no-await-in-loop */
        return { filledClaims: controls.length, origin };
      } finally {
        await Promise.all(
          matches.map(({ objectId, sessionId: attachedSessionId }) =>
            connection
              .send("Runtime.releaseObject", { objectId }, attachedSessionId)
              .catch(() => undefined)
          )
        );
      }
    },
    pageUrl
  );
}

const frameOwnerSchema = z.object({
  backendNodeId: z.number().int().positive(),
});
const resolvedNodeSchema = z.object({
  object: z.object({ objectId: z.string() }),
});

async function isPaymentFrameVisible(
  connection: CdpConnection,
  frameId: string,
  rootFrameId: string,
  parents: ReadonlyMap<string, string>,
  sessions: ReadonlyMap<string, string>
) {
  const visited = new Set<string>();
  let current = frameId;
  /* oxlint-disable eslint/no-await-in-loop -- Each frame owner must be inspected in its parent document before moving up the ancestry chain. */
  while (current !== rootFrameId) {
    if (visited.has(current)) return false;
    visited.add(current);
    const parent = parents.get(current);
    const parentSession = parent ? sessions.get(parent) : undefined;
    if (!parent || !parentSession) return false;
    const owner = frameOwnerSchema.safeParse(
      await connection
        .send("DOM.getFrameOwner", { frameId: current }, parentSession)
        .catch(() => undefined)
    );
    if (!owner.success) return false;
    const world = isolatedWorldSchema.safeParse(
      await connection
        .send(
          "Page.createIsolatedWorld",
          {
            frameId: parent,
            worldName: "open-instinct-link-frame-visibility",
          },
          parentSession
        )
        .catch(() => undefined)
    );
    if (!world.success) return false;
    const resolved = resolvedNodeSchema.safeParse(
      await connection
        .send(
          "DOM.resolveNode",
          {
            backendNodeId: owner.data.backendNodeId,
            executionContextId: world.data.executionContextId,
          },
          parentSession
        )
        .catch(() => undefined)
    );
    if (!resolved.success) return false;
    const objectId = resolved.data.object.objectId;
    try {
      const visible = evaluatedBooleanSchema.parse(
        await connection.send(
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: `function() {
          const style = getComputedStyle(this);
          return this.isConnected && this.getClientRects().length > 0 && style.display !== "none" && style.visibility === "visible";
        }`,
            returnByValue: true,
          },
          parentSession
        )
      );
      if (!visible.result.value) return false;
    } finally {
      await connection
        .send("Runtime.releaseObject", { objectId }, parentSession)
        .catch(() => undefined);
    }
    current = parent;
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return true;
}

const paymentFieldFunction = `function(value, expectedOrigin, expectedUrl, selector, token) {
  const eligible = (element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement) || element.disabled || element.readOnly || element.getClientRects().length === 0) return false;
    if (element instanceof HTMLInputElement && !["text", "tel", "number", "password"].includes(element.type)) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const valid = () => {
    if (self.origin !== expectedOrigin || location.href !== expectedUrl || !this.isConnected || !eligible(this)) return false;
    const candidates = Array.from(document.querySelectorAll(selector)).filter(eligible);
    return candidates.length === 1 && candidates[0] === this;
  };
  if (!valid()) return false;
  let fillValue = value;
  if (this instanceof HTMLSelectElement) {
    const options = Array.from(this.options).filter((option) => !option.disabled);
    if (!options.some((option) => option.value === value)) {
      const equivalent = token === "cc-exp-month" ? options.filter((option) => /^[0-9]{1,2}$/.test(option.value) && Number(option.value) === Number(value)) : [];
      if (equivalent.length !== 1) return false;
      fillValue = equivalent[0].value;
    }
  }
  this.dataset.vaultSecret = "true";
  this.style.setProperty("-webkit-text-security", "disc", "important");
  this.style.setProperty("color", "transparent", "important");
  this.style.setProperty("text-shadow", "0 0 8px black", "important");
  this.focus();
  if (!valid()) return false;
  const prototype = this instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(this, fillValue);
  this.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: fillValue }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  this.blur();
  if (!this.isConnected) return false;
  if (this.value === fillValue) return true;
  return /^[0-9 /-]+$/.test(fillValue) && /^[0-9 /-]+$/.test(this.value) && this.value.replace(/[ /-]/g, "") === fillValue.replace(/[ /-]/g, "");
}`;

async function fillNativeLoginControls(
  connection: CdpConnection,
  sessionIds: readonly string[],
  claims: readonly AutofillClaim[],
  expectedOrigin: string
) {
  const controls = await inspectNativeLoginControls(
    connection,
    sessionIds,
    expectedOrigin
  );
  const focused = controls.find((control) => control.focused);
  if (!focused) {
    throw new Error(
      "Focus a visible username, email, phone, or current-password field and retry."
    );
  }
  const sameFrame = controls.filter(
    (control) =>
      control.frameId === focused.frameId &&
      control.sessionId === focused.sessionId
  );
  const fills = selectNativeLoginFills(sameFrame, claims);
  if (fills.length === 0) {
    throw new Error(
      "The focused login form does not accept a field available in this saved login."
    );
  }

  /* oxlint-disable eslint/no-await-in-loop -- Login fields must be filled in DOM order so page validation sees coherent intermediate state. */
  for (const { control, value } of fills) {
    const accepted = await fillNativeLoginControl(
      connection,
      control,
      value,
      expectedOrigin
    );
    if (!accepted) {
      throw new Error(
        "The login form rejected secure credential autofill or is not served from the saved origin."
      );
    }
  }
  /* oxlint-enable eslint/no-await-in-loop */
  return fills.length;
}

async function inspectNativeLoginControls(
  connection: CdpConnection,
  sessionIds: readonly string[],
  expectedOrigin: string
) {
  return (
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await connection.send("Page.enable", undefined, sessionId);
          const { frameTree } = frameTreeSchema.parse(
            await connection.send("Page.getFrameTree", undefined, sessionId)
          );
          return (
            await Promise.all(
              flattenFrames(frameTree).map(({ id: frameId }) =>
                inspectNativeLoginFrame(
                  connection,
                  sessionId,
                  frameId,
                  expectedOrigin
                ).catch(() => [])
              )
            )
          ).flat();
        } catch {
          return [];
        }
      })
    )
  ).flat();
}

async function inspectNativeLoginFrame(
  connection: CdpConnection,
  sessionId: string,
  frameId: string,
  expectedOrigin: string
) {
  const { executionContextId } = isolatedWorldSchema.parse(
    await connection.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "open-instinct-login-autofill" },
      sessionId
    )
  );
  if (
    !(await isFrameAtOrigin(
      connection,
      sessionId,
      executionContextId,
      expectedOrigin
    ))
  ) {
    return [];
  }
  const response = evaluatedValueSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: nativeLoginControlInspectionExpression,
        returnByValue: true,
      },
      sessionId
    )
  );
  const descriptors = loginControlDescriptorsSchema.parse(
    response.result.value
  );
  return descriptors.flatMap((descriptor) => {
    const classified = classifyNativeLoginControl(descriptor);
    return classified
      ? [{ ...classified, executionContextId, frameId, sessionId }]
      : [];
  });
}

async function fillNativeLoginControl(
  connection: CdpConnection,
  control: ClassifiedNativeLoginControl & {
    readonly executionContextId: number;
    readonly frameId: string;
    readonly sessionId: string;
  },
  value: string,
  expectedOrigin: string
) {
  const evaluated = evaluatedObjectSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: control.executionContextId,
        expression: `document.querySelectorAll("input").item(${String(control.index)})`,
      },
      control.sessionId
    )
  );
  const objectId = evaluated.result.objectId;
  if (!objectId) return false;

  try {
    const response = evaluatedBooleanSchema.parse(
      await connection.send(
        "Runtime.callFunctionOn",
        {
          arguments: [{ value }, { value: expectedOrigin }],
          awaitPromise: false,
          functionDeclaration: nativeLoginFillFunctionDeclaration,
          objectId,
          returnByValue: true,
        },
        control.sessionId
      )
    );
    return response.result.value;
  } finally {
    await connection
      .send("Runtime.releaseObject", { objectId }, control.sessionId)
      .catch(() => undefined);
  }
}

export function buildNativeAutofillPayload(
  kind: "address" | "contact" | "payment",
  claims: readonly Pick<AutofillClaim, "token" | "value">[]
) {
  const values = new Map(claims.map(({ token, value }) => [token, value]));

  if (kind === "payment") {
    return {
      card: {
        cvc: requiredClaim(values, "cc-csc"),
        expiryMonth: requiredClaim(values, "cc-exp-month"),
        expiryYear: requiredClaim(values, "cc-exp-year"),
        name: requiredClaim(values, "cc-name"),
        number: requiredClaim(values, "cc-number"),
      },
    };
  }

  const tokenMap =
    kind === "address"
      ? addressTokenToChromiumField
      : contactTokenToChromiumField;
  const fields = Object.entries(tokenMap).flatMap(([token, name]) => {
    const value = values.get(token);
    return value ? [{ name, value }] : [];
  });
  if (fields.length === 0) {
    throw new Error(`The saved ${kind} is incomplete or invalid.`);
  }
  return { address: { fields } };
}

async function inspectControls(
  connection: CdpConnection,
  sessionIds: readonly string[],
  kind: "address" | "contact" | "payment",
  expectedOrigin: string
) {
  const controls = (
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        try {
          await connection.send("Page.enable", undefined, sessionId);
          const { frameTree } = frameTreeSchema.parse(
            await connection.send("Page.getFrameTree", undefined, sessionId)
          );
          return (
            await Promise.all(
              flattenFrames(frameTree).map(({ id: frameId }) =>
                inspectFrameControls(
                  connection,
                  sessionId,
                  frameId,
                  kind,
                  expectedOrigin
                ).catch(() => [])
              )
            )
          ).flat();
        } catch {
          return [];
        }
      })
    )
  ).flat();

  return controls.toSorted((left, right) => {
    if (left.focused !== right.focused) return left.focused ? -1 : 1;
    if (left.standard !== right.standard) return left.standard ? -1 : 1;
    return left.order - right.order;
  });
}

async function inspectFrameControls(
  connection: CdpConnection,
  sessionId: string,
  frameId: string,
  kind: "address" | "contact" | "payment",
  expectedOrigin: string
) {
  const { executionContextId } = isolatedWorldSchema.parse(
    await connection.send(
      "Page.createIsolatedWorld",
      { frameId, worldName: "open-instinct-autofill" },
      sessionId
    )
  );
  // Chromium's Autofill.trigger writes into whichever frame owns the control,
  // so only controls in documents served from the saved origin are eligible.
  if (
    !(await isFrameAtOrigin(
      connection,
      sessionId,
      executionContextId,
      expectedOrigin
    ))
  ) {
    return [];
  }
  const response = evaluatedValueSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: controlInspectionExpression,
        returnByValue: true,
      },
      sessionId
    )
  );
  const descriptors = controlDescriptorsSchema.parse(response.result.value);

  return (
    await Promise.all(
      descriptors.map(async (descriptor, order) => {
        const evaluated = evaluatedObjectSchema.parse(
          await connection.send(
            "Runtime.evaluate",
            {
              contextId: executionContextId,
              expression: `document.querySelectorAll("input, select, textarea").item(${String(descriptor.index)})`,
            },
            sessionId
          )
        );
        const objectId = evaluated.result.objectId;
        if (!objectId) return null;

        try {
          const described = describedNodeSchema.parse(
            await connection.send("DOM.describeNode", { objectId }, sessionId)
          );
          return {
            backendNodeId: described.node.backendNodeId,
            executionContextId,
            focused: descriptor.focused,
            frameId,
            index: descriptor.index,
            order,
            sessionId,
            standard: standardAutocomplete(kind, descriptor.autocomplete),
          };
        } finally {
          await connection
            .send("Runtime.releaseObject", { objectId }, sessionId)
            .catch(() => undefined);
        }
      })
    )
  ).filter((control) => control !== null);
}

async function isFrameAtOrigin(
  connection: CdpConnection,
  sessionId: string,
  executionContextId: number,
  expectedOrigin: string
) {
  const response = evaluatedStringSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: executionContextId,
        expression: frameOriginExpression,
        returnByValue: true,
      },
      sessionId
    )
  );
  return response.result.value === expectedOrigin;
}

const controlInspectionExpression = `(() => {
  const elements = Array.from(document.querySelectorAll("input, select, textarea"));
  return elements.flatMap((element, index) => {
    if (element.disabled || ("readOnly" in element && element.readOnly)) return [];
    if (element instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) return [];
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return [];
    return [{ autocomplete: element.autocomplete || "", focused: document.activeElement === element, index }];
  });
})()`;

export function nativeAutofillSecretMarkingExpression(index: number) {
  return `(() => {
    const controls = document.querySelectorAll("input, select, textarea");
    const anchor = controls.item(${String(index)});
    if (!anchor) return 0;
    const root = anchor.form || anchor.closest("form") || document;
    let marked = 0;
    for (const element of root.querySelectorAll("input, select, textarea")) {
      if (element.disabled || ("readOnly" in element && element.readOnly)) continue;
      if (element instanceof HTMLInputElement && ["hidden", "submit", "button", "reset", "file", "image", "checkbox", "radio"].includes(element.type)) continue;
      element.dataset.vaultSecret = "true";
      marked += 1;
    }
    return marked;
  })()`;
}

async function markNativeAutofilledControls(
  connection: CdpConnection,
  control: {
    readonly executionContextId: number;
    readonly index: number;
    readonly sessionId: string;
  }
) {
  const response = evaluatedNumberSchema.parse(
    await connection.send(
      "Runtime.evaluate",
      {
        contextId: control.executionContextId,
        expression: nativeAutofillSecretMarkingExpression(control.index),
        returnByValue: true,
      },
      control.sessionId
    )
  );
  if (response.result.value === 0) {
    throw new Error(
      "Vault-filled controls could not be marked for screenshot masking."
    );
  }
}

async function withKernelPage<T>(
  browserSessionId: string,
  signal: AbortSignal | undefined,
  operation: (page: {
    readonly connection: CdpConnection;
    readonly origin: string;
    readonly sessionId: readonly string[];
    readonly frameId: string;
    readonly frameParents: ReadonlyMap<string, string>;
    readonly frameSessions: ReadonlyMap<string, string>;
  }) => Promise<T>,
  pageUrl?: string
) {
  const browser = await kernel.browsers.retrieve(
    browserSessionId,
    {},
    { signal }
  );
  const connection = await CdpConnection.connect(browser.cdp_ws_url, signal);

  try {
    const { targetInfos } = targetListSchema.parse(
      await connection.send("Target.getTargets")
    );
    const matchingPages = targetInfos.filter(
      ({ type, url }) =>
        type === "page" &&
        isWebUrl(url) &&
        (pageUrl === undefined || url === pageUrl)
    );
    if (pageUrl !== undefined && matchingPages.length !== 1) {
      throw new Error(
        "The exact checkout page is no longer uniquely available."
      );
    }
    const target = matchingPages.at(-1);
    if (!target) throw new Error("No active browser tab was found.");

    const { sessionId: pageSessionId } = attachedTargetSchema.parse(
      await connection.send("Target.attachToTarget", {
        flatten: true,
        targetId: target.targetId,
      })
    );
    const sessionIds = [pageSessionId];
    try {
      await connection.send("Page.enable", undefined, pageSessionId);
      const { frameTree } = frameTreeSchema.parse(
        await connection.send("Page.getFrameTree", undefined, pageSessionId)
      );
      const attachedTargets = new Set([target.targetId]);
      const frameParents = new Map<string, string>();
      const frameSessions = new Map<string, string>();
      /* oxlint-disable eslint/no-await-in-loop -- Discover descendant iframe targets through each attached frame tree before operating on the page. */
      for (let index = 0; index < sessionIds.length; index += 1) {
        const currentSessionId = sessionIds[index];
        if (!currentSessionId) continue;
        const tree =
          index === 0
            ? frameTree
            : frameTreeSchema.parse(
                await connection.send(
                  "Page.getFrameTree",
                  undefined,
                  currentSessionId
                )
              ).frameTree;
        const frameEntries = flattenFrames(tree);
        const rootParent = targetInfos.find(
          ({ targetId }) => targetId === tree.frame.id
        )?.parentFrameId;
        for (const entry of frameEntries) {
          frameSessions.set(entry.id, currentSessionId);
          const parent =
            entry.parentId ??
            (entry.id === tree.frame.id ? rootParent : undefined);
          if (parent) frameParents.set(entry.id, parent);
        }
        const frameIds = new Set(frameEntries.map(({ id }) => id));
        // Chromium omits out-of-process iframes, such as hosted card fields,
        // from the owning document's frame tree; match them by parent frame.
        for (const iframeTarget of targetInfos.filter(
          ({ targetId, parentId, parentFrameId, type }) =>
            type === "iframe" &&
            (frameIds.has(targetId) ||
              (parentFrameId !== undefined && frameIds.has(parentFrameId)) ||
              (parentId !== undefined && attachedTargets.has(parentId))) &&
            !attachedTargets.has(targetId)
        )) {
          const attached = attachedTargetSchema.safeParse(
            await connection
              .send("Target.attachToTarget", {
                flatten: true,
                targetId: iframeTarget.targetId,
              })
              .catch(() => undefined)
          );
          if (attached.success) {
            attachedTargets.add(iframeTarget.targetId);
            sessionIds.push(attached.data.sessionId);
          }
        }
      }
      /* oxlint-enable eslint/no-await-in-loop */

      return await operation({
        connection,
        origin: new URL(target.url).origin,
        sessionId: sessionIds,
        frameId: frameTree.frame.id,
        frameParents,
        frameSessions,
      });
    } finally {
      await Promise.all(
        sessionIds.map((sessionId) =>
          connection
            .send("Target.detachFromTarget", { sessionId })
            .catch(() => undefined)
        )
      );
    }
  } finally {
    connection.close();
  }
}

class CdpConnection {
  readonly #pending = new Map<
    number,
    {
      readonly reject: (cause?: unknown) => void;
      readonly resolve: (
        value: z.infer<typeof cdpValueSchema> | undefined
      ) => void;
    }
  >();
  #nextId = 1;

  private constructor(
    private readonly socket: WebSocket,
    signal: AbortSignal | undefined
  ) {
    socket.addEventListener("message", (event) => {
      this.#onMessage(event);
    });
    socket.addEventListener("close", () => {
      this.#rejectPending(new Error("The Kernel CDP connection closed."));
    });
    signal?.addEventListener(
      "abort",
      () => {
        this.close();
      },
      { once: true }
    );
  }

  static async connect(url: string, signal?: AbortSignal) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to the Kernel browser over CDP."));
      };
      const onAbort = () => {
        cleanup();
        socket.close();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("The CDP connection was aborted.")
        );
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return new CdpConnection(socket, signal);
  }

  send(method: string, params?: CdpCommandValue, sessionId?: string) {
    const id = this.#nextId++;
    return new Promise<z.infer<typeof cdpValueSchema> | undefined>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`Chromium did not respond to ${method}.`));
        }, 15_000);
        this.#pending.set(id, {
          reject(cause) {
            clearTimeout(timeout);
            reject(
              cause instanceof Error
                ? cause
                : new Error("The Chromium command failed.")
            );
          },
          resolve(value) {
            clearTimeout(timeout);
            resolve(value);
          },
        });
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      }
    );
  }

  close() {
    this.socket.close();
  }

  #onMessage(event: MessageEvent) {
    const eventData = z.string().safeParse(event.data);
    if (!eventData.success) return;
    let rawMessage: z.infer<typeof cdpValueSchema>;
    try {
      const parsed = cdpValueSchema.safeParse(JSON.parse(eventData.data));
      if (!parsed.success) return;
      rawMessage = parsed.data;
    } catch {
      return;
    }
    const message = cdpResponseSchema.safeParse(rawMessage);
    if (!message.success || message.data.id === undefined) return;
    const pending = this.#pending.get(message.data.id);
    if (!pending) return;
    this.#pending.delete(message.data.id);
    if (message.data.error) {
      pending.reject(new Error(message.data.error.message));
    } else {
      pending.resolve(message.data.result);
    }
  }

  #rejectPending(error: Error) {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
  }
}

const cdpResponseSchema = z.object({
  error: z.object({ message: z.string() }).optional(),
  id: z.number().int().optional(),
  result: cdpValueSchema.optional(),
});

function flattenFrames(
  node: z.infer<typeof frameTreeNodeSchema>,
  parentId?: string
): { readonly id: string; readonly url: string; readonly parentId?: string }[] {
  return [
    {
      id: node.frame.id,
      url: `${node.frame.url}${node.frame.urlFragment ?? ""}`,
      parentId: node.frame.parentId ?? parentId,
    },
    ...(node.childFrames ?? []).flatMap((child) =>
      flattenFrames(child, node.frame.id)
    ),
  ];
}

function standardAutocomplete(
  kind: "address" | "contact" | "payment",
  autocomplete: string
) {
  const token = autocomplete
    .toLowerCase()
    .split(/\s+/u)
    .findLast((value) => Boolean(value));
  if (!token) return false;
  if (kind === "payment") return token.startsWith("cc-");
  if (kind === "contact") {
    return Object.keys(contactTokenToChromiumField).includes(token);
  }
  return [
    "name",
    "street-address",
    "address-line1",
    "address-line2",
    "address-line3",
    "address-level1",
    "address-level2",
    "postal-code",
    "country",
    "country-name",
  ].includes(token);
}

function requiredClaim(values: ReadonlyMap<string, string>, token: string) {
  const value = values.get(token);
  if (!value)
    throw new Error("The saved payment card is incomplete or invalid.");
  return value;
}

function isWebUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
