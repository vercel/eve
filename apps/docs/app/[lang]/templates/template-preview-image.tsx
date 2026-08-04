import Image from "next/image";

interface TemplatePreviewImageProps {
  className?: string;
  sizes: string;
  slug: string;
  title: string;
}

export const TemplatePreviewImage = ({
  className,
  sizes,
  slug,
  title,
}: TemplatePreviewImageProps) => (
  <Image
    alt={`${title} template preview`}
    className={className}
    height={628}
    sizes={sizes}
    src={`/templates/${slug}/opengraph-image`}
    unoptimized
    width={1200}
  />
);
