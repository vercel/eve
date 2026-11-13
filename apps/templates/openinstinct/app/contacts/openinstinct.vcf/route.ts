import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getInstallationSecrets } from "@db/services/installation-secrets";
import { verifyOpenInstinctContactUrl } from "@shared/chat/contact-card";

export async function GET(request: Request) {
  const { betterAuthSecret } = await getInstallationSecrets();
  const phone = verifyOpenInstinctContactUrl(
    new URL(request.url),
    betterAuthSecret
  );
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  if (!phone)
    return new Response("Contact not found", { headers, status: 404 });

  const photo = await readFile(join(process.cwd(), "app/apple-icon.png"));
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:;OpenInstinct;;;",
    "FN:OpenInstinct",
    `TEL;TYPE=CELL:${phone}`,
    `PHOTO;ENCODING=b;TYPE=PNG:${photo.toString("base64")}`,
    "END:VCARD",
  ];
  // All fields are ASCII; fold below vCard 3.0's 75-byte line limit.
  const card = lines
    .map((line) => line.match(/.{1,74}/g)?.join("\r\n "))
    .join("\r\n");
  return new Response(`${card}\r\n`, {
    headers: {
      ...headers,
      "Content-Type": "text/vcard; charset=utf-8",
      "Content-Disposition": 'attachment; filename="OpenInstinct.vcf"',
    },
  });
}
