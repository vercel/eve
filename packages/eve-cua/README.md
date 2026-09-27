# eve/extensions/cua

`eve/extensions/cua` is an eve extension for computer use. It contributes the `computer_use` tool, which drives a Linux desktop inside the sandbox, plus the helpers that install and start that desktop.

It ships inside the `eve` package. This private `@eve/cua` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/cua/extension` and publishes it with these entry points:

- `eve/extensions/cua`: the extension
- `eve/extensions/cua/sandbox`: `installComputerUse`, `startComputerUse`, and `COMPUTER_USE_REVALIDATION_KEY`
- `eve/extensions/cua/tools`: `computer_use`

## Mount

The extension has no config:

```ts
// agent/extensions/cua.ts
export { default } from "eve/extensions/cua";
```

Mount it only for agents whose sandbox runs the desktop. The tool schema is large, so agents that never use a desktop should leave it out.

## Sandbox bootstrap

Install the desktop and driver in the environment's `prepare` callback, then start them after `open()` in `defineSandbox()`. Computer use requires an apt-based Linux image with root or passwordless sudo; it cannot run on the `just-bash` provider.

```ts
// agent/sandbox.ts
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { installComputerUse, startComputerUse } from "eve/extensions/cua/sandbox";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installComputerUse(sandbox);
  },
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await startComputerUse(sandbox);
  return sandbox;
});
```

Mounting the extension exposes `computer_use` but does not install or start its driver. The prepared artifact captures files, not running processes; the `defineSandbox()` selector starts the driver once for each new durable sandbox. If the driver exits or the provider resumes only filesystem state, call `startComputerUse` again before using the tool; resuming a sandbox does not rerun the selector. Stop recordings with `record_stop` to finalize the MP4 at the returned sandbox path. A five-minute watchdog also finalizes forgotten recordings, and the driver attempts finalization on `SIGINT` or `SIGTERM`; abrupt VM termination cannot guarantee a finalized MP4.

## Develop in this workspace

Rebuild eve after editing `extension/`:

```sh
pnpm --filter eve build
pnpm --filter @eve/cua typecheck
pnpm --filter @eve/cua test:scenario
pnpm exec oxlint packages/eve-cua
pnpm exec oxfmt --check packages/eve-cua
```
