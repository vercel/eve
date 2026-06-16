<div align="center">
  <a href="https://github.com/vercel/eve">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/eve.svg">
      <img alt="Eve logo" src=".github/assets/eve.svg" height="128">
    </picture>
  </a>
  <h1>Eve</h1>

<a href="https://vercel.com"><img alt="Vercel logo" src="https://img.shields.io/badge/MADE%20BY%20Vercel-000000.svg?style=for-the-badge&logo=Vercel&labelColor=000"></a>
<a href="https://www.npmjs.com/package/eve"><img alt="NPM version" src="https://img.shields.io/npm/v/eve.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/vercel/eve/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/eve.svg?style=for-the-badge&labelColor=000000"></a>
<a href="https://github.com/vercel/eve/discussions"><img alt="Join the community on GitHub" src="https://img.shields.io/badge/Join%20the%20community-blueviolet.svg?style=for-the-badge&logo=Github&labelColor=000000&logoWidth=20"></a>

</div>

Eve is a filesystem-first framework for building durable AI agents. Its conventions
keep collaboration predictable and streamlines agent implementation and operations.

### The filesystem is the interface

A typical Eve agent looks something like:

```text
my-agent/
└── agent/
    ├── agent.ts            # Optional: model and runtime config
    ├── instructions.md     # Required: the always-on system prompt
    ├── tools/              # Optional: typed functions the model can call
    │   └── get_weather.ts
    ├── skills/             # Optional: SKILL.md procedures loaded on demand
    │   └── plan_a_trip.md
    ├── channels/           # Optional: message channels — HTTP, Slack, Discord
    │   └── slack.ts
    └── schedules/          # Optional: recurring jobs (cron)
        └── weekly_recap.ts
```

Refer to the [documentation](https://beta.eve.dev/docs) to learn more about how Eve works.

## Quick Start

```bash
npx eve@latest init my-agent
```

This creates a new `my-agent` directory, installs its dependencies, initializes Git, and starts
the interactive terminal UI. Add `--channel-web-nextjs` to also scaffold the Web Chat application.

To add Eve to an existing project, pass a path:

```bash
cd myapp
npx eve@latest init .
```

> [!NOTE]
> `eve` is distributed with its full documentation, so agents can easily read it locally from `node_modules/eve/docs`.

### A minimal example

To build a simple weather bot, you'd create an `agent` directory with an `agent/instructions.md` file:

```md
You are a weather-focused assistant. Be concise and accurate, and write like a television weatherman.
```

Then give it a tool to reach a weather service, `agent/tools/get_weather.ts`:

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string().min(1) }),
  async execute({ city }) {
    return { city, condition: "Sunny", temperatureF: 72 };
  },
});
```

And, to choose the model, `agent/agent.ts`:

```ts
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-sonnet-4.6",
});
```

That's a working agent. Eve also gives you human-in-the-loop, subagents, schedules, and more
as it grows. Check out [guides](https://beta.eve.dev/docs/tutorial/first-agent) to follow
through examples.

## Community

The Eve community lives on [GitHub Discussions](https://github.com/vercel/eve/discussions),
where you can ask questions, share ideas, and show what you've built.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get the repo
running locally and land a change, and use
[issues](https://github.com/vercel/eve/issues) and
[discussions](https://github.com/vercel/eve/discussions) to collaborate. By
participating, you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please do not open public issues for security vulnerabilities. Instead, follow
[SECURITY.md](SECURITY.md) and report responsibly to
[responsible.disclosure@vercel.com](mailto:responsible.disclosure@vercel.com).

## Beta Terms

Eve is currently in beta and subject to the [Vercel beta terms](https://vercel.com/docs/release-phases/public-beta-agreement);
the framework, APIs, documentation, and behavior may change before general availability.
