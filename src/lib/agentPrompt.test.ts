import { describe, expect, it } from 'vitest';
import { agentPrompt } from './agentPrompt';
import type { RepoDetail } from './uiApi';

const repo = (empty: boolean) =>
  ({
    fullName: 'ada/engine',
    cloneUrl: 'https://git.example.com/ada/engine.git',
    defaultBranch: 'main',
    empty,
  }) as RepoDetail;

describe('agentPrompt', () => {
  it('has the agent ask the person to clone, so the token never enters the chat', () => {
    const p = agentPrompt(repo(false), 'https://git.example.com');
    expect(p).toContain('! git clone https://git.example.com/ada/engine.git');
    expect(p).toContain('https://git.example.com/settings/tokens');
    expect(p).not.toMatch(/gop_[0-9a-f]/);
  });

  it('sets up Git LFS and links pull requests to the compare page', () => {
    const p = agentPrompt(repo(false), 'https://git.example.com');
    expect(p).toContain('git lfs install');
    expect(p).toContain('git lfs track');
    expect(p).toContain(
      'https://git.example.com/ada/engine/compare/main...<branch-name>'
    );
  });

  it('helps add first files when the repository is empty', () => {
    expect(agentPrompt(repo(true), 'https://git.example.com')).toContain(
      'This repository is empty'
    );
    expect(agentPrompt(repo(false), 'https://git.example.com')).not.toContain(
      'This repository is empty'
    );
  });
});
