import { describe, expect, it } from 'vitest';
import {
  AGENT_PALETTE,
  agentColor,
  agentRoundness,
  agentState,
  avatarScript,
  avatarState,
  STATE_LOOK,
} from './agentLook';

describe('agentColor', () => {
  it('uses the colour the agent declares', () => {
    expect(agentColor('securityagent', '#123456')).toBe('#123456');
    expect(agentColor('someone', '#ABCDEF')).toBe('#ABCDEF');
  });

  it('ignores a declared colour that is not a hex colour', () => {
    expect(agentColor('securityagent', 'red')).toBe('#2a78d6');
    expect(agentColor('securityagent', 'url(x)')).toBe('#2a78d6');
    expect(agentColor('securityagent', null)).toBe('#2a78d6');
    expect(agentColor('securityagent', '')).toBe('#2a78d6');
  });

  it('gives the built-ins and the presets their palette colours', () => {
    expect(agentColor('clef')).toBe('#e26a17');
    expect(agentColor('fixer')).toBe('#e34948');
    expect(agentColor('securityagent')).toBe('#2a78d6');
    expect(agentColor('dataagent')).toBe('#199e70');
    expect(agentColor('speedagent')).toBe('#c98500');
    expect(agentColor('featureagent')).toBe('#d55181');
    expect(agentColor('featuresagent')).toBe('#d55181');
    expect(agentColor('reliabilityagent')).toBe('#008300');
    expect(agentColor('privacyagent')).toBe('#6b5cc9');
    expect(agentColor('shippingagent')).toBe('#55606e');
  });

  it('accepts a handle written with @ or capitals', () => {
    expect(agentColor('@SecurityAgent')).toBe('#2a78d6');
  });

  it('hashes any other handle into the palette, stably', () => {
    const c = agentColor('billingbot');
    expect(AGENT_PALETTE).toContain(c);
    expect(agentColor('billingbot')).toBe(c);
    const spread = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map((h) =>
        agentColor(h + 'bot')
      )
    );
    expect(spread.size).toBeGreaterThan(1);
  });
});

describe('agentRoundness', () => {
  it('gives each preset its head shape, 50 for anyone else', () => {
    expect(agentRoundness('clef')).toBe(100);
    expect(agentRoundness('securityagent')).toBe(15);
    expect(agentRoundness('shippingagent')).toBe(5);
    expect(agentRoundness('billingbot')).toBe(50);
  });
});

describe('agentState', () => {
  it('reads reviewer statuses as crew states', () => {
    expect(agentState('approved')).toBe('clear');
    expect(agentState('flagged')).toBe('needs');
    expect(agentState('changes_requested')).toBe('asked');
    expect(agentState('reviewing')).toBe('reviewing');
    expect(agentState('not_needed')).toBe('skipped');
    expect(agentState('failed')).toBe('failed');
    expect(agentState('needs')).toBe('needs');
    expect(agentState('running')).toBe('running');
    expect(agentState('learned')).toBe('learned');
    expect(agentState('off')).toBe('off');
    expect(agentState('idle')).toBe('idle');
  });

  it('labels every state in words, so colour is never the only signal', () => {
    expect(STATE_LOOK.clear).toEqual({ label: 'Passed', tone: 'good' });
    expect(STATE_LOOK.needs).toEqual({ label: 'Needs a person', tone: 'warn' });
    expect(STATE_LOOK.asked).toEqual({
      label: 'Changes requested',
      tone: 'serious',
    });
    for (const look of Object.values(STATE_LOOK))
      expect(look.label).toMatch(/^[A-Z][a-z ]+$/);
  });
});

describe('avatarState (the spec mapping)', () => {
  it('clear → success', () => {
    expect(avatarState('approved')).toBe('success');
  });
  it('needs → input (held)', () => {
    expect(avatarState('flagged')).toBe('input');
    expect(avatarState('needs')).toBe('input');
    expect(avatarScript('input')).toEqual({ hold: 'input' });
  });
  it('asked → send', () => {
    expect(avatarState('changes_requested')).toBe('send');
    expect(avatarScript('send')).toEqual({ play: ['send'] });
  });
  it('reviewing → inspect', () => {
    expect(avatarState('reviewing')).toBe('inspect');
    expect(avatarScript('inspect')).toEqual({ play: ['inspect'] });
  });
  it('running → startWaiting', () => {
    expect(avatarState('running')).toBe('startWaiting');
    expect(avatarScript('startWaiting')).toEqual({ hold: 'waiting' });
  });
  it('learned → surprise, then send', () => {
    expect(avatarState('learned')).toBe('surprise');
    expect(avatarScript('surprise')).toEqual({ play: ['surprise', 'send'] });
  });
  it('off and skipped → sleep', () => {
    expect(avatarState('off')).toBe('sleep');
    expect(avatarState('not_needed')).toBe('sleep');
    expect(avatarScript('sleep')).toEqual({ sleep: true });
  });
  it('idle → idle', () => {
    expect(avatarState('idle')).toBe('idle');
    expect(avatarScript('idle')).toEqual({});
  });
  it('a failed review shows the system-error face', () => {
    expect(avatarState('failed')).toBe('error');
    expect(avatarScript('error')).toEqual({ play: ['error'] });
  });
  it('success plays once', () => {
    expect(avatarScript('success')).toEqual({ play: ['success'] });
  });
});
