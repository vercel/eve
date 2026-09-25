import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <svg fill="none" viewBox="0 0 102 102" xmlns="http://www.w3.org/2000/svg">
      <path d="M0 0h102v102H0z" fill="#000" />
      <path
        d="M49.28 66.94 75.03 34.96h-6.89L47.91 60.11l-5.49 6.83h6.86ZM0 34.96h42.4v5.11H0zm0 13.32h27.66v5.11H0zm0 13.54h27.66v5.11H0zm69.63-26.86H102v5.11H69.63zm4.71 13.32H102v5.11H74.34zm0 13.54H102v5.11H74.34z"
        fill="#fff"
      />
    </svg>,
    size,
  );
}
