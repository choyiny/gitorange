import { describe, expect, it } from 'vitest';
import { npmManifest } from '../pack.mjs';

describe('npmManifest', () => {
  it('describes the published package', () => {
    expect(
      npmManifest({
        version: '1.0.0',
        commit: 'abc',
        wranglerVersion: '4.146.0',
      })
    ).toEqual({
      name: 'gitorange',
      version: '1.0.0',
      description:
        'Install, upgrade and adopt a GitOrange deployment on Cloudflare.',
      license: 'Apache-2.0',
      type: 'module',
      bin: { gitorange: 'bin/gitorange.js' },
      engines: { node: '>=22.0.0' },
      dependencies: { wrangler: '4.146.0' },
      gitorangeCommit: 'abc',
      repository: {
        type: 'git',
        url: 'git+https://github.com/choyiny/gitorange.git',
      },
      files: [
        'bin',
        'worker',
        'client',
        'migrations',
        'actions',
        'wrangler.jsonc.example',
        'README.md',
        'LICENSE',
      ],
    });
  });
});
