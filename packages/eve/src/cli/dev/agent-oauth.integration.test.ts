import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("#setup/primitives/open-url.js", () => ({
  openUrl: (url: string) => void fetch(url, { redirect: "follow" }),
}));

const { signInToAgent } = await import("#cli/dev/agent-oauth.js");

let server: Server;
let origin: string;
const issued: string[] = [];
const registered: string[] = [];

beforeEach(async () => {
  home.dir = await mkdtemp(join(tmpdir(), "eve-agent-oauth-"));
  issued.length = 0;
  registered.length = 0;
  server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const body = await new Promise<string>((resolve) => {
      let text = "";
      request.on("data", (chunk) => (text += chunk));
      request.on("end", () => resolve(text));
    });
    const json = (value: unknown) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/eve/v1":
        return json({ authorization_servers: [origin], resource: `${origin}/eve/v1` });
      case "/.well-known/oauth-authorization-server":
        return json({
          authorization_endpoint: `${origin}/authorize`,
          code_challenge_methods_supported: ["S256"],
          issuer: origin,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          token_endpoint: `${origin}/token`,
        });
      case "/register": {
        const metadata = JSON.parse(body) as { redirect_uris: string[] };
        registered.push(metadata.redirect_uris[0]!);
        return json({ ...metadata, client_id: `client-${registered.length}` });
      }
      case "/authorize": {
        expect(url.searchParams.get("resource")).toBe(`${origin}/eve/v1`);
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", "code-1");
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        return response.writeHead(302, { location: redirect.href }).end();
      }
      case "/token": {
        const form = new URLSearchParams(body);
        const token = `access-${issued.length + 1}`;
        issued.push(form.get("grant_type")!);
        return json({
          access_token: token,
          expires_in: 3600,
          refresh_token: `refresh-${issued.length}`,
          token_type: "Bearer",
        });
      }
      default:
        return response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(home.dir, { force: true, recursive: true });
});

describe("signInToAgent", () => {
  it("registers, signs in through the browser, and reuses the stored token", async () => {
    const notices: string[] = [];
    const first = await signInToAgent({
      notice: (message) => notices.push(message),
      serverUrl: origin,
    });
    expect(first?.resource).toBe(`${origin}/eve/v1`);
    expect(await first?.token()).toBe("access-1");
    expect(issued).toEqual(["authorization_code"]);
    expect(registered).toHaveLength(1);
    expect(notices[0]).toContain("Sign in to");

    const second = await signInToAgent({ notice: () => {}, serverUrl: origin });
    expect(await second?.token()).toBe("access-1");
    expect(issued).toEqual(["authorization_code"]);
  });

  it("returns undefined for an agent that publishes no OAuth metadata", async () => {
    expect(
      await signInToAgent({ notice: () => {}, serverUrl: `${origin}/elsewhere` }),
    ).toBeUndefined();
  });
});
