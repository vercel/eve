/**
 * Creates the demo `analytics` schema in any Postgres database.
 *
 * Usage: pnpm db:seed [--schema analytics] [--url postgres://...] [--force]
 *
 * @packageDocumentation
 */
import { parseArgs } from "node:util";

import { Client } from "pg";

import { isSafeIdentifier } from "#lib/analyst/identifiers";
import {
  inspectDemoSchema,
  loadDemoData,
  replacementBlocker,
  summarizeDemoData,
} from "#scripts/seed/load";
import { DEMO_SCHEMA_COMMENT } from "#scripts/seed/schema";

/** How long the seed waits for Postgres to accept a connection. */
const CONNECT_TIMEOUT_MS = 15_000;

const fail = (message: string): never => {
  console.error(`db:seed: ${message}`);
  process.exit(1);
};

const { values: args } = parseArgs({
  options: {
    force: { default: false, type: "boolean" },
    schema: { default: "analytics", type: "string" },
    url: { type: "string" },
  },
});

const { schema } = args;
if (!isSafeIdentifier(schema)) {
  fail(
    `"${schema}" isn't a safe schema name. Use lowercase letters, digits, and underscores, and avoid public and pg_ names.`
  );
}
const url = args.url ?? process.env.DATABASE_URL;
if (!url) {
  fail(
    "Set DATABASE_URL (or pass --url) to a connection string for a role that can create schemas, such as the database owner. If it's set in your Vercel project, run `vercel env pull .env.local` first."
  );
}
if (url === process.env.ANALYST_DATABASE_URL) {
  fail(
    "DATABASE_URL matches ANALYST_DATABASE_URL. Seed with the owner connection, not the agent's read-only login."
  );
}

/* The error's message, without a trailing period, so it reads as one sentence after a prefix. */
const reason = (error: Error | string): string =>
  (error instanceof Error ? error.message : error).replace(/\.+$/u, "");

/* Loads the demo data and prints the expected answers. Returns a reason to stop instead of throwing. */
const seed = async (client: Client): Promise<string | null> => {
  await client.connect();
  const state = await inspectDemoSchema(client, schema);
  const blocker = replacementBlocker(schema, state);
  if (blocker && !args.force) {
    return `${blocker} Pass --force to drop and replace it, or choose another --schema.`;
  }
  const grantees = state?.grantees ?? [];
  const { data } = await loadDemoData(client, schema, grantees, {
    force: args.force,
  });

  const timezone = process.env.ANALYST_TIMEZONE?.trim() || "UTC";
  const summary = await summarizeDemoData(client, schema, timezone);
  console.log(`\nSeeded schema "${schema}" (${DEMO_SCHEMA_COMMENT})`);
  console.log(
    `  ${data.customers.length} customers, ${data.subscriptions.length} subscriptions, ${data.invoices.length} invoices, ${data.webSessions.length} web sessions`
  );
  console.log(
    `  MRR at the end of the month starting ${summary.monthStart}: $${summary.mrr} (time zone ${timezone})`
  );
  console.log(
    `  Top sources, last 10 days: ${summary.sources.map((row) => `${row.source} ${row.sessions}`).join(", ")}`
  );
  if (grantees.length > 0) {
    console.log(`  Restored read access for: ${grantees.join(", ")}`);
  } else {
    console.log(
      "\nNext: create the read-only roles with `pnpm db:setup-sql --apply`."
    );
  }
  console.log(
    '\nTry asking: "What was our MRR last month?", "What was our biggest traffic source in the last 10 days?", "How did logo churn trend over the last 6 months?"'
  );
  return null;
};

let client: Client | undefined;
let problem: string | null = null;
try {
  // The constructor parses the URL and reads certificate files, so it stays inside try.
  client = new Client({
    connectionString: url,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  problem = await seed(client);
} catch (error) {
  problem = `${reason(error instanceof Error ? error : String(error))}.`;
} finally {
  await client?.end().catch(() => null);
}
if (problem) {
  fail(problem);
}
