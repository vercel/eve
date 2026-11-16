import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@browserbasehq/stagehand";
import { prepareMerchantAccess } from "../server/merchant-access";
import { navigateWithMerchantProof } from "../server/merchant-navigation";
import { verifiedMerchantAccess } from "../server/verified-merchant";

vi.mock("../server/merchant-access", () => ({
  allowedMerchantUrl: (url: string) => new URL(url),
  prepareMerchantAccess: vi.fn(),
}));
vi.mock("../server/merchant-navigation", () => ({
  navigateWithMerchantProof: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const url = "https://merchant.example/protected";
function fixture() {
  let nonce = 0;
  const headers = vi.fn(async () => ({
    "KYA-Credential": `private-proof-${++nonce}`,
  }));
  vi.mocked(prepareMerchantAccess).mockResolvedValue({
    audience: "merchant.example",
    scope: "trade",
    expiresAt: "2099-01-01",
    headers,
  });
  const page = {} as Page;
  return { page, headers };
}
describe("verified access results", () => {
  it("retries a temporary status lookup once with fresh proof on the same page", async () => {
    const { page, headers } = fixture();
    vi.mocked(navigateWithMerchantProof)
      .mockResolvedValueOnce({
        status: () => 401,
        text: async () => "STATUS_UNAVAILABLE",
      } as never)
      .mockResolvedValueOnce({ status: () => 200 } as never);
    const result = await verifiedMerchantAccess(
      page,
      "private-connection",
      url,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "access_granted",
      httpStatus: 200,
      attempts: 2,
    });
    expect(headers).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(navigateWithMerchantProof).mock.calls;
    expect(calls.every((args) => args[0] === page)).toBe(true);
    expect(calls[0][3]).not.toEqual(calls[1][3]);
    expect(JSON.stringify(result)).not.toMatch(/private-proof|private-connection|credential|jwk/i);
  });
  it.each(["NONCE_INVALID", "UNTRUSTED_ISSUER"])("reports %s without retrying", async (code) => {
    const { page, headers } = fixture();
    vi.mocked(navigateWithMerchantProof).mockResolvedValue({
      status: () => 401,
      text: async () => code,
    } as never);
    expect(
      await verifiedMerchantAccess(page, "private", url, new AbortController().signal),
    ).toMatchObject({
      status: "access_denied",
      code,
      attempts: 1,
    });
    expect(headers).toHaveBeenCalledTimes(1);
  });
  it("stops after two temporary failures", async () => {
    const { page, headers } = fixture();
    vi.mocked(navigateWithMerchantProof).mockResolvedValue({
      status: () => 401,
      text: async () => "STATUS_UNAVAILABLE",
    } as never);
    expect(
      await verifiedMerchantAccess(page, "private", url, new AbortController().signal),
    ).toMatchObject({ status: "access_denied", attempts: 2 });
    expect(headers).toHaveBeenCalledTimes(2);
  });
});
