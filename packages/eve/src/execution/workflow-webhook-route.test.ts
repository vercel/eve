import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  resumeWebhook: vi.fn<(token: string, request: Request) => Promise<Response>>(),
}));

vi.mock("#internal/workflow/runtime.js", () => ({ resumeWebhook: runtime.resumeWebhook }));

const { HookNotFoundError } = await import("#compiled/@workflow/errors/index.js");
const { handleWorkflowWebhookRequest, WORKFLOW_WEBHOOK_ROUTE_PATTERN } =
  await import("#execution/workflow-webhook-route.js");

function route(params: Record<string, string>) {
  return { params } as Parameters<typeof handleWorkflowWebhookRequest>[1];
}

describe("workflow webhook route", () => {
  it("serves the SDK's conventional webhook path", () => {
    expect(WORKFLOW_WEBHOOK_ROUTE_PATTERN).toBe("/.well-known/workflow/v1/webhook/:token");
  });

  it("resumes the webhook with the request and returns the SDK's response", async () => {
    const accepted = Response.json({ ok: true }, { status: 202 });
    runtime.resumeWebhook.mockResolvedValueOnce(accepted);
    const request = new Request("https://agent.example/.well-known/workflow/v1/webhook/tok", {
      body: "{}",
      method: "POST",
    });

    const response = await handleWorkflowWebhookRequest(request, route({ token: "tok" }));

    expect(response).toBe(accepted);
    expect(runtime.resumeWebhook).toHaveBeenCalledWith("tok", request);
  });

  it("rejects a missing token and reports an unknown hook as not pending", async () => {
    const missing = await handleWorkflowWebhookRequest(new Request("https://x/"), route({}));
    expect(missing.status).toBe(400);

    runtime.resumeWebhook.mockRejectedValueOnce(new HookNotFoundError("gone"));
    const gone = await handleWorkflowWebhookRequest(
      new Request("https://x/", { method: "POST" }),
      route({ token: "gone" }),
    );
    expect(gone.status).toBe(404);
    await expect(gone.json()).resolves.toEqual({ error: "Webhook not pending.", ok: false });
  });

  it("lets unexpected failures surface", async () => {
    runtime.resumeWebhook.mockRejectedValueOnce(new Error("world down"));
    await expect(
      handleWorkflowWebhookRequest(
        new Request("https://x/", { method: "POST" }),
        route({ token: "t" }),
      ),
    ).rejects.toThrow("world down");
  });
});
