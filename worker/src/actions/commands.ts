/** Parses `$GITHUB_ENV`/`$GITHUB_OUTPUT`: `NAME=value` lines or `NAME<<EOF` … `EOF` heredocs. */
export function parseKeyValueFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    const heredoc = /^([^=<\s]+)<<(.+)$/.exec(line);
    if (heredoc) {
      const [, name, delim] = heredoc;
      const value: string[] = [];
      i++;
      while (i < lines.length && lines[i].replace(/\r$/, '') !== delim)
        value.push(lines[i++]);
      out[name] = value.join('\n');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

export function parsePathFile(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Replaces secrets with `***`; values under 4 chars are left alone, like GitHub. */
export function mask(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets)
    if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}
