import { Hono } from "hono";
import QRCode from "qrcode";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { assets } from "./assets.ts";
import { client } from "./client.ts";
import { config, appOrigin, setupIssues, SETUP_HELP } from "./config.ts";
import { computer, appStorage, issuePairing } from "./computer.ts";
import { expoGoPairingUrl } from "./expo-go.ts";
import mobileBundle from "./mobile-assets.ts";
import { hostedExpoGoUrl, mobileManifest } from "./mobile.ts";
const hash = (value: string) => createHash("sha256").update(value).digest();
export function startWeb(
  onMessage: () => Promise<unknown>,
  waitUntil: (task: Promise<unknown>) => void = (task) => {
    void task.catch(console.error);
  },
  options: { startBrowserOnLogin?: boolean; onStop?: (eventId: string) => Promise<unknown> } = {},
) {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 256 * 1024 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss://*.vercel.run; font-src 'self'; frame-ancestors 'none'",
    );
    await next();
  });
  for (const [path, asset] of Object.entries(assets))
    app.get(path, (c) => {
      c.header("Content-Type", asset.type);
      return c.body(Buffer.from(asset.body, "base64"));
    });
  app.get("/v1/web/config", (c) =>
    c.json({ standalone: true, mobileBundle: Boolean(mobileBundle) }),
  );
  // Public: the client code holds no credentials. Pairing still requires a dashboard ticket.
  app.get("/mobile", (c) => {
    if (!mobileBundle)
      return c.json({ error: "The mobile app was not included in this build." }, 404);
    const platform = c.req.header("expo-platform");
    if (platform !== "ios" && platform !== "android")
      return c.json({ error: "Open this address with Expo Go." }, 400);
    c.header("expo-protocol-version", "0");
    c.header("expo-sfv-version", "0");
    c.header("Cache-Control", "private, max-age=0");
    c.header("Content-Type", "application/expo+json");
    return c.body(JSON.stringify(mobileManifest(mobileBundle, platform, appOrigin(c.req.url))));
  });
  app.get("/mobile/files/:file", (c) => {
    const file = mobileBundle?.files[c.req.param("file")];
    if (!file) return c.json({ error: "Not found" }, 404);
    c.header("Content-Type", file.contentType);
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return c.body(Buffer.from(file.body, "base64"));
  });
  app.use("/v1/web/*", async (c, next) => {
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      c.req.header("Origin") !== new URL(c.req.url).origin
    )
      return c.json({ error: "Invalid origin" }, 403);
    const settings = config(),
      password = settings.password,
      issues = setupIssues(settings),
      configured = issues.length === 0;
    const passwordVersion = configured
      ? createHmac("sha256", settings.agentToken)
          .update("eve-start-password:" + password)
          .digest("hex")
      : "";
    const token = getCookie(c, "eve_start") || "";
    if (c.req.path === "/v1/web/login") {
      if (!configured)
        return c.json({ error: issues.join(" "), setupCommand: "./scripts/setup.sh" }, 503);
      const { db, identity } = await appStorage(),
        time = Date.now();
      const [limit] = await db.query<{ attempts: number }>(
        "INSERT INTO web_login_limits(key,attempts,expires) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN web_login_limits.expires<=$3 THEN 1 ELSE web_login_limits.attempts+1 END,expires=CASE WHEN web_login_limits.expires<=$3 THEN excluded.expires ELSE web_login_limits.expires END RETURNING attempts",
        [hash(c.req.header("x-real-ip") || "unknown").toString("hex"), time + 60000, time],
      );
      if (Number(limit.attempts) > 30)
        return c.json({ error: "Too many attempts. Try again in a minute." }, 429);
      const body = await c.req.json();
      if (
        typeof body.password !== "string" ||
        !timingSafeEqual(hash(body.password), hash(password))
      )
        return c.json({ error: "Incorrect password" }, 401);
      const token = crypto.randomUUID() + crypto.randomUUID();
      await db.query(
        "INSERT INTO web_sessions(hash,agent_id,password_version,expires) VALUES($1,$2,$3,$4)",
        [hash(token).toString("hex"), identity.agentId, passwordVersion, time + 2592000000],
      );
      const session = { token };
      setCookie(c, "eve_start", session.token, {
        httpOnly: true,
        secure: new URL(c.req.url).protocol === "https:",
        sameSite: "Lax",
        path: "/",
        maxAge: 2592000,
      });
      if (options.startBrowserOnLogin !== false)
        waitUntil(
          computer(new URL(c.req.url).origin, waitUntil)
            .then(async (app) => {
              const headers = { Authorization: "Bearer " + client().token };
              const state = (await (
                await app.request("/v1/agent/client/state", { headers })
              ).json()) as { cloudAvailable?: boolean };
              if (state.cloudAvailable)
                await app.request("/v1/agent/client/desktop", { method: "POST", headers });
            })
            .catch((error) => console.error("Browser startup:", error.message)),
        );
      return c.json({ ok: true });
    }
    let authenticated = false;
    if (configured && token) {
      const { db, identity } = await appStorage();
      authenticated =
        (
          await db.query(
            "SELECT hash FROM web_sessions WHERE hash=$1 AND agent_id=$2 AND password_version=$3 AND expires>$4",
            [hash(token).toString("hex"), identity.agentId, passwordVersion, Date.now()],
          )
        ).length > 0;
    }
    if (c.req.path === "/v1/web/session" && c.req.method === "GET")
      return c.json(
        configured
          ? { authenticated, mode: "password", configured }
          : {
              authenticated,
              mode: "password",
              configured,
              setupIssues: issues,
              setupCommand: "./scripts/setup.sh",
            },
      );
    if (!authenticated) return c.json({ error: "Enter the password to access this app." }, 401);
    await next();
  });
  app.delete("/v1/web/session", async (c) => {
    const { db, identity } = await appStorage();
    await db.query("DELETE FROM web_sessions WHERE hash=$1 AND agent_id=$2", [
      hash(getCookie(c, "eve_start") || "").toString("hex"),
      identity.agentId,
    ]);
    deleteCookie(c, "eve_start", { path: "/" });
    return c.json({ ok: true });
  });
  app.post("/v1/web/pairing", async (c) => {
    const settings = config();
    let link: URL,
      expoGo = false;
    try {
      const text = await c.req.text();
      const input = text ? JSON.parse(text) : {};
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw Error("Invalid pairing request.");
      if (input.expoGoUrl !== undefined && typeof input.expoGoUrl !== "string")
        throw Error("Invalid Expo Go server address.");
      const metro = input.expoGoUrl?.trim();
      expoGo = Boolean(metro || mobileBundle);
      link = metro
        ? expoGoPairingUrl(metro)
        : mobileBundle
          ? hostedExpoGoUrl(appOrigin(c.req.url))
          : new URL("eve-go://pair");
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof SyntaxError ? "Invalid pairing request." : (error as Error).message,
        },
        400,
      );
    }
    // A phone resolves localhost to itself, so a loopback QR can never connect.
    const agentHost = new URL(appOrigin(c.req.url)).hostname;
    if (["localhost", "127.0.0.1", "[::1]"].includes(agentHost) || agentHost.endsWith(".localhost"))
      return c.json(
        {
          error:
            "Phones cannot reach localhost. Open this dashboard on your deployment, or set appUrl to an HTTPS tunnel and open the dashboard there.",
        },
        409,
      );
    const { pairingToken, expiresIn } = await issuePairing();
    link.searchParams.set("app", appOrigin(c.req.url));
    link.searchParams.set("token", pairingToken);
    if (settings.appBypassToken) link.searchParams.set("bypass", settings.appBypassToken);
    return c.json({
      code: String(link),
      link: String(link),
      qr: await QRCode.toDataURL(String(link), { width: 320 }),
      standalone: true,
      expoGo,
      expiresIn,
      refreshAfterMs: 30000,
    });
  });
  for (const [path, method] of [
    ["state", "GET"],
    ["events", "GET"],
    ["messages", "POST"],
    ["stop", "POST"],
    ["desktop", "GET"],
    ["desktop", "POST"],
    ["desktop", "DELETE"],
    ["desktop/stream", "POST"],
    ["desktop/link", "POST"],
  ])
    app.on(method!, `/v1/web/${path}`, async (c) => {
      const app = await computer(new URL(c.req.url).origin, waitUntil, undefined, options.onStop);
      const response = await app.request("/v1/agent/client/" + path + new URL(c.req.url).search, {
        method: c.req.method,
        headers: { Authorization: "Bearer " + client().token, "Content-Type": "application/json" },
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.text(),
      });
      if (path === "messages" && response.ok) {
        const task = onMessage().catch((error) =>
          console.error("Message delivery:", error.message),
        );
        waitUntil(task);
      }
      return response;
    });
  app.onError((error, c) => {
    const limited = error.message.startsWith("429:");
    console.error("eve Start:", error.message);
    return c.json(
      {
        error: limited
          ? "Too many attempts. Try again in a minute."
          : "eve Start could not complete that request. " + SETUP_HELP,
      },
      limited ? 429 : 503,
    );
  });
  return app;
}
