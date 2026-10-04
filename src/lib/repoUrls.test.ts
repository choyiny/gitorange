import { describe, expect, it } from 'vitest';
import { dirOf, repoImageSrc, repoLinkHref, resolveRepoPath } from './repoUrls';

const root = { owner: 'choyiny', repo: 'gitorange', ref: 'main', dir: '' };
const nested = { ...root, dir: 'docs/guides' };
const raw = (ref: string, path: string) =>
  `/api/repos/choyiny/gitorange/raw?${new URLSearchParams({ ref, path })}`;

describe('repoImageSrc', () => {
  it('points an image next to a root README at the raw endpoint', () => {
    expect(repoImageSrc(root, 'docs/screenshots/repository.jpg')).toBe(
      raw('main', 'docs/screenshots/repository.jpg')
    );
    expect(repoImageSrc(root, './logo.png')).toBe(raw('main', 'logo.png'));
  });

  it('resolves against a nested README directory', () => {
    expect(repoImageSrc(nested, 'img/flow.png')).toBe(
      raw('main', 'docs/guides/img/flow.png')
    );
  });

  it('handles ../ and root-relative paths', () => {
    expect(repoImageSrc(nested, '../screenshots/a.jpg')).toBe(
      raw('main', 'docs/screenshots/a.jpg')
    );
    expect(repoImageSrc(nested, '../../../../a.jpg')).toBe(
      raw('main', 'a.jpg')
    );
    expect(repoImageSrc(nested, '/docs/b.png')).toBe(raw('main', 'docs/b.png'));
  });

  it('decodes percent-encoding once and keeps the ref', () => {
    expect(
      repoImageSrc({ ...root, ref: 'feature/x' }, 'my%20shot.png?v=1')
    ).toBe(raw('feature/x', 'my shot.png'));
  });

  it('leaves absolute and data URLs alone', () => {
    for (const src of [
      'https://example.com/a.png',
      'http://example.com/a.png',
      '//cdn.example.com/a.png',
      'data:image/png;base64,AAAA',
      '',
    ])
      expect(repoImageSrc(root, src)).toBeNull();
  });
});

describe('repoLinkHref', () => {
  it('links root-README files to the blob view', () => {
    expect(repoLinkHref(root, 'docs/setup.md')).toBe(
      '/choyiny/gitorange/blob/main/docs/setup.md'
    );
  });

  it('resolves ./, ../ and root-relative links from a nested file', () => {
    expect(repoLinkHref(nested, './auto-merge.md')).toBe(
      '/choyiny/gitorange/blob/main/docs/guides/auto-merge.md'
    );
    expect(repoLinkHref(nested, '../setup.md')).toBe(
      '/choyiny/gitorange/blob/main/docs/setup.md'
    );
    expect(repoLinkHref(nested, '/README.md')).toBe(
      '/choyiny/gitorange/blob/main/README.md'
    );
  });

  it('keeps fragments', () => {
    expect(repoLinkHref(root, 'docs/setup.md#deploying')).toBe(
      '/choyiny/gitorange/blob/main/docs/setup.md#deploying'
    );
  });

  it('uses the tree view for directories', () => {
    expect(repoLinkHref(root, 'docs/')).toBe(
      '/choyiny/gitorange/tree/main/docs'
    );
    expect(repoLinkHref(nested, '..')).toBe(
      '/choyiny/gitorange/tree/main/docs'
    );
    expect(repoLinkHref(root, '/')).toBe('/choyiny/gitorange/tree/main');
  });

  it('encodes ref and path segments for the URL', () => {
    expect(repoLinkHref({ ...root, ref: 'feature/x' }, 'docs/my file.md')).toBe(
      '/choyiny/gitorange/blob/feature/x/docs/my%20file.md'
    );
  });

  it('leaves absolute URLs and anchors alone', () => {
    for (const href of [
      'https://example.com',
      'http://example.com/x.md',
      'mailto:me@example.com',
      '//example.com/x',
      '#section',
      '',
    ])
      expect(repoLinkHref(root, href)).toBeNull();
  });
});

describe('helpers', () => {
  it('dirOf strips the file name', () => {
    expect(dirOf('README.md')).toBe('');
    expect(dirOf('docs/a/README.md')).toBe('docs/a');
  });

  it('resolveRepoPath reports a fragment-only path as not relative', () => {
    expect(resolveRepoPath('docs', '#x')).toBeNull();
    expect(resolveRepoPath('docs', '?x=1')).toBeNull();
  });
});
