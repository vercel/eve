# Bell repository

Bell lives in [browserbase/bell-stack](https://github.com/browserbase/bell-stack).
One Next.js application serves the web interface and integrations. One Eve by Vercel agent owns the web
and Linq conversations; both channels use Bell's browser runtime directly.

```text
agent/                  Eve agent, tools, hooks, runtime, and channels
app/                    Bell web interface, integration APIs, and handoff routes
server/browser/         Browser sessions, Context metadata, credentials, and handoff
lib/browser/            Browser URL and CAPTCHA helpers
tests/browser/          Browser runtime regression tests and local fixtures
package.json            Application dependencies and commands
pnpm-lock.yaml          One dependency resolution tree
```

## Eve by Vercel

[Eve by Vercel](https://eve.dev/docs) runs Bell's agent, conversation state, tools, and channels.
Configure the model and session limits in [`agent/agent.ts`](../agent/agent.ts), behavior in
[`agent/instructions.md`](../agent/instructions.md), and tools in [`agent/tools/`](../agent/tools/).
The [web channel](../agent/channels/eve.ts) and [Linq channel](../agent/channels/linq.ts) use the
same agent with separate conversations. [Hooks](../agent/hooks/) maintain task state and browser
lifecycle; channel callbacks also handle terminal-session cleanup. Restart Bell after runtime edits.

## Integration implementation

| Integration | Implementation | Guide |
| --- | --- | --- |
| Browserbase + Stagehand | [Browser runtime](../agent/lib/browser-runtime.ts), [session management](../server/browser/browser-session.ts) | [Browser configuration](browser-runtime.md) |
| Eve by Vercel | [Agent](../agent/agent.ts), [channels](../agent/channels/), [hooks](../agent/hooks/) | [Eve in Bell](#eve-by-vercel) |
| Linq | [Channel and sender policy](../agent/channels/linq.ts) | [Messaging setup](linq.md) |
| Link by Stripe | [Eve extension and tools](../agent/extensions/link/), [authorization](../agent/lib/link-auth.ts), [server implementation](../server/link/) | [Sandbox and wallet setup](link.md) |
| 1Password | [Operator SDK/CLI access](../server/browser/vault/onepassword.ts), [personal authorization](../agent/lib/onepassword-auth.ts), [personal server implementation](../server/onepassword/) | [Operator credentials](browser-runtime.md#credentials-and-otp), [personal access status](onepassword.md) |
| Baselayer | [Agent tool](../agent/tools/merchant_access.ts), [credential minting](../server/baselayer.ts), [merchant verification](../server/verified-merchant.ts) | [Merchant access](baselayer.md) |

Personal 1Password Agentic Autofill is implemented but disabled by default pending hosted extension
support and live verification. Keep `ONEPASSWORD_ENABLED=false` and the extension ID unset as
described in its guide. Operator SDK/CLI access remains separate and is unavailable over Linq.

## Development

Use Node.js 24 and pnpm 10.33.4:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` and `pnpm build` compile the browser runtime directly. There is no separate browser
package, generated library, or second agent application. Run `pnpm check` for tests, TypeScript,
lint, and the Bell production build. Provider-backed tests remain opt-in; see
[provider regression checks](provider-tests.md). Keep generated `.eve`, `.next`, `.output`,
dependencies, environment files, and browser data untracked.

Browser tools must use `runBrowserOperation` and `runCancelableBrowserWork` from
`agent/lib/browser-runtime`. A server integration can call `browser.withHostedPage(signal, callback)`
under the same operation lock. Keep credentials and browser connection URLs out of tool results.
See [browser configuration and credential handling](browser-runtime.md).

## License and ownership

Bell maintains its browser implementation directly in this repository. There is no submodule
or separately maintained application to install. The root [MIT license](../LICENSE) preserves
the Browserbase copyright and license terms covering the browser source.

## Browser retirement

The HTTP and Linq channels release the hosted browser on terminal session events, including
when cleanup runs in a fresh worker. Eve 0.79.1 skips global stream hooks for completion outside
a turn, so cleanup uses channel callbacks. A failed release retains the browser ID and reaches
Eve's error logging; failed callbacks are not automatically retried. Starting a new conversation
resets the prior session and releases its browser. Browserbase sessions still have provider
lifetimes, so this does not guarantee an indefinitely running browser.

With Bell running locally and its provider credentials loaded, run the opt-in regression:

```sh
BELL_LIVE_RETIREMENT=1 pnpm test:retirement:live
```

The test opens example.com, checks browser reuse across two turns, resets the session, verifies
provider release, and deletes its temporary Context. It uses the configured model and Browserbase.
