import { z } from "zod";
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  }, "Use an origin without a path or credentials");
export const startOptions = z.object({
  redirectHomepage: z.boolean().default(true),
  password: z
    .string()
    .refine(
      (value) => value === "" || value.length >= 8,
      "Use a password with at least eight characters",
    )
    .optional(),
  databaseUrl: z.string().optional(),
  name: z.string().min(1).max(100).optional(),
  appUrl: origin.optional(),
  protection: z.object({ appBypassToken: z.string().min(16).optional() }).optional(),
});
export type StartOptions = z.input<typeof startOptions>;
export const INIT_COMMAND = "./scripts/setup.sh";
export const SETUP_HELP =
  "Run " +
  INIT_COMMAND +
  ", then redeploy. Setup installs EVE_START_AGENT_TOKEN and any required EVE_START_APP_BYPASS_TOKEN.";
export function resolveOptions(options: StartOptions = {}, env: NodeJS.ProcessEnv = process.env) {
  return {
    redirectHomepage: options.redirectHomepage ?? true,
    password: options.password ?? env.EVE_APP_PASSWORD ?? "",
    databaseUrl: options.databaseUrl ?? env.DATABASE_URL ?? "",
    name: options.name ?? env.EVE_START_NAME,
    appUrl: options.appUrl ?? env.EVE_START_APP_URL,
    agentToken: env.EVE_START_AGENT_TOKEN ?? "",
    agentId: env.EVE_START_AGENT_ID,
    appBypassToken:
      options.protection?.appBypassToken ??
      env.EVE_START_APP_BYPASS_TOKEN ??
      env.VERCEL_AUTOMATION_BYPASS_SECRET,
    sqlitePath: env.EVE_START_COMPUTER_DB_PATH ?? ".eve/computer.sqlite",
  };
}
export function setupIssues(config: ReturnType<typeof resolveOptions>) {
  const issues: string[] = [];
  if (config.password.length < 8)
    issues.push(
      "Configure start({ password }) with at least eight characters. Setup generates a password in .env.local when needed.",
    );
  if (config.agentToken.length < 32)
    issues.push("A strong EVE_START_AGENT_TOKEN credential is required. " + SETUP_HELP);
  return issues;
}
