import { describe, expect, it } from 'vitest';
import { adminSection, settingsSection } from './siteNav';

describe('settingsSection', () => {
  it('knows the three pages, and the verify link belongs to Emails', () => {
    expect(settingsSection('/settings/tokens')).toBe('tokens');
    expect(settingsSection('/settings/mcp')).toBe('mcp');
    expect(settingsSection('/settings/emails')).toBe('emails');
    expect(settingsSection('/settings/emails/verify')).toBe('emails');
  });
  it('knows nothing else', () => {
    expect(settingsSection('/settings')).toBeNull();
    expect(settingsSection('/settings/emailsx')).toBeNull();
    expect(settingsSection('/admin')).toBeNull();
  });
});

describe('adminSection', () => {
  it('splits /admin into its three sections by fragment', () => {
    expect(adminSection('/admin', '')).toBe('people');
    expect(adminSection('/admin', '#invite')).toBe('people');
    expect(adminSection('/admin', '#setup')).toBe('setup');
    expect(adminSection('/admin', '#settings')).toBe('settings');
  });
  it('gives each other page its own entry', () => {
    expect(adminSection('/admin/usage', '')).toBe('usage');
    expect(adminSection('/admin/audit', '')).toBe('audit');
    expect(adminSection('/admin/agents', '')).toBe('agents');
  });
  it('does not count the public Agents directory as Site admin', () => {
    expect(adminSection('/agents', '')).toBeNull();
    expect(adminSection('/agents/new', '')).toBeNull();
  });
  it('is not the Site admin outside it', () => {
    expect(adminSection('/settings/tokens', '')).toBeNull();
    expect(adminSection('/', '')).toBeNull();
  });
});
