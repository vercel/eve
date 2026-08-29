import { resolveUcpCheckoutHandoff } from "eve/commerce/ucp";
import { getCheckout } from "@/lib/ucp";

/**
 * Resolves what should happen next for one checkout session.
 *
 * The state is re-read from the merchant rather than taken from the
 * browser, so the handoff — and the embedded URL it may contain — is
 * derived from the merchant's own response.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  try {
    const handoff = resolveUcpCheckoutHandoff(await getCheckout(id), {
      // Delegations this app is prepared to handle natively. The merchant
      // intersects them with what it allows for the session.
      embedded: { delegate: ["fulfillment.address_change", "window.open"] },
    });
    return Response.json(handoff, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      { kind: "failed", messages: [], reason: "http_error", error: String(error) },
      { status: 502 },
    );
  }
}
