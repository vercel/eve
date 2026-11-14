import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fillKernelPaymentFields, PaymentFillError } from "../native";
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
let processorOrigin = "https://assets.braintreegateway.com";
let processorFragment = "";
let changedPage = false;
let omittedChildFrames = false;
let omittedParentTarget = false;
let hiddenFrame = false;
let hideAfterWrite = false;
let ambiguous = false;
let duplicate = false;
let failFill = false;
let fills = 0;

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
    let result: NonNullable<z.infer<typeof commandSchema>["params"]> = {};
    let error: { message: string } | undefined;
    const processorFrame = {
      id: "processor-frame",
      url: `${processorOrigin}/fields`,
      urlFragment: processorFragment,
    };
    switch (command.method) {
      case "Target.getTargets": {
        const processorTarget = {
          targetId: "processor-frame",
          parentFrameId: "main-frame",
          type: "iframe",
          url: processorFrame.url,
        };
        result = {
          targetInfos: [
            {
              targetId: "page-1",
              type: "page",
              url: "https://shop.example/checkout",
            },
            omittedParentTarget
              ? processorTarget
              : { ...processorTarget, parentId: "page-1" },
          ],
        };
        break;
      }
      case "Target.attachToTarget":
        result = {
          sessionId:
            command.params?.targetId === "page-1"
              ? "page-session"
              : "processor-session",
        };
        break;
      case "Page.getFrameTree":
        result = {
          frameTree:
            command.sessionId === "page-session"
              ? {
                  frame: {
                    id: "main-frame",
                    url: "https://shop.example/checkout",
                  },
                  childFrames: omittedChildFrames
                    ? []
                    : [{ frame: processorFrame }],
                }
              : { frame: processorFrame },
        };
        break;
      case "Page.createIsolatedWorld":
        if (
          command.sessionId === "page-session" &&
          command.params?.frameId === "processor-frame"
        )
          error = { message: "Frame belongs to another target" };
        else
          result = {
            executionContextId:
              command.sessionId === "processor-session" ? 2 : 1,
          };
        break;
      case "Runtime.evaluate": {
        const expression = z.string().parse(command.params?.expression);
        if (expression === frameOriginExpression)
          result = {
            result: {
              value:
                command.params?.contextId === 2
                  ? processorOrigin
                  : "https://shop.example",
            },
          };
        else if (expression === "location.href")
          result = {
            result: {
              value:
                changedPage && fills > 0
                  ? "https://other.example/checkout"
                  : "https://shop.example/checkout",
            },
          };
        else if (expression.includes("const bindings"))
          result = {
            result: {
              value:
                command.params?.contextId === 2
                  ? [
                      { bindingIndex: 0, inputIndex: 0 },
                      { bindingIndex: 1, inputIndex: 1 },
                      { bindingIndex: 2, inputIndex: duplicate ? 0 : 2 },
                      ...(ambiguous
                        ? [{ bindingIndex: 0, inputIndex: 3 }]
                        : []),
                    ]
                  : [],
            },
          };
        else
          result = {
            result: {
              objectId: `input-${/item\((\d+)\)/u.exec(expression)?.[1] ?? "0"}`,
            },
          };
        break;
      }
      case "DOM.describeNode":
        result = {
          node: {
            backendNodeId:
              Number(
                z.string().parse(command.params?.objectId).split("-").at(-1)
              ) + 1,
          },
        };
        break;
      case "DOM.getFrameOwner":
        result = { backendNodeId: 100 };
        break;
      case "DOM.resolveNode":
        result = { object: { objectId: "frame-owner" } };
        break;
      case "Runtime.callFunctionOn":
        if (command.params?.objectId === "frame-owner")
          result = {
            result: { value: !hiddenFrame && !(hideAfterWrite && fills > 0) },
          };
        else {
          fills += 1;
          result = { result: { value: !failFill } };
        }
        break;
    }
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ id: command.id, result, error }),
        })
      )
    );
  }
}

const input = {
  browserSessionId: "browser-1",
  pageUrl: "https://shop.example/checkout",
  expectedOrigin: "https://shop.example",
  fields: [
    { selector: "#number", value: "4242424242424242" },
    { selector: "#expiry", value: "12/35" },
    { selector: "#cvc", value: "098" },
  ],
};
beforeEach(() => {
  commands.length = 0;
  processorOrigin = "https://assets.braintreegateway.com";
  processorFragment = "";
  changedPage = false;
  omittedChildFrames = false;
  omittedParentTarget = false;
  hiddenFrame = false;
  hideAfterWrite = false;
  ambiguous = false;
  duplicate = false;
  failFill = false;
  fills = 0;
  vi.stubGlobal("WebSocket", BrowserSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("hosted payment field injection", () => {
  it.each([
    "https://assets.braintreegateway.com",
    "https://checkout.pci.shopifyinc.com",
    "https://checkout.shopifycs.com",
    "https://www.paypal.com",
    "https://js.stripe.com",
  ])("fills one approved checkout across %s frames", async (provider) => {
    processorOrigin = provider;
    const result = await fillKernelPaymentFields(input);
    expect(result).toEqual({ filledClaims: 3, origin: "https://shop.example" });
    const writes = commands.filter(
      ({ method, params }) =>
        method === "Runtime.callFunctionOn" &&
        params?.objectId !== "frame-owner"
    );
    expect(writes).toHaveLength(3);
    expect(
      writes.every(({ sessionId }) => sessionId === "processor-session")
    ).toBe(true);
    expect(writes[0]?.params?.functionDeclaration).toEqual(
      expect.stringContaining("vaultSecret")
    );
    expect(writes[0]?.params?.arguments).toEqual([
      { value: "4242424242424242" },
      { value: provider },
      { value: `${provider}/fields` },
      { value: "#number" },
      { value: null },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/4242424242424242|098/u);
    expect(commands.some(({ method }) => method === "Autofill.trigger")).toBe(
      false
    );
  });
  it("discovers out-of-process descendants omitted from the main frame tree", async () => {
    omittedChildFrames = true;
    await expect(fillKernelPaymentFields(input)).resolves.toEqual({
      filledClaims: 3,
      origin: "https://shop.example",
    });
    expect(fills).toBe(3);
  });
  it("discovers out-of-process frames by parent frame when Chromium omits the parent target", async () => {
    omittedChildFrames = true;
    omittedParentTarget = true;
    await expect(fillKernelPaymentFields(input)).resolves.toEqual({
      filledClaims: 3,
      origin: "https://shop.example",
    });
    expect(fills).toBe(3);
  });
  it("retains hosted frame URL fragments when pinning the field document", async () => {
    processorFragment = "#hosted-config";
    await fillKernelPaymentFields(input);
    const write = commands.find(
      ({ method, params }) =>
        method === "Runtime.callFunctionOn" &&
        params?.objectId !== "frame-owner"
    );
    expect(write?.params?.arguments).toEqual(
      expect.arrayContaining([
        { value: "https://assets.braintreegateway.com/fields#hosted-config" },
      ])
    );
  });
  it("excludes a hidden containing iframe before passing card values", async () => {
    hiddenFrame = true;
    const result = fillKernelPaymentFields(input);
    await expect(result).rejects.toBeInstanceOf(PaymentFillError);
    await expect(result).rejects.toThrow(
      "one visible payment input in the approved checkout; binding 1 matched 0"
    );
    expect(fills).toBe(0);
    expect(JSON.stringify(commands)).not.toContain("4242424242424242");
  });
  it("rechecks ancestor visibility before each write", async () => {
    hideAfterWrite = true;
    await expect(fillKernelPaymentFields(input)).rejects.toThrow(
      "frame became hidden"
    );
    expect(fills).toBe(1);
  });
  it("rejects unrelated frame origins before sending card values", async () => {
    processorOrigin = "https://assets.braintreegateway.com.attacker.example";
    await expect(fillKernelPaymentFields(input)).rejects.toThrow(
      "one visible payment input"
    );
    expect(fills).toBe(0);
    expect(JSON.stringify(commands)).not.toContain("4242424242424242");
  });
  it.each(["ambiguous", "duplicate"])(
    "rejects %s bindings before filling",
    async (kind) => {
      ambiguous = kind === "ambiguous";
      duplicate = kind === "duplicate";
      await expect(fillKernelPaymentFields(input)).rejects.toThrow(
        /one visible|distinct inputs/u
      );
      expect(fills).toBe(0);
    }
  );
  it("stops on a changed checkout without writing another field", async () => {
    changedPage = true;
    await expect(fillKernelPaymentFields(input)).rejects.toThrow(
      "checkout changed"
    );
    expect(fills).toBe(1);
  });
  it("stops after the first uncertain field and never retries", async () => {
    failFill = true;
    await expect(fillKernelPaymentFields(input)).rejects.toThrow(
      "rejected filling"
    );
    expect(fills).toBe(1);
    expect(
      commands.filter(({ method }) => method === "Target.attachToTarget")
    ).toHaveLength(2);
  });
  it("requires the exact approved HTTPS checkout page", async () => {
    await expect(
      fillKernelPaymentFields({
        ...input,
        pageUrl: "https://shop.example/another-checkout",
      })
    ).rejects.toThrow("uniquely available");
    await expect(
      fillKernelPaymentFields({
        ...input,
        pageUrl: "http://shop.example/checkout",
      })
    ).rejects.toThrow("approved HTTPS");
    expect(fills).toBe(0);
  });
});
