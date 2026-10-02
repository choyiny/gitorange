/**
 * Maps a file path to a highlight.js language name. Kept separate from the highlighter so
 * detection is synchronous and doesn't pull highlight.js into the main bundle.
 */
const BY_EXTENSION: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  sql: 'sql',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  pl: 'perl',
  r: 'r',
  ex: 'elixir',
  exs: 'elixir',
  hs: 'haskell',
  graphql: 'graphql',
  gql: 'graphql',
  proto: 'protobuf',
  diff: 'diff',
  patch: 'diff',
};

const BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
  'nginx.conf': 'nginx',
};

export function languageFor(path: string): string | null {
  const name = path.split('/').pop()!.toLowerCase();
  if (BY_FILENAME[name]) return BY_FILENAME[name];
  if (name.startsWith('dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXTENSION[name.slice(dot + 1)] ?? null;
}
