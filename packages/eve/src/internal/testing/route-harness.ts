import type { Mock } from "vitest";
import { vi } from "vitest";

import type { Agent, RouteContext } from "#public/definitions/channel.js";

/**
 * Reusable primitives for testing channel routes that depend on the
 * framework-ctx surface (`agent.run`, `agent.deliver`, `waitUntil`).
 *
 * Kept internal so unit tests can wire up the minimum needed to exercise
 * the `fetch` handler without pulling in real runtime machinery.
 */

/**
 * Observable mock {@link Agent}. The `run` / `deliver` / `cancelTurn` / `getEventStream`
 * methods are `vi.fn()` instances, so tests can assert on call counts,
 * arguments, and reorder return values mid-test with `mockResolvedValueOnce`.
 */
export interface MockAgent extends Agent {
  readonly cancelTurn: Mock;
  readonly run: Mock;
  readonly deliver: Mock;
  readonly getEventStream: Mock;
}

/**
 * Builds a {@link MockAgent} with sensible default resolved values:
 *
 * - `run` resolves to a fake handle whose `result` is `{ status: "completed", output: "ok" }`.
 * - `deliver` resolves to `undefined`.
 * - `getEventStream` resolves to an empty `ReadableStream`.
 *
 * Override individual methods with `mockResolvedValueOnce` /
 * `mockRejectedValueOnce` etc. when you need a different per-test flow.
 */
export function createMockAgent(): MockAgent {
  return {
    cancelTurn: vi.fn().mockResolvedValue({ status: "no_active_turn" }),
    deliver: vi.fn().mockResolvedValue(undefined),
    getEventStream: vi.fn().mockResolvedValue(new ReadableStream()),
    run: vi.fn().mockResolvedValue({
      continuationToken: "http:test",
      events: new ReadableStream(),
      result: Promise.resolve({ output: "ok", status: "completed" as const }),
      sessionId: "test-session-id",
    }),
  } satisfies MockAgent;
}

/**
 * Builds a minimal {@link RouteContext} for tests. `waitUntil` is a
 * no-op, `params` is empty, and `requestIp` defaults to `127.0.0.1`
 * unless overridden.
 */
export function createRouteContext(input: {
  readonly agent: Agent;
  readonly params?: Readonly<Record<string, string>>;
  readonly requestIp?: string;
}): RouteContext {
  return {
    agent: input.agent,
    params: input.params ?? {},
    requestIp: input.requestIp ?? "127.0.0.1",
    waitUntil: () => undefined,
  };
}

/**
 * Canonical URL for the HTTP message route. Hoisted into a constant so
 * tests stay independent of the actual mount path constant.
 */
export const HTTP_CREATE_ROUTE_URL = "https://example.com/eve/v1/session";
export const HTTP_CONTINUE_ROUTE_URL = "https://example.com/eve/v1/session";

/**
 * Builds a JSON POST `Request` for the HTTP message route.
 */
export function createJsonMessageRequest(body: unknown): Request {
  return new Request(HTTP_CREATE_ROUTE_URL, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}
