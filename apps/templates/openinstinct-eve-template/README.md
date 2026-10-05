# OpenInstinct for eve

An eve starter for an iMessage personal assistant. It adapts the agent configuration and Linq channel from [Merit Systems' OpenInstinct](https://github.com/Merit-Systems/OpenInstinct) into a small, standalone eve project.

The upstream app also includes a web application, account and vault systems, memory, scheduling, browser workers, and other integrations. This template is a starting point for the eve agent, not a port of those app services or security controls. Add and review each capability before using it with real accounts or secrets.

## Deploy with Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Fopeninstinct-eve-template&connect=%5B%7B%22type%22%3A%22linq%22%2C%22env%22%3A%22LINQ_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinq%22%7D%5D&project-name=openinstinct&repository-name=openinstinct)

The Vercel flow connects a Linq connector and configures the `/eve/v1/linq` trigger. Configure a model provider for eve in the project as well.

## Develop locally

Requirements: Node.js 24+ and pnpm.

```bash
pnpm install
vercel link
vercel env pull
pnpm dev
```

Edit `agent/agent.ts` and `agent/instructions.md` to configure the agent. The Linq channel is in `agent/channels/linq.ts`.

For local Linq testing, create or attach a Linq connector, set `LINQ_CONNECTOR` to its connector UID, and configure its trigger path as `/eve/v1/linq`. See the [Vercel Connect documentation](https://vercel.com/docs/connect) and the [eve Linq channel guide](https://eve.dev/docs/channels/linq).

## Scope and security

This starter does not include OpenInstinct's authenticated web application, encrypted vault, user and workspace authorization, secure browser autofill, payment approval flow, or browser worker. The sample instructions provide only baseline model guidance; they are not a substitute for server-side authorization and secret-handling controls. Do not use this template to access personal accounts or perform purchases until you have implemented and reviewed those controls.
