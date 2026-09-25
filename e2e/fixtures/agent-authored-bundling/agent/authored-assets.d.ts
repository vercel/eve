declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "*.bin" {
  const dataUrl: string;
  export default dataUrl;
}
