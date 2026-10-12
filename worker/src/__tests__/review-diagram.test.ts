import { describe, expect, it } from 'vitest';
import { diagramSource, type DiagramSpec } from '../review/diagram';

const empty = {
  entities: [],
  relations: [],
  nodes: [],
  edges: [],
  participants: [],
  messages: [],
};

/** Inputs that broke model-written Mermaid: markers, punctuation, braces, quotes, odd names. */
export const AWKWARD: DiagramSpec[] = [
  {
    ...empty,
    kind: 'er',
    entities: [
      {
        name: 'user_emails',
        attributes: [
          { type: 'text', name: 'id', key: 'PK', change: 'new' },
          {
            type: 'text',
            name: 'verification_token_hash',
            key: 'UK',
            change: 'new',
          },
          {
            type: 'INTEGER NOT NULL',
            name: 'verified_at',
            key: '',
            change: 'new',
          },
          { type: 'text', name: 'user_id', key: 'FK', change: '' },
        ],
      },
      {
        name: 'users (auth)',
        attributes: [{ type: 'text', name: 'id', key: 'PK', change: '' }],
      },
    ],
    relations: [
      {
        from: 'users (auth)',
        to: 'user_emails',
        cardinality: 'one-to-many',
        label: 'owns "alternate" emails',
      },
      {
        from: 'user_emails',
        to: 'missing',
        cardinality: 'one-to-one',
        label: 'dropped',
      },
    ],
  },
  {
    ...empty,
    kind: 'flow',
    nodes: [
      {
        id: 'a',
        label: 'POST /review/flags/{flagId}/approve or request-changes',
        change: 'new',
      },
      { id: 'b', label: 'requireAuth -> requireAdmin [403?]', change: '' },
      {
        id: 'c',
        label: 'GET /{owner}/{repo}/insights?days=30',
        change: 'changed',
      },
      { id: '1 weird id', label: 'say "hi"; end', change: '' },
    ],
    edges: [
      { from: 'a', to: 'b', label: 'yes | no' },
      { from: 'b', to: 'c', label: '' },
      { from: 'c', to: '1 weird id', label: '{done}' },
      { from: 'c', to: 'nowhere', label: 'ignored' },
    ],
  },
];

describe('review diagrams from data', () => {
  it('writes ER and flow Mermaid with every label quoted and unknown references dropped', () => {
    const [er, flow] = AWKWARD.map(diagramSource);
    expect(er).toContain('    text verification_token_hash UK "NEW"');
    expect(er).toContain(
      '  users_auth ||--o{ user_emails : "owns #quot;alternate#quot; emails"'
    );
    expect(er).not.toContain('missing');
    expect(er).toContain('    INTEGER verified_at "NEW"');
    expect(flow).toContain(
      '  n0["POST /review/flags/{flagId}/approve or request-changes (new)"]'
    );
    expect(flow).toContain('  n0 -->|"yes | no"| n1');
    expect(flow).not.toContain('nowhere');
  });

  it('draws nothing from an empty or malformed description', () => {
    expect(diagramSource(null)).toBeNull();
    expect(diagramSource({ kind: 'er', ...empty })).toBeNull();
    expect(
      diagramSource({
        kind: 'flow',
        ...empty,
        nodes: [{ id: 'a', label: 'x', change: '' }],
      })
    ).toBeNull();
    expect(diagramSource({ kind: 'er', entities: 'nope' })).toBeNull();
    expect(
      diagramSource({
        kind: 'sequence',
        ...empty,
        participants: [{ id: 'a', label: 'Agent', change: '' }],
      })
    ).toBeNull();
  });

  it('writes a sequence diagram: participants in order, calls and replies, new calls marked', () => {
    const seq = diagramSource({
      kind: 'sequence',
      ...empty,
      participants: [
        { id: 'agent', label: 'Coding agent', change: '' },
        { id: 'mcp', label: 'POST /mcp; tools', change: '' },
        { id: 'oauth', label: 'OAuth: consent', change: 'new' },
      ],
      messages: [
        {
          from: 'agent',
          to: 'mcp',
          label: 'tools/call #1: approve',
          reply: false,
          change: '',
        },
        {
          from: 'mcp',
          to: 'oauth',
          label: 'is this app a moderator?',
          reply: false,
          change: 'new',
        },
        { from: 'oauth', to: 'mcp', label: 'yes', reply: true, change: 'new' },
        {
          from: 'mcp',
          to: 'nowhere',
          label: 'dropped',
          reply: false,
          change: '',
        },
      ],
    });
    expect(seq).toBe(
      [
        'sequenceDiagram',
        '  participant p0 as Coding agent',
        '  participant p1 as POST /mcp  tools',
        '  participant p2 as OAuth: consent (new)',
        '  p0->>p1: tools/call  1: approve',
        '  p1->>p2: is this app a moderator? (new)',
        '  p2-->>p1: yes (new)',
      ].join('\n')
    );
  });
});
