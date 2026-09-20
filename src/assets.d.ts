declare module "*.scss" {
  const css: string;
  export default css;
}

declare module "*.sass" {
  const css: string;
  export default css;
}

declare module "*.css" {
  const css: string;
  export default css;
}

declare module "*.svg" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.webp" {
  const src: string;
  export default src;
}

/** Markdown is loaded as text (see the `.md` loader in `scripts/build.mjs`). */
declare module "*.md" {
  const text: string;
  export default text;
}
