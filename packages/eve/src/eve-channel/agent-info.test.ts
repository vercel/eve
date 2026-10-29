import { afterEach, describe, expect, it, vi } from "vitest";
import { eveChannel } from "#eve-channel/index.js";
import type { EveAuthFn } from "#eve-channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { localDev } from "#public/channels/auth.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { attachAgentInfoRouteResponse } from "#internal/nitro/routes/channel-route-context.js";
import { EVE_INFO_ROUTE_PATH } from "#protocol/routes.js";

const caller = (principalType: string, allowAgentInfo?: boolean): EveAuthFn => {
  return () => ({
    attributes: {},
    authenticator: "test",
    principalId: "caller",
    principalType,
    ...(allowAgentInfo === undefined ? {} : { allowAgentInfo }),
  });
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("agent info access", () => {
  it.each([
    ["serves an omitted-grant operator", [caller("service")], 200],
    ["refuses an omitted-grant user", [caller("user")], 403],
    ["serves a user granted allowAgentInfo", [caller("user", true)], 200],
    ["refuses an operator denied allowAgentInfo", [caller("service", false)], 403],
  ] as const)("on a deployment, %s", async (_case, auth, status) => {
    expect((await requestInfo(auth)).status).toBe(status);
  });

  it.each([
    ["serves a user when the channel configures localDev()", [caller("user"), localDev()], 200],
    ["refuses a user when the channel does not configure localDev()", [caller("user")], 403],
    ["refuses a user denied allowAgentInfo", [caller("user", false), localDev()], 403],
  ] as const)("on a development server, %s", async (_case, auth, status) => {
    vi.stubEnv("EVE_DEV", "1");
    expect((await requestInfo(auth)).status).toBe(status);
  });

  it("tells a refused caller how to get access", async () => {
    const response = await requestInfo([caller("user")]);
    expect(await response.json()).toEqual({
      code: "info_forbidden",
      error: expect.stringContaining("allowAgentInfo: true"),
      ok: false,
    });
  });
});

async function requestInfo(auth: readonly EveAuthFn[]): Promise<Response> {
  const route = eveChannel({ auth }).routes!.find(
    (route) => route.method === "GET" && route.path === EVE_INFO_ROUTE_PATH,
  )!;
  const args = attachAgentInfoRouteResponse(
    {
      ...mockAgentRouteArgs(),
      ...mockChannelContext(() => {
        throw new Error("Unexpected channel dispatch.");
      }),
      params: {},
      waitUntil: () => undefined,
      requestIp: "127.0.0.1",
      attachSession: () => {
        throw new Error("Unexpected session access.");
      },
      to: () => {
        throw new Error("Unexpected remote dispatch.");
      },
    } satisfies RouteHandlerArgs,
    async () => Response.json({ ok: true }),
  );
  return (await route.handler(
    new Request(`http://localhost:3000${EVE_INFO_ROUTE_PATH}`),
    args,
  )) as Response;
}
