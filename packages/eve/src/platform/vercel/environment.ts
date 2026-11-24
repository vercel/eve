export function isVercelEnvironment(): boolean {
  return Boolean(process.env.VERCEL);
}
