import { describe, expect, it } from 'vitest';
import { installationIdOf, resourceNames, validateName } from '../names.ts';

describe('names', () => {
  it("default name reproduces today's documented names", () => {
    expect(resourceNames('gitorange')).toEqual({
      worker: 'gitorange',
      d1: 'gitorange-db',
      lfs: 'gitorange-lfs',
      actionsLogs: 'gitorange-actions-logs',
      actionsCache: 'gitorange-actions-cache',
      artifacts: 'gitorange',
      actionsWorkflow: 'gitorange-actions-run',
      mergeWorkflow: 'gitorange-merge-resolution',
    });
  });

  it('validateName rejects bad names and accepts good ones', () => {
    for (const bad of ['ab', 'a'.repeat(31), '-x1', 'x1-', 'Git', 'a_b']) {
      expect(validateName(bad), bad).toEqual(expect.any(String));
    }
    expect(validateName('gitorange')).toBeNull();
    expect(validateName('git-1')).toBeNull();
  });

  it('installationIdOf is stable and depends on the hostname', () => {
    const a = installationIdOf('acct', 'gitorange', 'workers.dev');
    expect(a).toMatch(/^gitorange-[0-9a-f]{12}$/);
    expect(installationIdOf('acct', 'gitorange', 'workers.dev')).toBe(a);
    expect(installationIdOf('acct', 'gitorange', 'git.example.com')).not.toBe(
      a
    );
  });
});
