import { afterEach, describe, expect, it, vi } from "vitest";

import { publicRoutePath } from "#public/channels/public-route-path.js";
import { EVE_PUBLIC_ROUTE_PREFIX_ENV } from "#shared/public-route-prefix.js";

describe("publicRoutePath", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("maps internal channel routes using EVE_PUBLIC_ROUTE_PREFIX", () => {
    vi.stubEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV, "");
    expect(publicRoutePath("/eve/v1/board")).toBe("/eve/v1/board");

    vi.stubEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV, "/eve/support");
    expect(publicRoutePath("/eve/v1/board")).toBe("/eve/support/v1/board");

    vi.stubEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV, "/eve/support/v1");
    expect(publicRoutePath("/eve/v1/board")).toBe("/eve/support/v1/board");

    vi.stubEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV, "/eve/v1");
    expect(publicRoutePath("/eve/v1/board")).toBe("/eve/v1/board");

    vi.stubEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV, "api/eve/");
    expect(publicRoutePath("/eve/v1/board")).toBe("/api/eve/eve/v1/board");
  });

  it("prefers an explicit prefix argument over the environment", () => {
    vi.stubEnv(EVE_PUBLIC_ROUTE_PREFIX_ENV, "/eve/support");
    expect(publicRoutePath("/eve/v1/board", "")).toBe("/eve/v1/board");
    expect(publicRoutePath("/eve/v1/board", "/eve/billing")).toBe("/eve/billing/v1/board");
  });
});
