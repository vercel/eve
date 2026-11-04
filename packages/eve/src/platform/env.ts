// The host's environment variables: Node's `process.env`. `env.web.ts` is the browser's twin,
// which has none (a bundler defines only `process.env.NODE_ENV`); the package's `#platform/*`
// imports pick one by the `node` condition.

/** The environment variable `name`, or `undefined` where it isn't set. */
export function readEnv(name: string): string | undefined {
  return process.env[name];
}
