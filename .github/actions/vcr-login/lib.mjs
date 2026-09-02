export const registry = "vcr.vercel.com";
export const vercelApi = process.env.VERCEL_API_ORIGIN || "https://api.vercel.com";
export const vcrAppId = "cl_inrfNy8noLlhRrGbPEm0z47woXNcJVZ0";

export function command(name, value) {
  const escaped = String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  process.stdout.write(`::${name}::${escaped}\n`);
}
