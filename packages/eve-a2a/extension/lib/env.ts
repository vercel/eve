export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`A2A requires environment variable ${name}`);
  return value;
}
