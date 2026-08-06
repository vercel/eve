import { createIntegrationsDirectoryOgImage } from "@/lib/integrations/directory-og-image";

export const size = {
  width: 1200,
  height: 628,
};
export const contentType = "image/png";

const IntegrationsOpenGraphImage = () => createIntegrationsDirectoryOgImage();

export default IntegrationsOpenGraphImage;
