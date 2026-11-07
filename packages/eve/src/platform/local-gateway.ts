// A model on AI Gateway with this host's own credentials (a key in the environment, a Vercel login
// or OIDC token), for a model named by id. `local-gateway.web.ts` is the browser's twin; the
// package's `#platform/*` imports pick one by the `node` condition.
export { localGatewayDecisionModel, localGatewayModel } from "#internal/model-auth/transport.js";
