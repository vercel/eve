import { notFound } from "next/navigation";
import { getIntegration } from "@/lib/integrations/data";
import { createIntegrationOgImage } from "@/lib/integrations/og-image";

export const size = {
  width: 1200,
  height: 628,
};
export const contentType = "image/png";

const IntegrationTwitterImage = async ({
  params,
}: {
  params: Promise<{ lang: string; slug: string }>;
}) => {
  const { slug } = await params;
  const integration = getIntegration(slug);

  if (!integration) {
    notFound();
  }

  return createIntegrationOgImage(integration);
};

export default IntegrationTwitterImage;
