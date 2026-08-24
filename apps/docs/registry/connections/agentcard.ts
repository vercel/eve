import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";

const APPROVAL_GATED = ["create_card", "get_card_details", "remove_added_card"];

export default defineMcpClientConnection({
  url: "https://mcp.agentcard.sh/mcp",
  description:
    "Agentcard: the agent's wallet. Shop and check out at real merchants (DoorDash, Good Eggs, flights) with the conversational `buy` tool (thread conversation_id on follow-ups), issue a single-use virtual card to pay at any checkout, let the user add their own card, and manage the cash that funds it: balance, top-ups, transactions, KYC, human support.",
  auth: connect(process.env.AGENTCARD_CONNECTOR ?? "agentcard"),
  tools: {
    allow: [
      // Shopping
      "buy",
      "get_instructions",
      "buy_list_merchants",
      "buy_connect",
      "buy_connect_status",
      "buy_unlink_merchant",
      "manage_subscription",
      // Cash
      "get_balance",
      "add_funds",
      "list_transactions",
      // Issued cards: pay at any checkout
      "create_card",
      "get_card_details",
      "get_card_balance",
      "list_cards",
      "close_card",
      // The user's own card, no prefunding or KYC
      "add_card",
      "list_added_cards",
      "remove_added_card",
      "get_wallet_link",
      // Account
      "whoami",
      "start_kyc",
      "get_kyc_status",
      "submit_kyc_document",
      "check_kyc_document",
      "submit_kyc_fields",
      // Human support
      "start_support_chat",
      "send_support_message",
      "read_support_chat",
    ],
  },
  approval: ({ toolName }) =>
    APPROVAL_GATED.includes(toolName.split("__").pop() ?? toolName)
      ? "user-approval"
      : "not-applicable",
});
