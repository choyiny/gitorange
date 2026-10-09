import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX,
  inviteFailureMessage,
  normalizeRepoName,
  repoNameProblem,
} from './newRepo';

describe('normalizeRepoName', () => {
  it('trims and turns every run of other characters into one dash, as the server does', () => {
    expect(normalizeRepoName('  my repo  ')).toBe('my-repo');
    expect(normalizeRepoName('a / b !! c')).toBe('a-b-c');
    expect(normalizeRepoName('keep.these_chars-ok')).toBe(
      'keep.these_chars-ok'
    );
  });
});

describe('repoNameProblem', () => {
  it('has nothing to say about an empty or ordinary name', () => {
    expect(repoNameProblem('')).toBeNull();
    expect(repoNameProblem('   ')).toBeNull();
    expect(repoNameProblem('client portal')).toBeNull();
    expect(repoNameProblem('invoices')).toBeNull();
  });

  it('refuses the names the server refuses', () => {
    expect(repoNameProblem('..')).toMatch(/dots/);
    expect(repoNameProblem(' . ')).toMatch(/dots/);
    expect(repoNameProblem('site.git')).toMatch(/\.git/);
    expect(repoNameProblem('a'.repeat(101))).toMatch(/100/);
    expect(repoNameProblem('a'.repeat(100))).toBeNull();
  });
});

describe('inviteFailureMessage', () => {
  it('is nothing when every reviewer was added', () => {
    expect(inviteFailureMessage([])).toBeNull();
  });

  it('ends the reason with a full stop when the server did not', () => {
    expect(
      inviteFailureMessage([
        { name: 'Data', reason: 'You must be an admin of this repository' },
      ])
    ).toContain('repository. You can add reviewers');
  });

  it('says who could not be added and what to do', () => {
    expect(
      inviteFailureMessage([{ name: 'Data', reason: 'You must be an admin.' }])
    ).toBe(
      "The repository was created, but Data could not be added as a reviewer. You must be an admin. You can add reviewers in the repository's settings."
    );
    expect(
      inviteFailureMessage([
        { name: 'Data', reason: 'x.' },
        { name: 'Speed', reason: 'y.' },
        { name: 'Security', reason: 'z.' },
      ])
    ).toContain('Data, Speed and Security could not be added as reviewers.');
  });
});

describe('limits', () => {
  it('matches the server', () => {
    expect(DESCRIPTION_MAX).toBe(350);
  });
});
