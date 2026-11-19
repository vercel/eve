# Commerce Agent Platform Template

A multi-tenant commerce platform built with [eve](https://eve.dev), deployable to your own Vercel project. A single deployment serves multiple shoppers on a shared iMessage line. Each shopper signs in with a verified phone number and has a separate profile, agent preferences, and private conversations. This template is standalone; copy this directory out of the eve repository to run it locally.

Text evey what you need. It finds products, builds a cart with [Agentcard](https://opencommerce.sh), and texts you an approval link with the final total. You approve before Agentcard places the order; evey never handles your card number. If [Kernel](https://kernel.sh) is configured, you can explicitly ask evey to shop in a browser.

[![Deploy with Vercel](https://vercel.com/button)][deploy-with-vercel]

## Quick start

1. Get Agentcard credentials. To try checkout without real purchases, run `npx agent-cards credentials --mode sandbox`.
2. Click **Deploy with Vercel**, select a **Pro** team (shopping watches use a five-minute cron), and enter `AGENTCARD_CLIENT_ID` and `AGENTCARD_CLIENT_SECRET`. The deploy flow connects your Linq iMessage line, Kernel, Neon, and private Vercel Blob.
3. Open your deployment and sign in with your phone number. If prompted, text the number shown and then request your sign-in code again. Once signed in, send the line a direct message: “Find me two packs of AA batteries.”
4. To receive purchase updates, add `https://<your-deployment>/agentcard/webhooks` in the Agentcard dashboard. Set `AGENTCARD_WEBHOOK_SECRET` in Vercel to the endpoint's signing secret and redeploy.

The app reads the line’s number from Linq. Set `LINQ_PHONE_NUMBER` only to override it. Shopping happens in iMessage. See the [deployment guide](docs/deployment.md) for preview isolation and the before-sharing checklist.

Text a public product link and ask for a USD price target or an in-stock alert. A watch checks about hourly for 30 days and sends one alert, then stops. Watches never place orders.

## Run locally

Requires Node.js 24, pnpm, and Docker.

```sh
cp .env.example .env.local  # set AI_GATEWAY_API_KEY
pnpm install
EVEY_LOCAL_PHONE_AUTH=1 pnpm dev
```

Open `http://127.0.0.1:3000`. The development server binds to loopback; the explicit `EVEY_LOCAL_PHONE_AUTH=1` opt-in enables local sign-in with no text message. Do not expose this development server to a network or tunnel. To exercise real iMessage verification, omit the bypass and use a deployment with a Linq connector.

Run `pnpm dev:agent` in another terminal to chat without iMessage. Set `KERNEL_API_KEY` only if you want to enable the browser fallback. See [`.env.example`](.env.example) for optional integrations and [Database setup](migrations/README.md) for preview databases.

## Make it yours

- Edit [agent instructions](agent/instructions/content/) to change behavior and voice.
- Review the [browser worker's rules](agent/subagents/browser-agent/instructions.md) before letting others use it. Browser checkout relies on those instructions, not Agentcard's approval page.
- Read the [project layout](docs/architecture.md) before changing shared code.
- Run `pnpm typecheck`, `pnpm test:watches`, and `pnpm eval:list` to check types, test watch parsing, and discover agent evals.

[deploy-with-vercel]: https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-commerce-platform-template&project-name=eve-commerce-platform&repository-name=eve-commerce-platform&env=AGENTCARD_CLIENT_ID%2CAGENTCARD_CLIENT_SECRET&envDescription=Agentcard%20credentials.%20For%20a%20sandbox%2C%20run%20npx%20agent-cards%20credentials%20--mode%20sandbox.&envLink=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-commerce-platform-template%23quick-start&connect=%5B%7B%22type%22%3A%22linq%22%2C%22env%22%3A%22LINQ_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinq%22%7D%5D&stores=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22other%22%2C%22productSlug%22%3A%22kernel%22%2C%22integrationSlug%22%3A%22kernel%22%7D%2C%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D
