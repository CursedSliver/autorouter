export {};

declare global {
  interface Window {
    readonly __APP__?: {
      name: string;
      version: string;
    };
  }
}
