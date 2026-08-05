---
issue: TBD
status: proposed
last_updated: "2026-08-04"
---

# Resend Marketplace domain setup

## Recommendation

Make Vercel Marketplace the preferred domain-provisioning path for `eve add
channel/resend`. Reuse the existing Resend Marketplace product and signed Domain
Connect flow instead of having eve mutate DNS records directly.

Keep manual Vercel Connect API-key and portable environment-variable paths for
existing Resend accounts and domains outside Marketplace.

The flow should converge three starting states on one ready configuration:

```text
A. Resend resource + domain exist ──> select/reuse resource ─────────────┐
                                                                        │
B. Vercel domain exists ────────────> provision Resend resource ────────┤
                                                                        │
C. No domain exists ────────────────> Vercel web domain setup ─────────┤
                                      └─> resume Resend provisioning ──┘
                                                                        │
                                      signed Domain Connect <───────────┘
                                                │
                                                v
                                verify sending + receiving
                                                │
                                                v
                           scaffold eve@<domain> + deploy + webhook
```

The outcome should be the same whether the user starts with no email setup, a
Vercel-owned domain, or an existing Resend Marketplace resource.

## Existing platform capabilities

The published Marketplace integration uses integration slug `resend` and product
slug `resend-email`. Provisioning requires a domain and region:

```ts
{
  domain: string;
  region: "us-east-1" | "eu-west-1" | "sa-east-1" | "ap-northeast-1";
}
```

Vercel CLI can provision and connect the resource:

```sh
vercel integration add resend \
  --metadata domain=example.com \
  --metadata region=us-east-1 \
  --environment production \
  --json
```

The flow can install the integration, accept terms or hand off to a browser,
provision the resource, connect it to the linked project, synchronize
`RESEND_API_KEY`, and return resource and installation identifiers. The product
advertises project connections, SSO, secret synchronization, and immediate
secret rotation.

Front already owns Resend Domain Connect templates for sending, receiving,
combined sending and receiving, verification, and click tracking. The combined
`resend.com.mail-send-and-receive` template includes DKIM, outbound MX/SPF,
inbound MX, tracking CNAME, and CAA records.

## Proposed guided flow

The Resend setup destination picker should lead with Marketplace:

```text
How would you like to configure Resend?

● Set up with Vercel Marketplace
  Create or select a Resend account, domain, and project credential

○ Use an existing Resend API key
  Store a full-access key in Vercel Connect

○ Use portable credentials
```

For the Marketplace path:

1. Require authenticated Vercel CLI access and ensure the directory is linked
   to a project.
2. Inventory Resend Marketplace resources and Vercel-owned domains for the
   linked team and project using existing Vercel CLI/API surfaces.
3. Classify the starting state and follow the matching path below. Keep eve's
   orchestration thin: select or reuse resources locally, and hand off account,
   domain, billing, terms, and DNS workflows to Vercel/Resend web surfaces.
4. Converge on one selected Resend resource and configured domain.
5. Open or print the Resend onboarding URL when browser completion is required.
   Explain that **Auto configure** applies the provider-signed DNS setup.
6. Poll or re-check resource/domain status after the user completes onboarding.
7. Require both sending and receiving to be enabled before using the domain for
   automatic replies. If only sending is configured, direct the user to enable
   receiving rather than mutating inbound MX records from eve.
8. Connect the resource to the linked project for production if it is not
   already connected, preserving Marketplace ownership of `RESEND_API_KEY`.
9. Prefill `eve@<configured-domain>` as the editable agent email address.
10. Continue with channel scaffolding, deployment, webhook setup, and a
    send/reply smoke test.

### A. Existing Resend resource and domain

List compatible `resend-email` resources, showing their configured domain,
readiness, and whether they are connected to the linked project. Prefer an exact
project connection, then a send-and-receive-ready resource on the same team.
Let the user select when more than one remains.

Reuse the resource and its domain. Do not reprovision Resend, rotate its key, or
reapply DNS when the resource is already ready. If it is not connected to the
project, add only the production project connection. If its domain is pending or
send-only, resume the provider onboarding/configuration flow instead of creating
another resource.

### B. Existing Vercel domain, no matching Resend resource

List domains owned by the linked Vercel account and ask which one to configure.
Prefer a dedicated subdomain such as `mail.example.com` or `agent.example.com`;
do not change apex MX records without explicit user intent.

Invoke the existing Marketplace CLI provisioning flow with the selected domain,
region, production environment, and JSON output:

```sh
vercel integration add resend \
  --metadata domain=mail.example.com \
  --metadata region=us-east-1 \
  --environment production \
  --json
```

Then complete Resend onboarding and signed Domain Connect configuration.

### C. No Vercel domain

Do not implement domain search, pricing, checkout, registration, transfer, or
purchase confirmation in eve. Present a browser handoff to Vercel's domain
surface, where Vercel owns billing, registrant details, availability, renewal
terms, permissions, and purchase recovery.

The handoff should preserve the linked team and return/resume intent when the web
surface supports it. Otherwise, print the exact Vercel domains URL and tell the
user to rerun `eve add channel/resend` after adding or purchasing a domain. The
CLI may poll for a newly available team domain while the browser is open, but it
must also support a clean exit and later rerun.

Once a domain appears, resume path B: select a safe email subdomain, provision
the Resend Marketplace resource, complete signed Domain Connect, and verify
sending and receiving. If the user does not want to add a domain, retain the
manual existing-account and portable alternatives rather than blocking all
channel scaffolding.

A rerun must detect the furthest completed state and resume from there without
duplicating a domain purchase, Marketplace resource, DNS application, or project
connection.

## DNS ownership and safety

DNS remains owned by Resend's signed Domain Connect flow. eve must not synthesize
the apply URL or create the records itself because the provider supplies dynamic
DKIM, return-path, inbound MX, priority, region, and tracking values. The signed
flow also proves which provider configuration the records belong to.

Inbound MX changes can disrupt an existing mail provider. Setup should favor a
dedicated subdomain and clearly warn before configuring a root domain that
already has MX records. Exact conflicts and replacement behavior belong in the
Domain Connect confirmation UI.

## Credential boundary

Marketplace currently provisions `RESEND_API_KEY` as a resource secret and
syncs it into connected projects. eve should not read that environment value
back and copy it into Connect; doing so duplicates credential ownership and
breaks Marketplace rotation semantics.

Before a Native→Connect bridge exists, the Marketplace path may generate the
adapter's standard environment-backed credential behavior:

```ts
createResendAdapter({
  fromAddress: "eve@example.com",
});
```

A future bridge should let the Marketplace resource issue an app credential to
Connect, after which generated code can use `connectResendApiKey(...)` without
copying a static key. Manual API-key setup remains a separate Connect-backed
fallback.

Automatic webhook management on the Marketplace path needs one of:

- a Marketplace resource-token endpoint that can mint a bounded Resend token;
- a Native→Connect resource authorization;
- a Resend Marketplace operation that reconciles the webhook on eve's behalf;
- or a documented manual webhook step.

Do not access Marketplace resource secrets merely to automate webhook creation.

## Required coordination with Resend

Confirm before making Marketplace the default:

1. Does `resend-email` currently configure sending only or the combined
   `resend.com.mail-send-and-receive` service?
2. Can provisioning explicitly request receiving support?
3. Does the product accept a subdomain under a Vercel-owned apex domain, and
   can Marketplace create that subdomain without attaching it as a project
   domain?
4. What identifier is returned as `externalResourceId`, and can safe resource
   metadata expose the configured domain?
5. Can resource discovery reliably match an existing Resend resource to a
   domain and project without reading secrets?
6. Is a Marketplace `resourceTokenEndpoint` configured or planned, and what
   scopes would its token carry?
7. Can Marketplace provisioning accept or later configure an `email.received`
   webhook destination?
8. Can resource status distinguish DNS pending, send-ready, and receive-ready?
9. What is the expected Native→Connect bridge contract and timeline?

## Repository boundaries

- **Resend Marketplace integration:** account/resource creation, billing, API-key
  lifecycle, provider onboarding, and initiating signed Domain Connect.
- **Front:** domain search/purchase/transfer, Marketplace checkout/resource
  selection, and Domain Connect confirmation UI and templates.
- **Vercel API:** Marketplace installation/resource/project connection APIs and
  resource-token or Native→Connect bridge primitives.
- **Vercel CLI:** existing `integration add`, resource discovery, connection,
  browser handoff, and JSON results used by eve orchestration.
- **Connect:** runtime app-token resolution after a bridge exists, or manual
  API-key storage for the fallback path.
- **eve:** thin setup coordination, resource/domain discovery, browser handoffs,
  safe selection defaults, generated channel, deployment, webhook reconciliation
  when an authorized credential path exists, and smoke-test guidance. eve does
  not own domain commerce or DNS mutation.

## Tests

At minimum cover:

- existing compatible resource selection and reuse;
- multiple-resource selection prefers the linked project and ready domain;
- an existing resource already connected to the project is left untouched;
- a pending or send-only existing resource resumes setup without duplication;
- existing-domain selection and dedicated-subdomain recommendation;
- no-domain path opens or prints the Vercel web domain flow without implementing
  availability, pricing, checkout, or purchase in eve;
- browser cancellation and later rerun are clean;
- a domain added through Vercel web resumes Marketplace provisioning on rerun;
- Marketplace provisioning arguments and parsed JSON result;
- browser/terms handoff and cancellation;
- send-only status does not proceed as reply-ready;
- send-and-receive status prefills `eve@<domain>`;
- no direct DNS mutation or unsigned Domain Connect URL construction;
- no Marketplace secret readback or copy into Connect;
- reruns do not duplicate resources, DNS setup, or project connections;
- partial failure reports domain, resource, and installation IDs with recovery
  commands;
- manual Connect and portable fallbacks remain available.

## Rollout

Start behind an explicit Marketplace option while confirming receiving and
resource-token behavior with Resend. The first implementation should orchestrate
existing CLI discovery/provisioning plus browser handoffs, not reproduce
Marketplace checkout or domain management in eve. Promote Marketplace to the
recommended first option once a selected domain can be proven send-and-receive
ready and the webhook can be configured without copying its static Marketplace
secret.
