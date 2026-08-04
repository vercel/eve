function EveLogo() {
  return (
    <svg
      aria-label="eve"
      className="h-auto w-14"
      fill="none"
      role="img"
      viewBox="0 0 169 53"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M169 8.47h-51.39L81.73 53H70.36L113 0H169zM169 44.51v8.47h-45.87V44.5zM45.87 52.98H0V44.5h45.87zM38.66 30.55H0v-8.47h38.66z"
        fill="currentColor"
      />
      <path d="M169 30.55h-38.66v-8.47H169zM75.52 8.47H0V0h75.52z" fill="currentColor" />
    </svg>
  );
}

const REQUIRED_VARIABLES = [
  {
    description: "The password used to enter web chat.",
    name: "EVE_ACCESS_PASSWORD",
  },
  {
    description: "A random string of 32 characters or more that signs session cookies.",
    name: "BETTER_AUTH_SECRET",
  },
] as const;

export function AuthSetup() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-10 text-foreground">
      <div className="flex w-full max-w-md flex-col gap-6">
        <div className="text-foreground/10">
          <EveLogo />
        </div>

        <div className="space-y-3">
          <h1 className="font-medium text-xl tracking-tight">Missing environment variables</h1>
          <p className="text-muted-foreground text-sm">
            In production, web chat is protected with a password by default. Add both variables
            below, then redeploy.
          </p>
        </div>

        <dl className="space-y-4 text-sm">
          {REQUIRED_VARIABLES.map((variable) => (
            <div className="space-y-1.5" key={variable.name}>
              <dt>
                <code className="inline-flex rounded-md bg-muted px-2 py-1 font-mono font-medium text-xs">
                  {variable.name}
                </code>
              </dt>
              <dd className="text-muted-foreground">{variable.description}</dd>
            </div>
          ))}
        </dl>

        <div className="border-t pt-4 text-xs">
          <p className="text-muted-foreground/70">
            Need per-user sign-in or an existing auth provider? Replace the default Better Auth
            setup in <code className="font-mono">lib/auth.ts</code>.
          </p>
        </div>
      </div>
    </main>
  );
}
