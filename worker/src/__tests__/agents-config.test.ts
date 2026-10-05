import { describe, expect, it } from 'vitest';
import {
  AgentConfigError,
  MAX_AGENT_MD,
  parseAgentConfig,
  readAgentConfig,
} from '../agents/config';
import { ArtifactsRepoClient } from '../git/remote';
import { GitService } from '../git/service';
import { createFakeArtifacts } from './helpers/fake-artifacts';
import { commitPaths } from './helpers/seed';

const VALID = `name: Security Agent
bio: Reviews changes to authentication.
trigger:
  ask: Does this change touch authentication?
  above: 0.3
engine: pass`;

const md = (front: string, body = 'Review carefully.') =>
  `---\n${front}\n---\n${body}\n`;

describe('parseAgentConfig', () => {
  it('reads the frontmatter and the instructions', () => {
    expect(
      parseAgentConfig(md(VALID, '# Security\n\nLook for leaked secrets.'))
    ).toEqual({
      name: 'Security Agent',
      bio: 'Reviews changes to authentication.',
      trigger: { ask: 'Does this change touch authentication?', above: 0.3 },
      engine: 'pass',
      instructions: '# Security\n\nLook for leaked secrets.',
    });
  });

  it('defaults bio to empty and engine to pass', () => {
    const front = VALID.replace(
      'bio: Reviews changes to authentication.\n',
      ''
    ).replace('\nengine: pass', '');
    expect(parseAgentConfig(md(front))).toMatchObject({
      bio: '',
      engine: 'pass',
    });
  });

  it('accepts the pi engine', () => {
    expect(
      parseAgentConfig(md(VALID.replace('engine: pass', 'engine: pi'))).engine
    ).toBe('pi');
  });

  it('reads files saved with a BOM and Windows line endings', () => {
    const source = ('﻿' + md(VALID, 'Body.')).replace(/\n/g, '\r\n');
    expect(parseAgentConfig(source)).toMatchObject({
      name: 'Security Agent',
      trigger: { above: 0.3 },
      instructions: 'Body.',
    });
  });

  it.each([
    ['no frontmatter', '# Just Markdown\n', /must start with YAML frontmatter/],
    [
      'unclosed frontmatter',
      '---\nname: X\n',
      /must start with YAML frontmatter/,
    ],
    ['invalid YAML', md('name: [unclosed'), /not valid YAML/],
    [
      'a missing name',
      md(VALID.replace('name: Security Agent\n', '')),
      /AGENT\.md: name/,
    ],
    ['a missing trigger', md('name: X'), /AGENT\.md: trigger/],
    [
      'above of 0',
      md(VALID.replace('0.3', '0')),
      /trigger\.above: must be between 0 and 1/,
    ],
    [
      'above of 1',
      md(VALID.replace('0.3', '1')),
      /trigger\.above: must be between 0 and 1/,
    ],
    ['above as text', md(VALID.replace('0.3', '"0.3"')), /trigger\.above/],
    [
      'an unknown engine',
      md(VALID.replace('engine: pass', 'engine: gpt')),
      /engine: must be pass or pi/,
    ],
    ['an unknown key', md(`${VALID}\nmodel: clef`), /model/],
    ['an empty body', md(VALID, '   '), /no instructions/],
  ])('rejects %s', (_, source, message) => {
    expect(() => parseAgentConfig(source)).toThrow(AgentConfigError);
    expect(() => parseAgentConfig(source)).toThrow(message);
  });
});

describe('readAgentConfig', () => {
  async function gitWith(files: Record<string, string>) {
    const fake = createFakeArtifacts();
    await fake.binding.create('r_cfg');
    const sha = await commitPaths(
      fake.repos.get('r_cfg')!,
      'main',
      files,
      'Seed'
    );
    return {
      git: new GitService(new ArtifactsRepoClient(fake.binding, 'r_cfg')),
      sha,
    };
  }

  it('reads AGENT.md at a commit', async () => {
    const { git, sha } = await gitWith({ 'AGENT.md': md(VALID) });
    expect(await readAgentConfig(git, sha)).toMatchObject({
      ok: true,
      config: { name: 'Security Agent' },
    });
  });

  it('reports a missing, invalid or oversized AGENT.md', async () => {
    const missing = await gitWith({ 'README.md': 'hi' });
    expect(await readAgentConfig(missing.git, missing.sha)).toEqual({
      ok: false,
      error: 'AGENT.md is missing.',
    });
    const invalid = await gitWith({ 'AGENT.md': md('name: X') });
    expect(await readAgentConfig(invalid.git, invalid.sha)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^AGENT\.md: trigger/),
    });
    const huge = await gitWith({
      'AGENT.md': md(VALID, 'x'.repeat(MAX_AGENT_MD)),
    });
    expect(await readAgentConfig(huge.git, huge.sha)).toEqual({
      ok: false,
      error: 'AGENT.md is larger than 64 KB.',
    });
  });

  it('checks the size before loading an oversized AGENT.md', async () => {
    const { git, sha } = await gitWith({
      'AGENT.md': md(VALID, 'x'.repeat(MAX_AGENT_MD)),
    });
    // Reading the bytes of the oversized blob is what the check must avoid.
    const repo = await git.client.repo();
    const readBlob = repo.readBlob.bind(repo);
    repo.readBlob = async (hash: string) => {
      const blob = await readBlob(hash);
      if (!blob) return blob;
      return Object.assign(blob, {
        arrayBuffer: () => Promise.reject(new Error('loaded the whole blob')),
      });
    };
    expect(await readAgentConfig(git, sha)).toEqual({
      ok: false,
      error: 'AGENT.md is larger than 64 KB.',
    });
  });
});
