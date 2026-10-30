# Tally

Invoicing for small studios and agencies. Next.js App Router, one deployment on Vercel.

## Develop

```sh
cp .env.example .env.local   # then set SESSION_SECRET
npm install
npm run dev
```

Sign in at `/login` with one of the demo accounts in `lib/users.ts`.

## Layout

- `app/(dashboard)/` holds every signed-in page. Its layout redirects signed-out visitors to `/login`.
- `lib/session.ts` signs and verifies the `tally_session` cookie. `readSession(cookieHeader)` works
  anywhere you have the raw `Cookie` header; `lib/current-user.ts` wraps it for server components.
- `lib/invoices.ts` is the invoice data layer. Every function takes the caller's org ID, so code
  must pass the signed-in user's `orgId`, never one that came from user input.
- Members can view invoices and send reminders. Only org owners can void an invoice.
