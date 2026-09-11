This is a Slack agent template for [eve](https://eve.dev).

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?connect=%5B%7B%22type%22%3A%22slack%22%2C%22env%22%3A%22SLACK_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Fslack%22%7D%5D&demo-description=An%20eve%20template%20for%20Slack%20agents%20with%20webhook%20handling%2C%20Vercel%20Connect%2C%20a%20starter%20agent%2C%20and%20an%20example%20tool%20ready%20to%20deploy%20on%20Vercel.&demo-image=https%3A%2F%2Fimages.ctfassets.net%2Fe5382hct74si%2F2mBY0MIfBcFytW99mnvinL%2Ffc3917c584ab1389af305788b8050f5d%2Fimage__1_.png&demo-title=eve%20Slack%20Agent&demo-url=https%3A%2F%2Fvercel.com%2Fkb%2Fguide%2Feve-slack-agent-starter&project-name=eve%20Slack%20Agent&repository-name=eve-slack-agent&repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Feve-slack-agent-template)

## Getting Started

First, link the project and pull environment variables:

```bash
vercel link
vercel env pull
```

Then, run the development server:

```bash
pnpm dev
```

You can start editing the agent by modifying `agent/agent.ts`. Its behavior is defined in `agent/instructions.md`, and tools live in `agent/tools/`. The agent auto-updates as you edit the files.

This project uses the Eve framework's bundled guides — see `node_modules/eve/dist/docs/public/` after installing dependencies.

## Learn More

To learn more about eve, take a look at the following resources:

- [eve documentation](https://eve.dev/docs) - learn about eve features and API.
- [Vercel Connect](https://vercel.com/docs) - manages the Slack channel's credentials in this template.

You can check out [the eve GitHub repository](https://github.com/vercel/eve) - your feedback and contributions are welcome!

<img width="1552" height="1013" alt="Image Edit Request" src="https://github.com/user-attachments/assets/115c947d-1b7d-4464-8d57-91f2dd8758f0" />
