// Vite's `?raw` imports: a file's contents as a string (tests read repository files this way).
declare module '*?raw' {
  const content: string;
  export default content;
}
