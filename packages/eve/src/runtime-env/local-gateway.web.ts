import type {
  localGatewayDecisionModel as NodeDecisionModel,
  localGatewayModel as NodeModel,
} from "./local-gateway.js";

export const localGatewayModel: typeof NodeModel = () => undefined;
export const localGatewayDecisionModel: typeof NodeDecisionModel = () => undefined;
