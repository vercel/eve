import { serializeJsonLd } from "@/lib/geistdocs/structured-data";

export const JsonLd = ({ data, id }: { data: Record<string, unknown>; id?: string }) => (
  <script
    // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is serialized and escapes HTML start characters.
    dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    id={id}
    type="application/ld+json"
  />
);
