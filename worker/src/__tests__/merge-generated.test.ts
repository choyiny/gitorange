import { describe, expect, it } from 'vitest';
import { generatedMatcher } from '../merge/generated';

describe('generated files are never sent to the model', () => {
  it('matches paths listed in the target branch .orangeignore', () => {
    const generated = generatedMatcher(
      'generated/\n*.pb.go\n!generated/keep.ts\n'
    );
    expect(generated('generated/api.ts')).toBe(true);
    expect(generated('pkg/types.pb.go')).toBe(true);
    expect(generated('generated/keep.ts')).toBe(false);
    expect(generated('src/api.ts')).toBe(false);
  });

  it('matches lockfiles without an .orangeignore', () => {
    const generated = generatedMatcher(null);
    expect(generated('yarn.lock')).toBe(true);
    expect(generated('web/package-lock.json')).toBe(true);
    expect(generated('Cargo.lock')).toBe(true);
    expect(generated('src/lock.ts')).toBe(false);
  });

  it('keeps lockfiles and drizzle metadata generated whatever .orangeignore negates', () => {
    const generated = generatedMatcher(
      '!yarn.lock\n!migrations/meta/0008_snapshot.json\n'
    );
    expect(generated('yarn.lock')).toBe(true);
    expect(generated('migrations/meta/0008_snapshot.json')).toBe(true);
  });

  it('matches drizzle migration snapshots and the journal', () => {
    const generated = generatedMatcher(null);
    expect(generated('migrations/meta/0008_snapshot.json')).toBe(true);
    expect(generated('migrations/meta/_journal.json')).toBe(true);
    expect(generated('db/migrations/meta/0001_snapshot.json')).toBe(true);
    // The SQL migrations themselves are reviewed and merged like any file.
    expect(generated('migrations/0008_add_users.sql')).toBe(false);
    expect(generated('migrations/meta/notes.json')).toBe(false);
  });
});
