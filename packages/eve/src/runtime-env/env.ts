export function readEnv(name: string): string | undefined {
  return process.env[name];
}
