import { titleStillSvg } from "../title-art";

export function GET() {
  return new Response(titleStillSvg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
