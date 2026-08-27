import { getImageProps } from "next/image";
import type { ComponentProps } from "react";
import fallbackDarkImage from "../../../../../public/eve-5/fallback-dark-content.webp";
import fallbackLightImage from "../../../../../public/eve-5/fallback-light-content.webp";
import { BLOOM_RADIUS } from "./render";

// Owns static fallback image sizing and rendering for the Eve hero logo.
// INVARIANT: CSS padding mirrors the animated canvas bloom padding.
// Imported only by index.tsx.

export const FALLBACK_IMAGE_WIDTH = 1095;
export const FALLBACK_IMAGE_HEIGHT = 348;
export const FALLBACK_IMAGE_ASPECT_RATIO = `${FALLBACK_IMAGE_WIDTH} / ${FALLBACK_IMAGE_HEIGHT}`;
export const FALLBACK_CONTAINER_ASPECT_RATIO = `${FALLBACK_IMAGE_WIDTH + BLOOM_RADIUS} / ${FALLBACK_IMAGE_HEIGHT + BLOOM_RADIUS}`;
export const FALLBACK_IMAGE_SIZES = "(min-width: 768px) 1095px, calc(100vw - 16px)";
export const FALLBACK_IMAGE_PADDING = BLOOM_RADIUS / 2;

const fallbackImageOptions = {
  alt: "",
  width: FALLBACK_IMAGE_WIDTH,
  height: FALLBACK_IMAGE_HEIGHT,
  sizes: FALLBACK_IMAGE_SIZES,
  priority: true,
  quality: 95,
} as const;

export function getFallbackImageProps() {
  const { props: fallbackLightImageProps } = getImageProps({
    ...fallbackImageOptions,
    src: fallbackLightImage,
  });
  const { props: fallbackDarkImageProps } = getImageProps({
    ...fallbackImageOptions,
    src: fallbackDarkImage,
  });
  return { fallbackLightImageProps, fallbackDarkImageProps };
}

export function FallbackImage({
  imageProps,
  visible,
  className,
}: {
  imageProps: ComponentProps<"img">;
  visible: boolean;
  className: string;
}) {
  return (
    <div
      className={`${className} absolute transition-opacity duration-700 ease-linear ${visible ? "opacity-100" : "opacity-0"}`}
      style={{ inset: FALLBACK_IMAGE_PADDING }}
    >
      <img
        {...imageProps}
        aria-hidden="true"
        role="presentation"
        decoding="async"
        className="absolute left-1/2 top-1/2 h-full w-auto max-w-none -translate-x-1/2 -translate-y-1/2"
        style={{ aspectRatio: FALLBACK_IMAGE_ASPECT_RATIO }}
      />
    </div>
  );
}
