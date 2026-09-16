import { mountApp } from "./app/app";

const root = document.querySelector<HTMLDivElement>("#app");

if (!root) {
  throw new Error('Missing mount point: expected an element with id="app" in public/index.html.');
}

mountApp(root);
