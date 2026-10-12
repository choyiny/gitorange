/**
 * Review diagrams as data: the model describes entities, a flow, or a sequence of calls, and Mermaid source is
 * written here, so quoting and syntax are always valid.
 */

export type DiagramSpec = {
  kind: 'er' | 'flow' | 'sequence';
  entities: {
    name: string;
    attributes: {
      type: string;
      name: string;
      key: 'PK' | 'FK' | 'UK' | '';
      change: 'new' | 'changed' | '';
    }[];
  }[];
  relations: {
    from: string;
    to: string;
    cardinality: 'one-to-one' | 'one-to-many' | 'many-to-many';
    label: string;
  }[];
  nodes: { id: string; label: string; change: 'new' | 'changed' | '' }[];
  edges: { from: string; to: string; label: string }[];
  /** kind "sequence": who takes part, in order, and the calls between them. */
  participants: { id: string; label: string; change: 'new' | 'changed' | '' }[];
  messages: {
    from: string;
    to: string;
    label: string;
    reply: boolean;
    change: 'new' | 'changed' | '';
  }[];
};

const attribute = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'name', 'key', 'change'],
  properties: {
    type: { type: 'string', maxLength: 30 },
    name: { type: 'string', maxLength: 60 },
    key: { type: 'string', enum: ['PK', 'FK', 'UK', ''] },
    change: { type: 'string', enum: ['new', 'changed', ''] },
  },
};

/** JSON schema for DiagramSpec (strict structured output). */
export const DIAGRAM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'entities',
    'relations',
    'nodes',
    'edges',
    'participants',
    'messages',
  ],
  properties: {
    kind: { type: 'string', enum: ['er', 'flow', 'sequence'] },
    entities: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'attributes'],
        properties: {
          name: { type: 'string', maxLength: 60 },
          attributes: { type: 'array', maxItems: 12, items: attribute },
        },
      },
    },
    relations: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'cardinality', 'label'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          cardinality: {
            type: 'string',
            enum: ['one-to-one', 'one-to-many', 'many-to-many'],
          },
          label: { type: 'string', maxLength: 40 },
        },
      },
    },
    nodes: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'change'],
        properties: {
          id: { type: 'string', maxLength: 30 },
          label: { type: 'string', maxLength: 60 },
          change: { type: 'string', enum: ['new', 'changed', ''] },
        },
      },
    },
    edges: {
      type: 'array',
      maxItems: 14,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'label'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string', maxLength: 40 },
        },
      },
    },
    participants: {
      type: 'array',
      maxItems: 7,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'change'],
        properties: {
          id: { type: 'string', maxLength: 30 },
          label: { type: 'string', maxLength: 40 },
          change: { type: 'string', enum: ['new', 'changed', ''] },
        },
      },
    },
    messages: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['from', 'to', 'label', 'reply', 'change'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string', maxLength: 50 },
          reply: { type: 'boolean' },
          change: { type: 'string', enum: ['new', 'changed', ''] },
        },
      },
    },
  },
} as const;

/** An identifier Mermaid accepts: letters, digits, underscore; never empty or leading digit. */
function ident(s: string, fallback: string): string {
  const id = s.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return !id ? fallback : /^[0-9]/.test(id) ? `_${id}` : id;
}

/** Text inside a double-quoted Mermaid label. */
function quoted(s: string): string {
  return `"${s.replace(/\s+/g, ' ').trim().replace(/"/g, '#quot;')}"`;
}

const CARDINALITY = {
  'one-to-one': '||--||',
  'one-to-many': '||--o{',
  'many-to-many': '}o--o{',
} as const;

function erSource(d: DiagramSpec): string | null {
  const names = new Map<string, string>();
  d.entities.forEach((e, i) => names.set(e.name, ident(e.name, `E${i}`)));
  const lines = ['erDiagram'];
  for (const e of d.entities) {
    lines.push(`  ${names.get(e.name)} {`);
    for (const a of e.attributes) {
      // Type is one word in Mermaid: "INTEGER NOT NULL" → INTEGER.
      const parts = [
        ident(a.type.trim().split(/\s+/)[0] ?? '', 'text'),
        ident(a.name, 'field'),
      ];
      if (a.key) parts.push(a.key);
      if (a.change) parts.push(quoted(a.change === 'new' ? 'NEW' : 'CHANGED'));
      lines.push(`    ${parts.join(' ')}`);
    }
    lines.push('  }');
  }
  for (const r of d.relations) {
    const from = names.get(r.from);
    const to = names.get(r.to);
    if (!from || !to) continue;
    lines.push(
      `  ${from} ${CARDINALITY[r.cardinality] ?? '||--o{'} ${to} : ${quoted(r.label || 'has')}`
    );
  }
  return d.entities.length ? lines.join('\n') : null;
}

function flowSource(d: DiagramSpec): string | null {
  const ids = new Map<string, string>();
  d.nodes.forEach((n, i) => ids.set(n.id, `n${i}`));
  const lines = ['flowchart LR'];
  for (const n of d.nodes) {
    const mark =
      n.change === 'new'
        ? ' (new)'
        : n.change === 'changed'
          ? ' (changed)'
          : '';
    lines.push(`  ${ids.get(n.id)}[${quoted(n.label + mark)}]`);
  }
  for (const e of d.edges) {
    const from = ids.get(e.from);
    const to = ids.get(e.to);
    if (!from || !to) continue;
    lines.push(
      e.label
        ? `  ${from} -->|${quoted(e.label)}| ${to}`
        : `  ${from} --> ${to}`
    );
  }
  return d.nodes.length > 1 ? lines.join('\n') : null;
}

/** Text after a Mermaid sequence arrow: no colon tricks, no newlines. */
function messageText(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[;#]/g, ' ').trim() || 'calls';
}

function sequenceSource(d: DiagramSpec): string | null {
  const ids = new Map<string, string>();
  d.participants.forEach((p, i) => ids.set(p.id, `p${i}`));
  const lines = ['sequenceDiagram'];
  for (const p of d.participants) {
    const mark =
      p.change === 'new'
        ? ' (new)'
        : p.change === 'changed'
          ? ' (changed)'
          : '';
    lines.push(
      `  participant ${ids.get(p.id)} as ${messageText(p.label + mark)}`
    );
  }
  let drawn = 0;
  for (const m of d.messages) {
    const from = ids.get(m.from);
    const to = ids.get(m.to);
    if (!from || !to) continue;
    const mark =
      m.change === 'new'
        ? ' (new)'
        : m.change === 'changed'
          ? ' (changed)'
          : '';
    lines.push(
      `  ${from}${m.reply ? '-->>' : '->>'}${to}: ${messageText(m.label + mark)}`
    );
    drawn++;
  }
  return d.participants.length > 1 && drawn ? lines.join('\n') : null;
}

/** Mermaid source for a model's diagram description, or null when there's nothing to draw. */
export function diagramSource(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<DiagramSpec>;
  const d: DiagramSpec = {
    kind: v.kind === 'er' || v.kind === 'sequence' ? v.kind : 'flow',
    entities: Array.isArray(v.entities) ? v.entities : [],
    relations: Array.isArray(v.relations) ? v.relations : [],
    nodes: Array.isArray(v.nodes) ? v.nodes : [],
    edges: Array.isArray(v.edges) ? v.edges : [],
    participants: Array.isArray(v.participants) ? v.participants : [],
    messages: Array.isArray(v.messages) ? v.messages : [],
  };
  try {
    return d.kind === 'er'
      ? erSource(d)
      : d.kind === 'sequence'
        ? sequenceSource(d)
        : flowSource(d);
  } catch {
    return null;
  }
}
