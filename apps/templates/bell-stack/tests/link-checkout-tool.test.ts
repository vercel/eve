import { afterEach, describe, expect, it, vi } from "vitest";
import { retrieve_spend_request } from "@stripe/link-integrations-eve/tools";
import checkout from "../agent/extensions/link/tools/checkout";
import { checkoutInHostedPage } from "../server/link/checkout-browser";
import { runBrowserOperation } from "../agent/lib/browser-runtime";
vi.mock("../agent/lib/link-auth", () => ({ linkPrincipal: (ctx: { authorized?: boolean }) => { if (!ctx.authorized) throw new Error("principal_required"); }, freshLinkContext: (ctx: unknown) => ctx }));
vi.mock("../agent/lib/browser-runtime", () => ({ runCancelableBrowserWork: (_id: string, _signal: AbortSignal, operation: () => unknown) => operation(), runBrowserOperation: vi.fn(async (_id, operation) => ({ result: await operation({ withHostedPage: (_signal: AbortSignal, call: (page: unknown, url: string) => unknown) => call({}, "private-connection") }), workbench: { private: "not-returned" } })) }));
vi.mock("../server/link/checkout-browser", () => ({ checkoutInHostedPage: vi.fn() }));
const input = { id: "spend_fixture", amount: 100, currency: "usd", credential: "card" as const, fields: [{ field: "number" as const, selector: "#card" }], submit: { selector: "#pay" } };
const ctx = { authorized: true, session: { id: "synthetic-session" }, abortSignal: new AbortController().signal };
const approved = { id: input.id, status: "approved", amount: 100, currency: "usd", merchant_url: "https://merchant.example", created_at: "now", updated_at: "now" };
afterEach(() => vi.restoreAllMocks());
describe("Link checkout tool", () => {
  it("rechecks approval at private retrieval and returns no credentials or browser workbench", async () => {
    const native = vi.spyOn(retrieve_spend_request, "execute").mockResolvedValueOnce(approved as never).mockResolvedValueOnce({ ...approved, card: { number: "synthetic-private" } } as never);
    vi.mocked(checkoutInHostedPage).mockImplementation(async (_page, _url, _input, _origins, get) => { expect(await get()).toHaveProperty("card.number", "synthetic-private"); return { id: input.id, status: "submission_attempted", verify_payment: true }; });
    expect(await checkout.execute(input, ctx as never)).toEqual({ id: input.id, status: "submission_attempted", verify_payment: true });
    expect(native.mock.calls.map(call => call[0])).toEqual([{ id: input.id }, { id: input.id, include: ["card"] }]);
  });
  it("stops when approval changes before credentials can be used", async () => {
    vi.spyOn(retrieve_spend_request, "execute").mockResolvedValueOnce(approved as never).mockResolvedValueOnce({ ...approved, status: "canceled", card: { number: "synthetic-private" } } as never);
    vi.mocked(checkoutInHostedPage).mockImplementation(async (_page, _url, _input, _origins, get) => { await get(); throw new Error("must not reach submission"); });
    await expect(checkout.execute(input, ctx as never)).rejects.toThrow("approval");
  });
  it("rejects an unauthenticated sender or unapproved request before browser work", async () => {
    await expect(checkout.execute(input, { ...ctx, authorized: false } as never)).rejects.toThrow("principal_required");
    const native = vi.spyOn(retrieve_spend_request, "execute").mockResolvedValue({ ...approved, status: "pending_approval" } as never);
    vi.mocked(runBrowserOperation).mockClear();
    await expect(checkout.execute(input, ctx as never)).rejects.toThrow("approval");
    expect(native).toHaveBeenCalledTimes(1);
    expect(runBrowserOperation).not.toHaveBeenCalled();
  });
});
