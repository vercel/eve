/**
 * Makes the proxy's sandbox port reachable from the person's browser.
 * Implement one for a sandbox provider other than Vercel Sandbox.
 */
export interface PortExposer {
  /** Exposes `port` and returns its public HTTPS URL. Should keep the sandbox alive for `ttlMs`. */
  open(sandbox: object, port: number, ttlMs: number): Promise<{ readonly url: string }>;
  /** Unexposes `port`. */
  close(sandbox: object, port: number): Promise<void>;
}

/** The slice of a Vercel Sandbox that exposing a port needs. */
export interface VercelPortSandbox {
  readonly routes: readonly { readonly port: number }[];
  update(params: { ports: number[] }): Promise<void>;
  domain(port: number): string;
  extendTimeout(durationMs: number): Promise<void>;
}

export type LookupVercelSandbox = (name: string) => Promise<VercelPortSandbox>;

async function lookupVercelSandbox(name: string): Promise<VercelPortSandbox> {
  const { Sandbox } = await import("@vercel/sandbox");
  return Sandbox.get({ name, resume: false });
}

function sandboxName(sandbox: object): string {
  const name = (sandbox as { readonly name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      "this sandbox isn't a Vercel Sandbox; pass an `expose` implementation to defineTakeover",
    );
  }
  return name;
}

/**
 * Exposes the port through Vercel Sandbox port routes. A route is public, so
 * the proxy's token check is the only gate; the port stays exposed only while
 * the takeover is open.
 */
export function vercelSandboxPorts(
  options: { readonly lookup?: LookupVercelSandbox } = {},
): PortExposer {
  const lookup = options.lookup ?? lookupVercelSandbox;
  return {
    async open(sandbox, port, ttlMs) {
      const vercel = await lookup(sandboxName(sandbox));
      const ports = vercel.routes.map((route) => route.port);
      if (!ports.includes(port)) await vercel.update({ ports: [...ports, port] });
      // Best effort: keep the VM, and the screen it runs, alive for the takeover.
      await vercel.extendTimeout(ttlMs).catch(() => undefined);
      return { url: vercel.domain(port) };
    },
    async close(sandbox, port) {
      const vercel = await lookup(sandboxName(sandbox));
      const ports = vercel.routes.map((route) => route.port);
      if (ports.includes(port)) await vercel.update({ ports: ports.filter((p) => p !== port) });
    },
  };
}
