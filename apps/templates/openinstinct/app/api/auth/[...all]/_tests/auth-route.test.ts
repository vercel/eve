/* oxlint-disable vitest/require-mock-type-parameters -- Auth initialization needs a deliberately partial Better Auth fixture. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const handler = vi.fn<(request: Request) => Promise<Response>>();
const mocks = vi.hoisted(() => ({
  getAuth: vi.fn(),
  toNextJsHandler: vi.fn(),
}));

vi.mock("@db/services/auth", () => ({ getAuth: mocks.getAuth }));
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: mocks.toNextJsHandler,
}));

beforeEach(() => {
  vi.clearAllMocks();
  handler.mockResolvedValue(Response.json({ ok: true }));
  mocks.toNextJsHandler.mockReturnValue({
    DELETE: handler,
    GET: handler,
    PATCH: handler,
    POST: handler,
    PUT: handler,
  });
});

describe("auth route initialization", () => {
  it("retries after transient installation-secret failures", async () => {
    mocks.getAuth
      .mockRejectedValueOnce(new Error("Blob temporarily unavailable"))
      .mockResolvedValueOnce({});
    const { GET } = await import("@app/api/auth/[...all]/route");
    const request = new Request(
      "https://openinstinct.example/api/auth/session"
    );

    await expect(GET(request)).rejects.toThrow("Blob temporarily unavailable");
    await expect(GET(request)).resolves.toMatchObject({ status: 200 });
    expect(mocks.getAuth).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledOnce();
  });
});
