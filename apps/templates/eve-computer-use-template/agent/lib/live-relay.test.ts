import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import net from "node:net";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";

const { createRelay } = createRequire(import.meta.url)("./live-relay.cjs") as {
  createRelay: (options: {
    token: string;
    browserPort: number;
    browserSession: string;
    run: (
      file: string,
      args: string[],
      options: unknown,
      done: (error: Error | null) => void,
    ) => void;
  }) => import("node:http").Server;
};

const TOKEN = "a".repeat(48);
const ran: string[][] = [];
let server: import("node:http").Server;
let base: string;

before(async () => {
  server = createRelay({
    token: TOKEN,
    browserPort: 1,
    browserSession: "agent",
    run: (_file, args, _options, done) => {
      ran.push(args);
      done(null);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string) => fetch(`${base}${path}`, { method: "POST" }).then((r) => r.status);

/** The first line of the relay's answer to a raw request. */
function raw(request: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect((server.address() as AddressInfo).port, "127.0.0.1", () =>
      socket.write(request),
    );
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
    setTimeout(() => socket.destroy(), 1000);
  });
}

test("history and open need the relay's token", async () => {
  assert.equal(await post("/browser/navigate?action=back"), 403);
  assert.equal(await post(`/browser/navigate?token=${"b".repeat(48)}&action=back`), 403);
  assert.equal(await post(`/browser/navigate?token=${TOKEN.slice(1)}&action=back`), 403);
  assert.deepEqual(ran, []);
  assert.equal(await post(`/browser/navigate?token=${TOKEN}&action=back`), 204);
  assert.deepEqual(ran.pop(), ["--session", "agent", "back"]);
});

test("history runs only back, forward, and reload", async () => {
  assert.equal(await post(`/browser/navigate?token=${TOKEN}&action=close`), 403);
  assert.deepEqual(ran, []);
});

test("open passes only http(s) URLs, as one argument", async () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "not a url"])
    assert.equal(await post(`/browser/open?token=${TOKEN}&url=${encodeURIComponent(url)}`), 403);
  assert.deepEqual(ran, []);
  const url = "https://example.com/?q=a b;rm -rf";
  assert.equal(await post(`/browser/open?token=${TOKEN}&url=${encodeURIComponent(url)}`), 204);
  assert.deepEqual(ran.pop(), ["--session", "agent", "open", new URL(url).href]);
});

test("a malformed request target is refused, and the relay keeps serving", async () => {
  assert.match(await raw("GET http://[ HTTP/1.1\r\nhost: x\r\n\r\n"), / 400 /);
  assert.match(
    await raw(
      "GET http://[ HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n",
    ),
    / 403 /,
  );
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("the stream upgrade needs the token and the browser path", async () => {
  const upgrade = (path: string) =>
    raw(
      `GET ${path} HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\n\r\n`,
    );
  assert.match(await upgrade("/browser"), / 403 /);
  assert.match(await upgrade(`/desktop?token=${TOKEN}`), / 403 /);
});
