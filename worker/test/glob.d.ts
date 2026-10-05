// Vite's import.meta.glob (a build-time transform): matching paths, each with a lazy import.
interface ImportMeta {
  glob(
    pattern: string | string[],
    options?: { eager?: false }
  ): Record<string, () => Promise<unknown>>;
}
