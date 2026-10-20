import { describe, expect, it } from 'vitest';
import { bumpLabel, isVersion, parseBump } from './versionBump';

describe('bumpLabel', () => {
  it('names the bump, and a missing one as the patch it counts as', () => {
    expect(bumpLabel('major')).toBe('major');
    expect(bumpLabel('minor')).toBe('minor');
    expect(bumpLabel('patch')).toBe('patch');
    expect(bumpLabel(null)).toBe('patch (default)');
  });
});

describe('parseBump', () => {
  it('reads a select value, anything else as none', () => {
    expect(parseBump('minor')).toBe('minor');
    expect(parseBump('')).toBeNull();
    expect(parseBump('huge')).toBeNull();
  });
});

describe('isVersion', () => {
  it('takes plain vX.Y.Z only', () => {
    expect(isVersion('v0.1.0')).toBe(true);
    expect(isVersion(' v12.0.3 ')).toBe(true);
    expect(isVersion('0.1.0')).toBe(false);
    expect(isVersion('v1.0.0-rc.1')).toBe(false);
    expect(isVersion('v1.0')).toBe(false);
    // As the server takes them: no leading zeros, at most 8 digits a part.
    expect(isVersion('v01.0.0')).toBe(false);
    expect(isVersion('v1.00.0')).toBe(false);
    expect(isVersion('v12345678.0.0')).toBe(true);
    expect(isVersion('v123456789.0.0')).toBe(false);
  });
});
