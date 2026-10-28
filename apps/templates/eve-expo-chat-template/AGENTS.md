# eve Expo Chat Template

This is a standalone source project, excluded from the parent eve workspace. Run commands from this directory. Never add dependencies or imports pointing outside this template; its local `link:` packages must remain inside the copied directory.

- `pnpm install --frozen-lockfile`: install and build the local runtime.
- `pnpm typecheck`: build runtime and check app/mobile types.
- `pnpm test`: template-owned Node tests, including local SQLite API and mocked provisioning tests.
- `pnpm build`: export the Expo client, then build the runtime and eve deployment without cloud provisioning.
- `pnpm build:mobile`: export the Expo client that the deployment serves to Expo Go at `/start/mobile`. Tests for the hosted manifest skip until it runs.
- `./scripts/setup.sh`: **creates real Vercel resources and writes credentials**; run only with authorization for the intended linked project.

The private implementation packages are part of the template, not published services. The cloud browser in a Vercel Sandbox is the only browser; `pnpm dev` and the deployment share it. Preserve credential/profile identity on setup reruns. Do not commit secrets, generated runtime assets, build output, native projects, or node_modules. Update `pnpm-lock.yaml` when dependencies change.
