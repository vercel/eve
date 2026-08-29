/**
 * Universal Commerce Protocol support for the buying side of a
 * transaction: connecting an agent to a merchant's UCP shopping service,
 * and deciding what happens after each checkout response.
 *
 * For the selling side — publishing your own `/.well-known/ucp` profile
 * and serving commerce endpoints — see the UCP protocol guide.
 */

export {
  defineUcpConnection,
  type UcpConnectionDefinition,
} from "#public/commerce/ucp/connection.js";
export {
  deriveUcpRequestUuid,
  ucpAgentHeaderValue,
  ucpShoppingRestSpecUrl,
  UCP_VERSION,
  type UcpAgentMetadata,
} from "#public/commerce/ucp/protocol.js";
export {
  createUcpSigner,
  ucpContentDigest,
  ucpSignatureBase,
  ucpSignatureComponents,
  type UcpSignatureAlgorithm,
  type UcpSignatureHeaders,
  type UcpSignatureRequest,
  type UcpSigner,
  type UcpSigningKey,
} from "#public/commerce/ucp/signing.js";
export {
  parseUcpCheckoutResponse,
  type ParsedUcpCheckoutResponse,
  type UcpCheckout,
  type UcpCheckoutStatus,
  type UcpErrorSeverity,
  type UcpMessage,
  type UcpOrder,
  type UcpServiceBinding,
} from "#public/commerce/ucp/checkout.js";
export {
  resolveUcpCheckoutHandoff,
  type UcpCanceledHandoff,
  type UcpCheckoutHandoff,
  type UcpCheckoutHandoffOptions,
  type UcpCompletedHandoff,
  type UcpContinueUrlHandoff,
  type UcpConversationalHandoff,
  type UcpConversationalNextStep,
  type UcpEmbeddedCheckoutOptions,
  type UcpEmbeddedHandoff,
  type UcpFailedHandoff,
  type UcpHandoffFailureReason,
  type UcpHandoffReason,
} from "#public/commerce/ucp/handoff.js";
