# Deployment and release checklist

## Supported production setup

The template is designed for a Vercel project with Vercel Connect (Linq), a
PostgreSQL database, and private Vercel Blob. Agentcard enables purchases; Kernel
is optional and enables explicit browser shopping. The five-minute shopping
watch schedule requires a Vercel Pro team.

- Expose [Vercel system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)
  so the app can discover its deployment hosts. Better Auth trusts only the
  exact deployment hosts and the host in `BETTER_AUTH_URL`, if configured.
  Set `BETTER_AUTH_URL` to the canonical HTTPS origin for a custom domain.
- Connect a dedicated Linq line through Vercel Connect. Use `/eve/v1/linq` for
  its trigger. Only verified shoppers can start an agent conversation, and
  only in a direct chat. Linq sandbox lines may require the shopper to text
  first; the sign-in page explains this when it happens.
- Keep Agentcard credentials and the purchase webhook signing secret in Vercel
  environment variables. Start with sandbox credentials. Configure the
  purchase update URL as `https://<host>/agentcard/webhooks`.
- Use separate preview resources: database, private Blob, Linq line or disabled
  connector, and sandbox Agentcard credentials. Never point a preview at the
  production database or Blob store. See [Database setup](../migrations/README.md)
  for migration timing.

`pnpm build` builds both eve and Next.js for a standalone production smoke
test. Set explicit `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, and database URLs
outside Vercel, run `pnpm db:migrate`, then `pnpm build` and
`pnpm start --hostname 127.0.0.1`.
This does not replace Vercel Connect for the template’s production iMessage
flow. Use `EVEY_LOCAL_PHONE_AUTH=1 pnpm dev` only for loopback development.

## Upgrading an existing deployment

Migration `0003` adds the sign-in send quota and persistent Linq chat ownership.
The public Linq trigger URL is unchanged. The first inbound message after the
upgrade starts a new eve conversation rather than attaching to old, unbound
history. Previously pending purchase updates without a verified destination
are not forwarded. Finish active checkouts before upgrading a live line.

A claimed Linq chat stays bound to its first verified shopper. When provisioning
a new identity, use a fresh provider chat or line instead of deleting the
binding to reuse old history. Phone numbers are the sign-in credential; phone
recycling and account recovery require an operator policy before onboarding
real shoppers.

## Before sharing

1. Confirm the published repo is accessible to the intended audience. If sharing
   a new public copy or fork, update `repository-url` and `envLink` in the README’s
   Deploy button and the GitHub link in the sidebar. The button cannot grant access
   to an internal repository.
2. Deploy from a clean clone. Confirm migrations succeed, sign-in sends an OTP,
   and the agent answers a direct message. Test iMessage with two different
   verified numbers and check that neither can see the other’s details or chat
   history. Try the first-text flow if the line is in sandbox mode.
3. Run a sandbox purchase through approval and verify the signed order update
   reaches only the originating shopper. Check that a watch alert arrives on the
   expected line. If enabling Kernel, try a browser task and verify that private
   images can only be accessed by their owner.
4. Set provider usage limits and alerting before inviting shoppers. Explain how
   saved details can be shared with the model for requested tasks and set a policy
   for data retention, account recovery, and removal.
