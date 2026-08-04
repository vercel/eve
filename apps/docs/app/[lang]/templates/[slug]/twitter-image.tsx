import { notFound } from "next/navigation";
import { getTemplateEntry } from "@/lib/templates/data";
import { createTemplateOgImage } from "@/lib/templates/og-image";

export const size = {
  width: 1200,
  height: 628,
};
export const contentType = "image/png";

const TemplateTwitterImage = async ({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) => {
  const { slug } = await params;
  const template = getTemplateEntry(slug);

  if (!template) {
    notFound();
  }

  return createTemplateOgImage(template.title);
};

export default TemplateTwitterImage;
