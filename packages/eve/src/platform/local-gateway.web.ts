import type {
  localGatewayDecisionModel as NodeDecisionModel,
  localGatewayModel as NodeModel,
} from "./local-gateway.js";

// A browser has no host credentials, so a model named by id gets none from here: a page passes a
// model with its own provider, such as `createGateway({ apiKey })`. `local-gateway.ts` is the Node
// twin.

export const localGatewayModel: typeof NodeModel = () => undefined;
export const localGatewayDecisionModel: typeof NodeDecisionModel = () => undefined;
