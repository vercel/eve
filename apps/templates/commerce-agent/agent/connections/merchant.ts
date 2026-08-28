import { defineUcpConnection, type UcpConnectionDefinition } from "eve/commerce/ucp";
import { agentMetadata, merchantEndpoint, signingKey } from "@/lib/ucp";

const definition: UcpConnectionDefinition = {
  agent: agentMetadata(),
  auth: {
    getToken: async () => ({ token: process.env.UCP_MERCHANT_TOKEN ?? "" }),
  },
  description:
    "The merchant's UCP shopping service: search the catalog and drive a checkout session.",
  endpoint: merchantEndpoint(),
  // Checkout and catalog are what this template drives. Widen the list
  // once the merchant's profile advertises other capabilities you want.
  operations: {
    allow: [
      "cancel_checkout",
      "complete_checkout",
      "create_checkout",
      "get_checkout",
      "lookup_catalog",
      "search_catalog",
      "update_checkout",
    ],
  },
};

const signing = signingKey();

export default defineUcpConnection(signing === undefined ? definition : { ...definition, signing });
