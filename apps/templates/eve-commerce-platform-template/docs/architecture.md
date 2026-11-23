# Project layout

The setup app and eve agent share one package and deployment. Keep each entry
point close to its framework, and put shared product logic in `lib/`.

| Directory              | Owns                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `app/`                 | Next.js routes, server actions, and UI used by one route                               |
| `components/`          | UI reused across routes                                                                |
| `app/styles/`          | Color tokens, typography, and base Tailwind styles                                     |
| `agent/`               | eve channels, tools, instructions, hooks, and schedules                                |
| `lib/`                 | Domain operations and types for auth, commerce, shoppers, watches, and browser records |
| `lib/db/`              | The PostgreSQL client and Drizzle table definitions                                    |
| `migrations/postgres/` | SQL generated from `lib/db/schema.ts`                                                  |
| `evals/`               | Agent behavior and integration checks                                                  |

The setup UI uses ui-sdk React primitives and Tailwind. Read the component
references in `node_modules/@ui-sdk/react/docs/llms.txt` before changing a
control. Theme choices persist in the browser; edit `app/styles/tokens.css`
to change either palette.

## Where to make changes

- **Shopping:** `lib/commerce/` owns the Agentcard client and saved order
  details. `agent/tools/agentcard.ts` adapts the purchase flow to an eve turn.
- **Shopping watches:** `lib/watches/` reads product offers and stores watch state.
  The cron handler in `agent/schedules/shopping-watches.ts` checks due watches
  and sends one alert through Linq. It does not start agent turns or call checkout tools.
- **Messaging:** `lib/linq/` owns Linq API calls. The channel in `agent/channels/`
  authenticates incoming messages and delivers replies from eve.
- **Shopper data:** `lib/shoppers/` owns profile and model operations shared by
  the setup app and the agent. Use `lib/auth/next.ts` to authorize a Next.js
  request. Agent entry points resolve the shopper from eve's authenticated caller.
- **Browser fallback:** `agent/subagents/browser-agent/` reads anonymous public pages and uses an offline Kernel browser for static previews. It does not load merchant pages into that browser, sign in, or submit checkout. `lib/browser/` parses public responses and stores private image references.

Keep Next.js request handling out of modules the agent imports. Keep database
access out of client components. The setup app and the agent call domain
operations directly; they do not call each other through an internal API.
