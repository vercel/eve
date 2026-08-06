import { notFound } from "next/navigation";
import { templateManifest } from "@/lib/templates/manifest";
import { createTemplateOgImage } from "@/lib/templates/og-image";

export const size = {
  width: 1200,
  height: 628,
};
export const contentType = "image/png";

const TemplateOpenGraphImage = async ({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) => {
  const { slug } = await params;
  const template = templateManifest.find((entry) => entry.slug === slug);

  if (!template) {
    notFound();
  }

  return createTemplateOgImage(template.title);
};

export default TemplateOpenGraphImage;
