/**
 * Creates the agent's read-only Postgres roles from your environment variables.
 *
 * Usage:
 *   pnpm db:setup-sql --apply [--login eve_analyst]   Run the SQL with DATABASE_URL and print ANALYST_DATABASE_URL.
 *   pnpm --silent db:setup-sql                         Print the SQL to review or run yourself.
 *
 * When printing, SQL goes to stdout and instructions go to stderr, so the output can be redirected or piped.
 *
 * @packageDocumentation
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

import { Client } from "pg";
import { z } from "zod";

import { loginUrl, urlUser } from "#lib/analyst/derived-login";
import { resolveSchemaLists } from "#lib/analyst/schemas";
import { buildSetupSql } from "#scripts/setup-sql/build";

const fail = (message: string): never => {
  console.error(`db:setup-sql: ${message}`);
  process.exit(1);
};

const { values: args } = parseArgs({
  options: {
    apply: { default: false, type: "boolean" },
    login: { default: "eve_analyst", type: "string" },
  },
});

// The same lists the agent and the deploy step use; buildSetupSql rejects a shared schema that ANALYST_SCHEMAS leaves out.
const { schemas, sharedSchemas } = resolveSchemaLists(process.env);
const baseRole = process.env.ANALYST_DEFAULT_ROLE?.trim() || "analyst_readonly";
const ROLE_MAP_HELP =
  'ANALYST_ROLE_MAP must be JSON like {"slack:T123:U456":"analyst_finance"}.';
const parseRoleMap = (text: string): Record<string, string> => {
  try {
    return z.record(z.string(), z.string()).parse(JSON.parse(text));
  } catch {
    return fail(ROLE_MAP_HELP);
  }
};
const roleMap = parseRoleMap(process.env.ANALYST_ROLE_MAP?.trim() || "{}");
const suppliedPassword = process.env.ANALYST_LOGIN_PASSWORD?.trim();
const password = suppliedPassword || randomBytes(24).toString("base64url");

let sql = "";
try {
  sql = buildSetupSql({
    baseRole,
    login: args.login,
    password,
    schemas,
    setPassword: Boolean(suppliedPassword),
    sharedSchemas,
    teamRoles: Object.values(roleMap).filter(Boolean),
  });
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

/* The agent's connection string: the owner URL with the login role's credentials swapped in. */
const connectionFor = (
  owner: string | undefined,
  secret: string,
  keepUserSuffix = true
) => {
  if (owner) {
    try {
      return loginUrl(owner, args.login, secret, { keepUserSuffix });
    } catch {
      // Fall through to the placeholder form.
    }
  }
  return `postgres://${args.login}:${secret}@<host>/<database>?sslmode=require`;
};

/* The decoded user name in DATABASE_URL, or an empty string when it's unset or isn't a URL. */
const ownerUserName = (url: string | undefined): string => {
  try {
    return url ? urlUser(url) : "";
  } catch {
    return "";
  }
};

const owner = process.env.DATABASE_URL;
if (!args.apply) {
  console.log(sql);
  const ownerUser = ownerUserName(owner);
  // Print mode doesn't connect, so it can't tell a pooler's routing suffix from a dot in the real user name.
  const dotNote = ownerUser.includes(".")
    ? `
-- The user in DATABASE_URL, "${ownerUser}", contains a dot. The connection string above keeps the part after the
-- dot, because connection poolers that route by user name need it. If the dot is part of your real user name,
-- remove that part. \`--apply\` connects first and decides this for you.`
    : "";
  console.error(`
-- After running this SQL as a database owner, set ANALYST_DATABASE_URL (in .env.local, and in Vercel with \`vercel env add\`) to:
--   ${connectionFor(owner, password)}${dotNote}
-- If ${args.login} already existed, its password was left unchanged; set ANALYST_LOGIN_PASSWORD to reset it.
-- Then run \`pnpm db:doctor\`.`);
  process.exit(0);
}

const ownerUrl =
  owner ||
  fail(
    "Set DATABASE_URL to a connection that can create roles, such as the database owner. If it's set in your Vercel project, run `vercel env pull .env.local` first."
  );
/* Connects as the owner, or stops with one line instead of a stack trace. */
const connectOwner = async (connectionString: string): Promise<Client> => {
  let owned: Client | undefined;
  try {
    // The constructor parses the URL and reads certificate files, so it stays inside try.
    owned = new Client({ connectionString, connectionTimeoutMillis: 15_000 });
    await owned.connect();
    return owned;
  } catch (error) {
    await owned?.end().catch(() => null);
    return fail(
      `Couldn't connect with DATABASE_URL: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};
const client = await connectOwner(ownerUrl);
try {
  // A dot in the user name is either a connection pooler's routing suffix, which the login needs too,
  // or part of the real name. Postgres sees the full name only in the second case.
  const ownerUser = urlUser(ownerUrl);
  const session = await client.query("SELECT session_user AS name");
  const sessionUser = z
    .array(z.object({ name: z.string() }))
    .parse(session.rows)[0]?.name;
  const keepUserSuffix = sessionUser !== ownerUser;
  const existing = await client.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [args.login]
  );
  const loginExisted = z
    .array(z.object({ exists: z.boolean() }))
    .parse(existing.rows)[0]?.exists;
  // The script holds BEGIN and COMMIT, so a failure leaves no partial setup.
  await client.query(sql);
  const kept = loginExisted && !suppliedPassword;
  const restricted = schemas.filter(
    (schema) => !sharedSchemas.includes(schema)
  );
  console.log(
    `Created or updated the read-only roles. Every role can read ${sharedSchemas.join(", ")}.${
      restricted.length > 0
        ? ` Only roles you grant can read ${restricted.join(", ")}.`
        : ""
    }\n`
  );
  console.log(
    kept
      ? `${args.login} already existed, so its password is unchanged and ANALYST_DATABASE_URL can stay as it is. To reset it, set ANALYST_LOGIN_PASSWORD and run this again.`
      : `Set ANALYST_DATABASE_URL in .env.local, and in Vercel with \`vercel env add ANALYST_DATABASE_URL\`, to:\n\n  ${connectionFor(ownerUrl, password, keepUserSuffix)}`
  );
  console.log("\nThen run `pnpm db:doctor`.");
} finally {
  await client.end();
}
