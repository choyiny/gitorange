import { describe, expect, it } from 'vitest';
import { AGENT_PATH, AVATAR_PATH, parseAgentConfig } from '../agents/config';
import {
  IDENTICON_BACKGROUND,
  identicon,
  identiconPng,
} from '../agents/identicon';
import { agentTemplate } from '../agents/template';
import { decoder } from '../git/bytes';
import { ArtifactsRepoClient } from '../git/remote';
import { GitService } from '../git/service';
import { createFakeArtifacts } from './helpers/fake-artifacts';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** The chunks of a PNG, in order. */
function chunks(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: { type: string; data: Uint8Array }[] = [];
  for (let i = 8; i < png.length;) {
    const length = view.getUint32(i);
    const type = decoder.decode(png.subarray(i + 4, i + 8));
    out.push({ type, data: png.subarray(i + 8, i + 8 + length) });
    i += 12 + length;
  }
  return out;
}

async function inflate(data: Uint8Array) {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('identiconPng', () => {
  it('matches the web app identicon for a pinned seed', () => {
    // Expected values computed independently from src/components/Avatar.tsx: FNV-1a of 'secagent' gives
    // hsl(351, 55%, 51%), and the mirrored 5x5 grid below (# = filled).
    const { cells, rgb } = identicon('secagent');
    expect(rgb).toEqual([199, 61, 82]);
    expect(cells.map((r) => r.map((c) => (c ? '#' : '.')).join(''))).toEqual([
      '#####',
      '..#..',
      '.###.',
      '#...#',
      '..#..',
    ]);
  });

  it('draws the identicon as an RGB PNG', async () => {
    const seed = 'secagent';
    const size = 240;
    const png = await identiconPng(seed, size);
    expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
    const [ihdr, idat, iend] = chunks(png);
    expect(ihdr.type).toBe('IHDR');
    const header = new DataView(ihdr.data.buffer, ihdr.data.byteOffset);
    expect(header.getUint32(0)).toBe(size);
    expect(header.getUint32(4)).toBe(size);
    expect([ihdr.data[8], ihdr.data[9]]).toEqual([8, 2]); // 8-bit RGB
    expect(idat.type).toBe('IDAT');
    expect(iend.type).toBe('IEND');

    const pixels = await inflate(idat.data);
    const row = 1 + size * 3;
    expect(pixels.length).toBe(row * size);
    const at = (x: number, y: number) => [
      ...pixels.subarray(y * row + 1 + x * 3, y * row + 4 + x * 3),
    ];
    // The half-cell margin is background.
    expect(at(0, 0)).toEqual(IDENTICON_BACKGROUND);
    // The middle of every cell is the color when the cell is on, background when off.
    const { cells, rgb } = identicon(seed);
    const unit = size / 6;
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 5; x++)
        expect(
          at(Math.floor((x + 1) * unit), Math.floor((y + 1) * unit))
        ).toEqual(cells[y][x] ? rgb : IDENTICON_BACKGROUND);
  });

  it('is the same for the same seed and differs between seeds', async () => {
    expect(await identiconPng('secagent')).toEqual(
      await identiconPng('secagent')
    );
    expect(await identiconPng('secagent')).not.toEqual(
      await identiconPng('docsagent')
    );
  });
});

describe('agentTemplate', () => {
  it('seeds a valid AGENT.md named after the agent, knowledge and an avatar', async () => {
    const files = await agentTemplate('dataagent', 'Data: "the" Agent');
    expect(Object.keys(files).sort()).toEqual([
      AGENT_PATH,
      AVATAR_PATH,
      'knowledge/README.md',
    ]);
    const config = parseAgentConfig(files[AGENT_PATH] as string);
    expect(config).toMatchObject({
      name: 'Data: "the" Agent',
      engine: 'pass',
      trigger: { above: 0.5 },
    });
    expect(config.instructions).toContain('# Data: "the" Agent');
    expect(files['knowledge/README.md']).toContain('20 files');
    expect(files[AVATAR_PATH]).toEqual(await identiconPng('dataagent'));
  });
});

describe('GitService.initialCommit', () => {
  it('writes nested paths and binary files', async () => {
    const fake = createFakeArtifacts();
    await fake.binding.create('r_seed');
    const git = new GitService(new ArtifactsRepoClient(fake.binding, 'r_seed'));
    const png = new Uint8Array([137, 80, 0, 1, 2]);
    const sha = await git.initialCommit(
      'main',
      {
        'AGENT.md': 'agent',
        'knowledge/README.md': 'knowledge',
        'knowledge/deep/notes.md': 'notes',
        'avatar.png': png,
      },
      { name: 'Admin', email: 'admin@example.com', timestamp: 1_700_000_000 },
      'Create agent @x'
    );
    expect(fake.repos.get('r_seed')!.refs.get('refs/heads/main')).toBe(sha);
    const read = async (path: string) => {
      const entry = await git.entryAt(sha, path);
      expect(entry?.type).toBe('blob');
      return git.blob((entry as { entry: { hash: string } }).entry.hash);
    };
    expect(decoder.decode((await read('knowledge/README.md'))!)).toBe(
      'knowledge'
    );
    expect(decoder.decode((await read('knowledge/deep/notes.md'))!)).toBe(
      'notes'
    );
    expect(await read('avatar.png')).toEqual(png);
  });
});
