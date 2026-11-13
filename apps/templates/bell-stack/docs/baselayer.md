# Baselayer verified identity

Baselayer lets a site confirm a verified person is behind the agent. The credential shares only
what the site requires, never more. Bell’s `merchant_access` tool gets a short-lived Baselayer KYA
credential for the operator and presents it to a compatible merchant inside the conversation’s
existing Browserbase browser. The same tool is available from the web interface and a Linq chat.
Each conversation keeps its own browser. See the [Baselayer docs](https://docs.baselayer.com) for
the full protocol.

```text
Bell -> merchant KYA profile -> Baselayer mint -> merchant nonce
     -> signed proof on one browser GET -> merchant verification -> access result
```

## Configure the sandbox

Set these values in Bell's ignored `.env.local`:

```dotenv
BASELAYER_API_KEY=<sandbox API key>
BASELAYER_PRINCIPAL_REF=<current verified principal from the same organization>
BASELAYER_ALLOWED_ORIGINS=https://bell-stack-demo-site.vercel.app
BELL_DEMO_URL=https://bell-stack-demo-site.vercel.app/protected
STAGEHAND_BROWSER=browserbase
```

Keep the OpenAI and Browserbase credentials already used by Bell. For the phone demo, also keep
the Linq configuration from [the messaging guide](linq.md). Restart Bell and start a new
conversation after changing browser logging settings. The browser runtime refuses credential
presentation if the browser session started with logging enabled.

The principal reference is the `principal_ref` returned after identity verification. It is not
an onboarding session ID or an issued credential ID. The principal must be current and belong
to the API key's organization and sandbox environment. Minting generates an ephemeral Ed25519
keypair on the server and sends only its public JWK to Baselayer. The credential shares only what
the merchant’s profile requires. Secrets, private keys, and credentials are not returned in the
tool result.

Bell runs for one operator. In a multi-user app, verify each user once and use their own principal
reference.

Sandbox agent credentials usually expire after about one hour. The returned `expiresAt` or
credential `exp` is authoritative. A new tool call mints a fresh credential. An expired identity
verification or registry status-list token is a separate issue that a fresh mint cannot fix.

If a saved principal stops resolving, find the matching verified person in the sandbox's
[Know Your Agent people view](https://console.baselayer.com/kya/people) and use its current
reference. Do not substitute an unrelated identity just to make a mint pass.

## Test the flow

With `pnpm dev` running, keep the same web conversation or text the same Linq chat:

1. "Open https://bell-stack-demo-site.vercel.app/protected with ordinary navigation and report
   the result." Expect `401 CREDENTIAL_MISSING`.
2. "Use merchant_access for that URL, then snapshot and screenshot it." A correctly configured
   flow returns `access_granted` with HTTP 200. A mint success alone is not proof of access.
3. "Navigate to the same URL normally again and report the result." Expect denial again.

The proof is attached to one exact main-frame GET. It is not applied to redirects, subframes,
subresources, fetch/XHR calls, or later navigations. Each protected document visit needs the tool
again. A temporary `STATUS_UNAVAILABLE` response is retried once with a fresh nonce. Other denials
are reported without retry. This tool does not log in or make purchases.

For a standalone mint:

```sh
pnpm baselayer:mint https://bell-stack-demo-site.vercel.app/protected
```

The command loads `.env`, then `.env.local` when present. It writes the credential and matching
private JWK to a private temporary directory, with both files restricted to mode 0600. It prints
only the directory, audience, and expiry. Keep those files private and remove that generated
directory after testing. This command does not present the credential to a merchant.

## Change merchants

Set `BELL_DEMO_URL` to the protected resource and add its exact HTTPS origin to
`BASELAYER_ALLOWED_ORIGINS`. A comma-separated list can allow more than one merchant. No wildcards,
origin paths, or HTTP origins are accepted; tool URLs also reject queries, fragments, and embedded
credentials.

The merchant must publish `/.well-known/kya-profile.json` with its audience, a scope listing
the exact resource path, and a same-origin nonce endpoint. It must verify the issuer signature,
expiry, revocation status, audience, and single-use key-binding proof. This repository contains
the agent integration; the merchant verifier is deployed separately.

Best Buy remains an ordinary browsing example. Do not add it to the credential flow until its
Baselayer merchant support and required scope are confirmed. Changing a webhook target to Best
Buy does not configure merchant verification; Linq webhooks still point to Bell.

## Troubleshooting and verification limits

| Result                                      | Next step                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mint HTTP 404                               | Use a current `principal_ref` from the API key's sandbox organization. Baselayer returns the same status for unknown and cross-organization references. |
| Mint HTTP 409                               | Re-verify the identity, then mint again.                                                                                                                |
| `CREDENTIAL_MISSING` on ordinary navigation | Expected: this request has no proof.                                                                                                                    |
| `STATUS_UNAVAILABLE`                        | Check the merchant's access to a current registry status list. Do not bypass revocation checks.                                                         |
| `UNTRUSTED_ISSUER`                          | Confirm that the merchant's trusted issuer configuration matches Baselayer's issued token format. The agent cannot rewrite a signed issuer claim.       |
| Redirect or profile mismatch                | Use the exact protected URL advertised by the merchant's profile.                                                                                       |

The local tests use synthetic credentials and mocked provider responses. They verify mint request
shape, key and audience binding, proof signatures and nonce refresh, request isolation,
cancellation, redacted results, and bounded retry. They do not establish live sandbox eligibility.

Live verification also needs the actual sandbox API key, a current principal, and the deployed
merchant's working registry checks. Run the full denial/access/denial sequence after configuring
those services. [Link by Stripe wallet OAuth and checkout](link.md) are configured separately.

Protocol references: [minting credentials](https://docs.baselayer.com/docs/minting-credentials),
[presentation and verification](https://docs.baselayer.com/docs/presenting-and-verifying-a-credential),
and [the credential format](https://docs.baselayer.com/docs/credential-format-reference).
