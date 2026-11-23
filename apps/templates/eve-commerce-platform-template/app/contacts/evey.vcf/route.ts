import { getInstallationSecrets } from "@/lib/auth/installation-secrets";
import { verifyContactCardUrl } from "@/lib/messaging/contact-card";

export async function GET(request: Request) {
  const { betterAuthSecret } = await getInstallationSecrets();
  const contact = verifyContactCardUrl(new URL(request.url), betterAuthSecret);
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (!contact) return new Response("Contact not found", { headers, status: 404 });

  const card = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:;${contact.name};;;`,
    `FN:${contact.name}`,
    `TEL;TYPE=CELL:${contact.phone}`,
    "END:VCARD",
  ].join("\r\n");
  return new Response(`${card}\r\n`, {
    headers: {
      ...headers,
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'attachment; filename="evey.vcf"',
    },
  });
}
