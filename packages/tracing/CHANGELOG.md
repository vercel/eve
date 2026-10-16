# @vercel/agent-runs

## 0.0.1

### Patch Changes

- c1b079c: Publish framework-neutral tracing as `@vercel/agent-runs` with singular `createAgentRun` and `AgentRun` APIs; eve still bundles it without a new runtime dependency. Also fix a development-server build failure in npm-installed apps when generating source maps.
