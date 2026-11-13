import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveModeValue } from "@agent/lib/mode";
import { applicationOrigin } from "@shared/environment/origin";
import {
  createVaultSetupUrl,
  vaultSetupRequestSchema,
} from "@shared/vault/schema";

export const requestVaultImport = defineTool({
  description:
    "Create a direct self-hosted link for bulk-importing login credentials from a Chrome or Google Password Manager CSV into the encrypted vault. Use this when the user wants to import or migrate multiple browser passwords. Never ask them to send the CSV or any password in chat.",
  inputSchema: z.object({}),
  execute() {
    return {
      message:
        "Open this page in your Local Vault Assistant deployment. It explains how to export from Chrome and opens the secure importer directly.",
      url: new URL("/vault?import=chrome", applicationOrigin()).toString(),
    };
  },
});

export const requestVaultSetup = defineTool({
  description:
    "Create a safe link for adding one supported item to the self-hosted vault. Supported kinds are login (email, phone, or username with a password or one-time-code method), payment (card details), address (structured delivery or billing address), and contact (name, email, and phone). A login setup requires a descriptive label, identifierType, and the exact current website origin; the user enters the actual identifier and secret on the vault page. Other kinds accept only kind and an optional label. Never put an email address, phone number, username, or secret in this setup request. Use ordinary non-secret contact details directly when the user supplied them in chat.",
  inputSchema: vaultSetupRequestSchema,
  execute(request) {
    return {
      message:
        "Open this page in your Local Vault Assistant deployment and complete the form. Do not send the secret in chat.",
      url: createVaultSetupUrl(applicationOrigin(), request),
    };
  },
});

export default defineDynamic((context) =>
  resolveModeValue(context, {
    interactive: {
      request_vault_import: requestVaultImport,
      request_vault_setup: requestVaultSetup,
    },
    "scheduled-report": { request_vault_setup: requestVaultSetup },
  })
);
