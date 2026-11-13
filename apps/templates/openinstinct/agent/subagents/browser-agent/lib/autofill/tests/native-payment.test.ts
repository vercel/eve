import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fillWithKernelNativeAutofill, PaymentFillError } from "../native";
import { frameOriginExpression } from "../login";

vi.mock("@onkernel/sdk", () => ({
  default: class {
    browsers = { retrieve: async () => ({ cdp_ws_url: "wss://kernel.test" }) };
  },
}));

const commandSchema = z.object({
  id: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.json()).optional(),
  sessionId: z.string().optional(),
});
const commands: z.infer<typeof commandSchema>[] = [];
let pageOrigin = "https://shop.example";
let frameOrigin = "https://shop.example";
let failFill = false;
const filledCard = {
  number: "filled",
  expiry: "filled",
  securityCode: "filled",
};
let cardStatuses: Record<string, string>[] = [];
class CardInput {
  disabled = false;
  disabledByFieldset = false;
  readOnly = false;
  type = "text";
  isConnected = true;
  visible = true;
  readonly style = { display: "block", visibility: "visible" };
  form: { querySelectorAll: () => CardInput[] } | null = null;
  id = "";
  name = "";
  labels: { textContent: string }[] = [];
  dataset: Record<string, string> = {};
  events: string[] = [];
  #value: string;

  constructor(
    readonly autocomplete: string,
    value = "filled"
  ) {
    this.#value = value;
  }

  get value() {
    return this.#value;
  }
  set value(value: string) {
    this.#value = value;
  }
  getAttribute() {
    return null;
  }
  dispatchEvent(event: Event) {
    this.events.push(event.type);
    return true;
  }

  getClientRects() {
    return this.visible ? [{}] : [];
  }

  closest() {
    return this.form;
  }

  matches(selector: string) {
    return (
      selector === ":disabled" && (this.disabled || this.disabledByFieldset)
    );
  }
}

let cardForm: CardInput[] | undefined;
let insertedForm = false;
let detachedAnchor = false;

function evaluateCardStatus(script: string, callOnAnchor: boolean) {
  if (!cardForm) return cardStatuses.shift() ?? filledCard;
  const controls = cardForm;
  const anchor = controls[0];
  if (!anchor) throw new Error("The fixture requires a card input.");
  anchor.form = { querySelectorAll: () => controls };
  anchor.isConnected = !detachedAnchor;
  class NodeList extends Array<CardInput> {
    item(index: number) {
      return this[index] ?? null;
    }
  }
  const unrelated = new CardInput("cc-number", "");
  unrelated.form = { querySelectorAll: () => [unrelated] };
  const document = {
    querySelectorAll: () =>
      new NodeList(...(insertedForm ? [unrelated, ...controls] : controls)),
  };
  return z.json().parse(
    runInNewContext(callOnAnchor ? `(${script}).call(anchor)` : script, {
      anchor,
      document,
      HTMLInputElement: CardInput,
      getComputedStyle: (element: CardInput) => element.style,
    })
  );
}

function evaluateBillingPostalCode(script: string, args: unknown[]) {
  const controls = cardForm ?? [new CardInput("cc-number")];
  const anchor = controls[0];
  if (!anchor) throw new Error("The fixture requires a card input.");
  anchor.form = { querySelectorAll: () => controls };
  anchor.isConnected = true;
  return z.json().parse(
    runInNewContext(`(${script}).call(anchor, ...args)`, {
      anchor,
      args,
      location: { origin: frameOrigin },
      HTMLInputElement: CardInput,
      Event,
      getComputedStyle: (element: CardInput) => element.style,
    })
  );
}

class BrowserSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  close() {
    this.dispatchEvent(new Event("close"));
  }
  send(data: string) {
    const command = commandSchema.parse(JSON.parse(data));
    commands.push(command);
    let result = {};
    switch (command.method) {
      case "Target.getTargets":
        result = {
          targetInfos: [
            { targetId: "page-1", type: "page", url: `${pageOrigin}/checkout` },
          ],
        };
        break;
      case "Target.attachToTarget":
        result = { sessionId: "cdp-1" };
        break;
      case "Page.getFrameTree":
        result = {
          frameTree: {
            frame: { id: "frame-1", url: `${frameOrigin}/checkout` },
          },
        };
        break;
      case "Page.createIsolatedWorld":
        result = { executionContextId: 1 };
        break;
      case "Runtime.evaluate": {
        const expression = z.string().parse(command.params?.expression);
        if (expression === frameOriginExpression)
          result = { result: { value: frameOrigin } };
        else if (expression.includes("securityCode"))
          result = {
            result: { value: evaluateCardStatus(expression, false) },
          };
        else if (expression.includes("flatMap"))
          result = {
            result: {
              value: [
                { autocomplete: "cc-number", focused: true, index: 0 },
                { autocomplete: "cc-csc", focused: false, index: 1 },
              ],
            },
          };
        else if (expression.includes("vaultSecret"))
          result = { result: { value: 2 } };
        else result = { result: { objectId: "input-1" } };
        break;
      }
      case "DOM.describeNode":
        result = { node: { backendNodeId: 1 } };
        break;
      case "DOM.resolveNode":
        result = { object: { objectId: "card-anchor" } };
        break;
      case "Runtime.callFunctionOn": {
        const script = z.string().parse(command.params?.functionDeclaration);
        result = {
          result: {
            value: script.includes("candidates.length")
              ? evaluateBillingPostalCode(
                  script,
                  z
                    .array(z.object({ value: z.json() }))
                    .parse(command.params?.arguments)
                    .map(({ value }) => value)
                )
              : evaluateCardStatus(script, true),
          },
        };
        break;
      }
    }
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            id: command.id,
            result,
            error:
              command.method === "Autofill.trigger" && failFill
                ? { message: "unknown fill outcome" }
                : undefined,
          }),
        })
      )
    );
  }
}

const input = {
  browserSessionId: "browser-1",
  expectedOrigin: "https://shop.example",
  kind: "payment" as const,
  claims: Object.entries({
    "cc-name": "Test Buyer",
    "cc-number": "4242424242424242",
    "cc-csc": "098",
    "cc-exp-month": "12",
    "cc-exp-year": "2035",
  }).map(([token, value]) => ({ id: token, token, value })),
};
beforeEach(() => {
  commands.length = 0;
  pageOrigin = "https://shop.example";
  frameOrigin = pageOrigin;
  failFill = false;
  cardStatuses = [];
  cardForm = undefined;
  insertedForm = false;
  detachedAnchor = false;
  vi.stubGlobal("WebSocket", BrowserSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("native payment injection", () => {
  it("overwrites a personal ZIP with the credential's billing ZIP without exposing it", async () => {
    const zip = new CardInput("billing postal-code", "10001");
    cardForm = [new CardInput("cc-number"), new CardInput("cc-exp"), zip];
    const result = await fillWithKernelNativeAutofill({
      ...input,
      claims: [
        ...input.claims,
        { id: "zip", token: "postal-code", value: "94107" },
      ],
    });
    expect(zip.value).toBe("94107");
    expect(zip.dataset.vaultSecret).toBe("true");
    expect(zip.events).toEqual(["input", "change"]);
    expect(result).toEqual({ filledClaims: 6, origin: "https://shop.example" });
    expect(JSON.stringify(result)).not.toContain("94107");
  });

  it("recognizes an unannotated billing ZIP input", async () => {
    const zip = new CardInput("", "10001");
    zip.id = "BillingZip";
    cardForm = [new CardInput("cc-number"), zip];
    await fillWithKernelNativeAutofill({
      ...input,
      claims: [
        ...input.claims,
        { id: "zip", token: "postal-code", value: "94107" },
      ],
    });
    expect(zip.value).toBe("94107");
  });

  it.each(["ZIP Code", "Postal Code", "Postcode"])(
    "recognizes an unannotated %s label among other metadata",
    async (label) => {
      const zip = new CardInput("off", "10001");
      zip.id = "field-x";
      zip.name = "field-x";
      zip.labels = [{ textContent: label }];
      cardForm = [new CardInput("cc-number"), zip];
      await fillWithKernelNativeAutofill({
        ...input,
        claims: [
          ...input.claims,
          { id: "zip", token: "postal-code", value: "94107" },
        ],
      });
      expect(zip.value).toBe("94107");
    }
  );

  it("does not keep a personal ZIP when an unannotated ZIP Code lacks a credential value", async () => {
    const zip = new CardInput("off", "10001");
    zip.id = "zip";
    zip.name = "zip";
    zip.labels = [{ textContent: "ZIP Code" }];
    cardForm = [new CardInput("cc-number"), zip];
    await expect(fillWithKernelNativeAutofill(input)).rejects.toThrow(
      "billing ZIP that the payment credential has not supplied"
    );
    expect(commands.some(({ method }) => method === "Autofill.trigger")).toBe(
      false
    );
  });

  it("stops before card filling when the credential lacks a required billing ZIP", async () => {
    const zip = new CardInput("billing postal-code", "10001");
    cardForm = [new CardInput("cc-number"), zip];
    await expect(fillWithKernelNativeAutofill(input)).rejects.toThrow(
      "billing ZIP that the payment credential has not supplied"
    );
    expect(zip.value).toBe("10001");
    expect(commands.some(({ method }) => method === "Autofill.trigger")).toBe(
      false
    );
  });

  it("does not fill ambiguous billing ZIP controls", async () => {
    cardForm = [
      new CardInput("cc-number"),
      new CardInput("billing postal-code", ""),
      new CardInput("billing postal-code", ""),
    ];
    await expect(
      fillWithKernelNativeAutofill({
        ...input,
        claims: [
          ...input.claims,
          { id: "zip", token: "postal-code", value: "94107" },
        ],
      })
    ).rejects.toThrow("Billing ZIP is ambiguous");
    expect(commands.some(({ method }) => method === "Autofill.trigger")).toBe(
      false
    );
  });

  it("keeps shipping ZIP separate from the card's billing ZIP", async () => {
    const shipping = new CardInput("shipping postal-code", "10001");
    cardForm = [new CardInput("cc-number"), shipping];
    await fillWithKernelNativeAutofill({
      ...input,
      claims: [
        ...input.claims,
        { id: "zip", token: "postal-code", value: "94107" },
      ],
    });
    expect(shipping.value).toBe("10001");
    expect(shipping.events).toEqual([]);
  });

  it("marks controls before sending card fields through CDP and returns only a receipt", async () => {
    const result = await fillWithKernelNativeAutofill(input);
    const fillIndex = commands.findIndex(
      ({ method }) => method === "Autofill.trigger"
    );
    const maskIndex = commands.findIndex(({ params }) =>
      z.string().safeParse(params?.expression).data?.includes("vaultSecret")
    );
    expect(maskIndex).toBeGreaterThan(-1);
    expect(maskIndex).toBeLessThan(fillIndex);
    expect(commands[fillIndex]?.params?.card).toEqual({
      name: "Test Buyer",
      number: "4242424242424242",
      cvc: "098",
      expiryMonth: "12",
      expiryYear: "2035",
    });
    expect(result).toEqual({ filledClaims: 5, origin: "https://shop.example" });
  });
  it("waits for Chromium to apply the card before confirming it", async () => {
    cardStatuses = [
      { number: "empty", expiry: "empty", securityCode: "empty" },
      filledCard,
    ];
    await expect(fillWithKernelNativeAutofill(input)).resolves.toEqual({
      filledClaims: 5,
      origin: "https://shop.example",
    });
    expect(cardStatuses).toHaveLength(0);
  });
  it("reports annotated card fields left empty without retrying", async () => {
    cardStatuses = Array.from({ length: 8 }, () => ({
      number: "filled",
      expiry: "absent",
      securityCode: "empty",
    }));
    const result = fillWithKernelNativeAutofill(input);
    await expect(result).rejects.toBeInstanceOf(PaymentFillError);
    await expect(result).rejects.toThrow(
      "Card autofill left required fields empty: security code."
    );
    expect(
      commands.filter(({ method }) => method === "Autofill.trigger")
    ).toHaveLength(1);
  });
  it("does not require card fields that carry no autocomplete annotation", async () => {
    cardStatuses = [
      { number: "absent", expiry: "absent", securityCode: "absent" },
    ];
    await expect(fillWithKernelNativeAutofill(input)).resolves.toEqual({
      filledClaims: 5,
      origin: "https://shop.example",
    });
  });
  it.each([
    "hidden",
    "display",
    "visibility",
    "rects",
    "disabled",
    "fieldset",
    "readonly",
  ])(
    "does not require a %s card field that native autofill cannot fill",
    async (kind) => {
      const unused = new CardInput("cc-csc", "");
      if (kind === "hidden") unused.type = "hidden";
      if (kind === "display") unused.style.display = "none";
      if (kind === "visibility") unused.style.visibility = "hidden";
      if (kind === "rects") unused.visible = false;
      if (kind === "disabled") unused.disabled = true;
      if (kind === "fieldset") unused.disabledByFieldset = true;
      if (kind === "readonly") unused.readOnly = true;
      cardForm = [new CardInput("cc-number"), new CardInput("cc-exp"), unused];
      await expect(fillWithKernelNativeAutofill(input)).resolves.toEqual({
        filledClaims: 5,
        origin: "https://shop.example",
      });
    }
  );
  it("ignores hidden expiration alternatives beside a filled combined field", async () => {
    const month = new CardInput("cc-exp-month", "");
    const year = new CardInput("cc-exp-year", "");
    month.type = "hidden";
    year.type = "hidden";
    cardForm = [
      new CardInput("cc-number"),
      new CardInput("cc-exp"),
      month,
      year,
    ];
    await expect(fillWithKernelNativeAutofill(input)).resolves.toHaveProperty(
      "filledClaims",
      5
    );
  });
  it("does not let a hidden filled duplicate confirm an empty visible CVC", async () => {
    const hidden = new CardInput("cc-csc");
    hidden.type = "hidden";
    cardForm = [
      new CardInput("cc-number"),
      new CardInput("cc-exp"),
      hidden,
      new CardInput("cc-csc", ""),
    ];
    await expect(fillWithKernelNativeAutofill(input)).rejects.toThrow(
      "Card autofill left required fields empty: security code."
    );
    expect(
      commands.filter(({ method }) => method === "Autofill.trigger")
    ).toHaveLength(1);
  });
  it("confirms the original input when another form shifts its document index", async () => {
    cardForm = [new CardInput("cc-number"), new CardInput("cc-exp")];
    insertedForm = true;
    await expect(fillWithKernelNativeAutofill(input)).resolves.toHaveProperty(
      "filledClaims",
      5
    );
    expect(
      commands.find(({ method }) => method === "DOM.resolveNode")
    ).toMatchObject({
      params: { backendNodeId: 1, executionContextId: 1 },
      sessionId: "cdp-1",
    });
    expect(
      commands.find(({ method }) => method === "Runtime.callFunctionOn")
    ).toMatchObject({
      params: { objectId: "card-anchor", returnByValue: true },
    });
    expect(commands.at(-2)).toMatchObject({
      method: "Runtime.releaseObject",
      params: { objectId: "card-anchor" },
    });
  });
  it("stops without retrying when the actual autofilled input is detached", async () => {
    cardForm = [new CardInput("cc-number")];
    detachedAnchor = true;
    await expect(fillWithKernelNativeAutofill(input)).rejects.toThrow(
      "The autofilled card input disappeared"
    );
    expect(
      commands.filter(({ method }) => method === "Autofill.trigger")
    ).toHaveLength(1);
    expect(commands.at(-2)).toMatchObject({
      method: "Runtime.releaseObject",
      params: { objectId: "card-anchor" },
    });
  });
  it("rechecks the top-level merchant origin before injection", async () => {
    pageOrigin = "https://other.example";
    await expect(fillWithKernelNativeAutofill(input)).rejects.toThrow(
      "no longer matches"
    );
    expect(commands.some(({ method }) => method === "Autofill.trigger")).toBe(
      false
    );
  });
  it("does not disclose cards to a cross-origin frame", async () => {
    frameOrigin = "https://processor.example";
    await expect(fillWithKernelNativeAutofill(input)).rejects.toThrow(
      "No visible form control"
    );
    expect(commands.some(({ method }) => method === "Autofill.trigger")).toBe(
      false
    );
  });
  it("does not try another control after an uncertain payment fill", async () => {
    failFill = true;
    await expect(fillWithKernelNativeAutofill(input)).rejects.toThrow(
      "unknown fill outcome"
    );
    expect(
      commands.filter(({ method }) => method === "Autofill.trigger")
    ).toHaveLength(1);
  });
});
