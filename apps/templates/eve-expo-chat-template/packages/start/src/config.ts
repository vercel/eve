import extension from "../extension/extension.ts";
import { resolveOptions } from "./options.ts";
export { setupIssues, SETUP_HELP, INIT_COMMAND } from "./options.ts";
export function config() {
  return resolveOptions(extension.config);
}
export function appOrigin(incoming?: string) {
  const configured = config().appUrl;
  if (configured) return configured;
  if (incoming) return new URL(incoming).origin;
  const domain =
    process.env.VERCEL_ENV === "production"
      ? process.env.VERCEL_PROJECT_PRODUCTION_URL
      : process.env.VERCEL_URL;
  return domain ? "https://" + domain : "http://localhost:2000";
}
