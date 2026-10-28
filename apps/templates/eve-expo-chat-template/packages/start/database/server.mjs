import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";

const mode = process.argv[2];
function readConfig(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!/^[A-Za-z0-9_-]{43}$/.test(value.secret)) throw Error();
    return value;
  } catch {
    throw Error("Invalid database service configuration");
  }
}
const config = readConfig(process.argv[3]);
if (mode === "--same-key") {
  const other = readConfig(process.argv[4]);
  process.exit(config.secret === other.secret ? 0 : 1);
}
if (mode === "--probe") {
  try {
    const response = await fetch("http://127.0.0.1:3001/health", {
      headers: { Authorization: `Bearer ${config.secret}` },
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    process.exit(response.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
if (mode !== "--serve" || !/^[A-Za-z0-9_-]{43}$/.test(config.secret))
  throw Error("Invalid database service configuration");
process.umask(0o077);
const { DatabaseSync } = await import("node:sqlite");
const database = new DatabaseSync(config.path || "/data/eve-start/storage.sqlite");
database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
const hash = (value) => createHash("sha256").update(value).digest();
const expected = hash(`Bearer ${config.secret}`);
function json(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
const server = createServer(async (request, response) => {
  if (!timingSafeEqual(hash(request.headers.authorization || ""), expected)) {
    request.resume();
    json(response, 401, { error: "Unauthorized" });
    return;
  }
  try {
    if (request.method === "GET" && request.url === "/health") {
      database.prepare("SELECT 1").get();
      json(response, 200, { ok: true, engine: "sqlite", version: 1 });
      return;
    }
    if (request.method !== "POST" || request.url !== "/query") {
      request.resume();
      json(response, 404, { error: "Not found" });
      return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > 1024 * 1024) {
        json(response, 413, { error: "Query is too large" });
        return;
      }
    }
    const { query, args = [] } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      typeof query !== "string" ||
      query.length > 100000 ||
      !Array.isArray(args) ||
      args.length > 1000 ||
      args.some((value) => value !== null && typeof value !== "string" && typeof value !== "number")
    ) {
      json(response, 400, { error: "Invalid query" });
      return;
    }
    const ordered = [];
    const statement = query.replace(/\$(\d+)/g, (_, n) => {
      ordered.push(args[Number(n) - 1]);
      return "?";
    });
    const rows = database.prepare(statement).all(...ordered);
    json(response, 200, { rows });
  } catch (error) {
    json(response, error instanceof SyntaxError ? 400 : 500, {
      error: error.message,
      code: error.code,
    });
  }
});
server.listen(config.port ?? 3001, config.host || "0.0.0.0", () => {
  process.send?.({ port: server.address().port });
});
function stop() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
