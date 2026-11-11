// Vite's ?raw suffix imports a file's text.
declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's import.meta.glob, as vitest runs it: every file matching a pattern, here eagerly.
interface ImportMeta {
  glob<T>(pattern: string, options: { eager: true; query?: string; import?: string }): Record<string, T>;
}
