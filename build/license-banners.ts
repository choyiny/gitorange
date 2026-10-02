import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

/**
 * Prepends a `/*! … *\/` license comment to every client JS and CSS file, naming each npm
 * package bundled into it with its license and copyright line. Many dependencies ship no
 * banner of their own, and MIT/BSD require the notice to travel with copies we serve.
 * BSD licenses also require the conditions and disclaimer, so their full text is included.
 */
export function licenseBanners(): Plugin {
  const cache = new Map<string, string>();
  let root = process.cwd();

  /** App CSS inlines packages via `@import 'pkg/…'` before bundling, so read those imports. */
  function cssImportDirs(file: string): string[] {
    let source = '';
    try {
      source = fs.readFileSync(file.split('?')[0], 'utf8');
    } catch {
      return [];
    }
    return [
      ...source.matchAll(/@import\s+(?:url\()?['"]([^'"./][^'"]*)['"]/g),
    ].map(([, spec]) => {
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
      return path.join(root, 'node_modules', name).replace(/\\/g, '/');
    });
  }

  function packageDir(id: string): string | null {
    const normalized = id.split('?')[0].replace(/\\/g, '/');
    const i = normalized.lastIndexOf('/node_modules/');
    if (i < 0) return null;
    const rest = normalized.slice(i + '/node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    return normalized.slice(0, i) + '/node_modules/' + name;
  }

  function notice(dir: string): string {
    const hit = cache.get(dir);
    if (hit !== undefined) return hit;
    let text = '';
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
      );
      const license =
        typeof pkg.license === 'string' ? pkg.license : 'see package';
      const file = fs
        .readdirSync(dir)
        .find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
      const body = file ? fs.readFileSync(path.join(dir, file), 'utf8') : '';
      // A real notice line ("Copyright 2024 …", "(c) …"), not license prose mentioning "copyright".
      const copyright = body
        .split('\n')
        .map((l) => l.trim())
        .find((l) =>
          /^(copyright\s*(\(c\)|©)?\s*\d{4}|copyright\s*(\(c\)|©)|\(c\)\s*\d{4}|©)/i.test(
            l
          )
        );
      text = `${pkg.name}@${pkg.version} — ${license}${copyright ? ` — ${copyright}` : ''}`;
      if (/^BSD/i.test(license) && body) text += '\n' + body.trim();
    } catch {
      text = '';
    }
    cache.set(dir, text);
    return text;
  }

  const banner = (dirs: Set<string>) => {
    const lines = [...dirs].sort().map(notice).filter(Boolean);
    if (!lines.length) return '';
    // `*/` can't appear inside the comment; license texts never contain it, but be safe.
    const body = lines.join('\n\n').replace(/\*\//g, '* /');
    return `/*! Third-party software bundled in this file:\n\n${body}\n*/\n`;
  };

  return {
    name: 'gitorange:license-banners',
    apply: 'build',
    enforce: 'post',
    applyToEnvironment: (env) => env.name === 'client',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        const js = new Set<string>();
        const css = new Set<string>();
        for (const id of chunk.moduleIds) {
          const isCss = /\.(css|scss|less)($|\?)/.test(id);
          const dir = packageDir(id);
          if (dir) (isCss ? css : js).add(dir);
          else if (isCss) cssImportDirs(id).forEach((d) => css.add(d));
        }
        if (js.size) chunk.code = banner(js) + chunk.code;
        const importedCss: Set<string> | undefined = (
          chunk as { viteMetadata?: { importedCss: Set<string> } }
        ).viteMetadata?.importedCss;
        for (const file of importedCss ?? []) {
          const asset = bundle[file];
          if (asset?.type === 'asset' && css.size)
            asset.source = banner(css) + String(asset.source);
        }
      }
    },
  };
}
