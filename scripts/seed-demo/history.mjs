// What the demo repository's history looks like: the commits on main, the eight pull requests already merged, the six
// still open, and what the reviewer agents said about each. Pure data: seed-demo.mjs turns it into git commits, pull
// requests and database rows.
//
// Times are `{ d: daysAgo, h: hourUtc, m: minute }` or `{ ago: hoursAgo }`; the script resolves them against the moment
// it runs (and never puts one in the future).
//
// Changes to files are `ops`: `write` (whole files), `edit` ([from, to] replacements that must match exactly once) and
// `append`. A file that is not an op comes from `fixture/` (base commits only).

export const REPO = {
  name: 'invoices',
  description: 'A small invoicing service for a one-person consultancy.',
  createdAt: { d: 10, h: 13, m: 0 },
};

export const TEAMMATE = {
  username: 'cho',
  name: 'Cho Yin',
  email: 'cho@example.test',
  joinedAt: { d: 10, h: 12, m: 30 },
};

/** The four reviewers invited to the repository (preset handles), and when they were invited. */
export const INVITED = [
  'securityagent',
  'dataagent',
  'featuresagent',
  'shippingagent',
];
export const AGENTS_ADDED = { d: 9, h: 10, m: 0 };

export const BASE_COMMITS = [
  {
    at: { d: 10, h: 14, m: 5 },
    message: 'Start the invoicing app',
    files: [
      'package.json',
      'README.md',
      'src/invoices.ts',
      'migrations/0001_invoices.sql',
    ],
  },
  {
    at: { d: 10, h: 19, m: 40 },
    message: 'Add currency formatting',
    files: ['src/currency.ts'],
  },
  {
    at: { d: 9, h: 13, m: 15 },
    message: 'Add the invoice API and run tests on main',
    files: ['src/api/routes.ts', '.github/workflows/test.yml'],
  },
];

const ENDS_MONEY =
  'Amounts are stored as whole cents. Every invoice so far is in Canadian dollars.';

// ── Pull requests that are already merged ────────────────────────────────────
// Landed one after another through the merge API, each a fast-forward of main. `approver` approves, `merger` presses
// merge; `auto` marks it as merged by GitOrange on its own (set afterwards: the API always records a person).

export const MERGED = [
  {
    branch: 'claude/s1-line-items',
    title: 'Add line items to invoices',
    body: 'An invoice can now list what it is for: a description, a quantity and a price per unit.\n\nOnly the table and the types are here; the API comes next.',
    author: 'admin',
    via: 'Claude Code',
    session: 's1',
    request:
      'Invoices need line items: a description, a quantity and a price per unit.',
    commits: [
      {
        at: { d: 9, h: 14, m: 20 },
        message: 'Add line items to invoices',
        ops: {
          write: {
            'migrations/0002_line_items.sql': `CREATE TABLE line_items (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices (id),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_cents INTEGER NOT NULL
);
`,
            'src/invoices.test.ts': `import { describe, expect, it } from 'vitest';
import { lineTotal } from './invoices';

describe('lineTotal', () => {
  it('multiplies the quantity by the unit price', () => {
    const item = { invoiceId: 1, description: 'Hours', quantity: 3, unitCents: 12_500 };
    expect(lineTotal(item)).toBe(37_500);
  });
});
`,
          },
          append: {
            'src/invoices.ts': `
export interface LineItem {
  invoiceId: number;
  description: string;
  quantity: number;
  unitCents: number;
}

export function lineTotal(item: LineItem): number {
  return item.quantity * item.unitCents;
}
`,
          },
        },
      },
    ],
    openedAt: { d: 9, h: 14, m: 35 },
    approvedAt: { d: 9, h: 16, m: 5 },
    mergedAt: { d: 9, h: 16, m: 20 },
    approver: 'cho',
    merger: 'admin',
    auto: false,
    keepBranch: false,
    summaries: {
      'migrations/0002_line_items.sql':
        'Creates the line_items table, one row per line on an invoice.',
      'src/invoices.ts':
        'Adds the LineItem type and a helper that multiplies quantity by unit price.',
      'src/invoices.test.ts': 'Tests lineTotal.',
    },
    review: {
      durationMs: 41_000,
      at: { d: 9, h: 14, m: 38 },
      agents: [
        {
          agent: 'dataagent',
          status: 'changes_requested',
          p: 0.94,
          summary: 'A new table; one lookup column has no index.',
          flags: [
            {
              kind: 'change_requested',
              title: 'Index line_items by invoice',
              detail:
                'Line items are always read by invoice_id, which has no index, so every read scans the table.',
              changes: [
                [
                  'Lookup by invoice_id',
                  'no such table',
                  'full scan of line_items',
                ],
              ],
              paths: ['migrations/0002_line_items.sql'],
              snippet: {
                path: 'migrations/0002_line_items.sql',
                find: 'invoice_id INTEGER',
                lines: 1,
                why: 'read by this column',
              },
              decision: {
                kind: 'dismiss',
                by: 'admin',
                at: { d: 9, h: 15, m: 50 },
                teach:
                  'Tables under a few thousand rows do not need an index yet.',
              },
            },
          ],
        },
      ],
    },
  },
  {
    branch: 'codex/s1-money-format',
    title: 'Format amounts with thousands separators',
    body: '$1234.50 now reads $1,234.50 everywhere an amount is shown.',
    author: 'admin',
    via: 'Codex',
    session: 's1',
    request: 'Money shows as $1234.50. Add the thousands separator.',
    commits: [
      {
        at: { d: 8, h: 14, m: 0 },
        message: 'Format amounts with thousands separators',
        ops: {
          edit: {
            'src/currency.ts': [
              [
                '  const dollars = (Math.abs(cents) / 100).toFixed(2);',
                `  const dollars = (Math.abs(cents) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });`,
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 8, h: 14, m: 12 },
    approvedAt: { d: 8, h: 16, m: 40 },
    mergedAt: { d: 8, h: 16, m: 55 },
    approver: 'cho',
    merger: 'cho',
    auto: false,
    keepBranch: false,
    summaries: {
      'src/currency.ts':
        'Formats amounts with a thousands separator and always two decimals.',
    },
    review: {
      durationMs: 29_000,
      at: { d: 8, h: 14, m: 15 },
      agents: [
        {
          agent: 'featuresagent',
          status: 'approved',
          p: 0.62,
          summary:
            'Only how amounts are written changes; no field is added or removed.',
          flags: [],
        },
      ],
    },
  },
  {
    branch: 'cho/payment-status',
    title: 'Show whether an invoice has been paid',
    body: 'Adds a paid_on date to every invoice. An invoice with no date is unpaid.',
    author: 'cho',
    via: null,
    session: null,
    request: null,
    commits: [
      {
        at: { d: 7, h: 15, m: 5 },
        message: 'Show whether an invoice has been paid',
        ops: {
          write: {
            'migrations/0003_paid_on.sql':
              'ALTER TABLE invoices ADD COLUMN paid_on TEXT;\n',
          },
          edit: {
            'src/invoices.ts': [
              [
                '  amountCents: number;\n}\n\nexport function invoiceNumber',
                '  amountCents: number;\n  paidOn: string | null;\n}\n\nexport function invoiceNumber',
              ],
              [
                '    amountCents,\n  };',
                '    amountCents,\n    paidOn: null,\n  };',
              ],
            ],
          },
          append: {
            'src/invoices.ts': `
export function isPaid(invoice: Invoice): boolean {
  return invoice.paidOn !== null;
}
`,
          },
        },
      },
    ],
    openedAt: { d: 7, h: 15, m: 20 },
    approvedAt: { d: 7, h: 17, m: 30 },
    mergedAt: { d: 7, h: 17, m: 45 },
    approver: 'admin',
    merger: 'admin',
    auto: false,
    keepBranch: false,
    summaries: {
      'migrations/0003_paid_on.sql':
        'Adds a nullable paid_on column to invoices.',
      'src/invoices.ts':
        'Adds paidOn to the Invoice type and an isPaid helper.',
    },
    review: {
      durationMs: 52_000,
      at: { d: 7, h: 15, m: 24 },
      agents: [
        {
          agent: 'dataagent',
          status: 'flagged',
          p: 0.97,
          summary:
            'A new column; every invoice sent so far will read as unpaid.',
          flags: [
            {
              kind: 'needs_person',
              title: 'Existing invoices count as unpaid',
              detail:
                'Every invoice already in the database gets no paid date, so all of them show as unpaid until someone records a payment.',
              question:
                'Should every invoice sent before today show as unpaid?',
              changes: [
                [
                  'paid_on on existing invoices',
                  'not tracked',
                  'empty, so unpaid',
                ],
              ],
              paths: ['migrations/0003_paid_on.sql'],
              snippet: {
                path: 'migrations/0003_paid_on.sql',
                find: 'ALTER TABLE',
                lines: 1,
                why: 'old rows get no value',
              },
              decision: {
                kind: 'approve',
                by: 'admin',
                at: { d: 7, h: 17, m: 25 },
                reason:
                  'Yes. Nothing was recorded as paid before this, so unpaid is right.',
              },
            },
          ],
        },
        {
          agent: 'featuresagent',
          status: 'approved',
          p: 0.55,
          summary: 'Adds a field to invoices; nothing existing changes.',
          flags: [],
        },
      ],
    },
  },
  {
    branch: 'rebase-merging',
    title: 'Number new invoices after the highest existing number',
    body: 'Invoice numbers repeated after one was deleted, because the next number was the list length plus one. It is now the highest id plus one.',
    author: 'admin',
    via: 'Claude Code',
    session: 's2',
    request: 'Invoice numbers repeat after I delete one. Fix it.',
    commits: [
      {
        at: { d: 6, h: 14, m: 10 },
        message: 'Number new invoices after the highest existing number',
        ops: {
          edit: {
            'src/api/routes.ts': [
              [
                'export async function createInvoice(request: Request): Promise<Response> {',
                `function nextSequence(): number {
  return invoices.reduce((max, i) => Math.max(max, i.id), 0) + 1;
}

export async function createInvoice(request: Request): Promise<Response> {`,
              ],
              [
                '    invoices.length + 1,\n    body.customer,',
                '    nextSequence(),\n    body.customer,',
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 6, h: 14, m: 25 },
    approvedAt: { d: 6, h: 18, m: 0 },
    mergedAt: { d: 6, h: 18, m: 15 },
    approver: 'cho',
    merger: 'admin',
    auto: false,
    keepBranch: true,
    summaries: {
      'src/api/routes.ts':
        'New invoices are numbered after the highest id, not the length of the list.',
    },
    review: {
      durationMs: 34_000,
      at: { d: 6, h: 14, m: 28 },
      agents: [
        {
          agent: 'dataagent',
          status: 'approved',
          p: 0.41,
          summary: 'No schema change; only how the next number is picked.',
          flags: [],
        },
      ],
    },
  },
  {
    branch: 'claude/s3-invoice-notes',
    title: 'Let an invoice carry a note for the customer',
    body: 'An invoice can have a note of up to 500 characters, printed under the total.',
    author: 'admin',
    via: 'Claude Code',
    session: 's3',
    request: 'Let me put a short note on an invoice for the customer.',
    commits: [
      {
        at: { d: 5, h: 13, m: 30 },
        message: 'Add a note to each invoice',
        ops: {
          write: {
            'migrations/0004_notes.sql':
              'ALTER TABLE invoices ADD COLUMN note TEXT;\n',
          },
          edit: {
            'src/invoices.ts': [
              [
                '  paidOn: string | null;\n}',
                '  paidOn: string | null;\n  note: string | null;\n}',
              ],
              [
                '    paidOn: null,\n  };',
                '    paidOn: null,\n    note: null,\n  };',
              ],
            ],
          },
        },
      },
      {
        at: { d: 5, h: 15, m: 0 },
        message: 'Trim notes and limit them to 500 characters',
        ops: {
          write: {
            'src/notes.ts': `// A note is what the customer reads at the bottom of their invoice.
export const NOTE_LIMIT = 500;

export function cleanNote(text: string | null | undefined): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  return trimmed.slice(0, NOTE_LIMIT);
}
`,
          },
          edit: {
            'README.md': [
              [
                '## Money',
                '## Notes\n\nAn invoice can carry a note of up to 500 characters. It is printed under the total.\n\n## Money',
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 5, h: 15, m: 12 },
    approvedAt: { d: 5, h: 17, m: 20 },
    mergedAt: { d: 5, h: 17, m: 30 },
    approver: 'cho',
    merger: 'admin',
    auto: true,
    keepBranch: false,
    summaries: {
      'migrations/0004_notes.sql': 'Adds a nullable note column to invoices.',
      'src/invoices.ts':
        'Adds note to the Invoice type, empty for a new invoice.',
      'src/notes.ts': 'Trims a note and cuts it to 500 characters.',
      'README.md': 'Documents notes.',
    },
    review: {
      durationMs: 47_000,
      at: { d: 5, h: 15, m: 15 },
      agents: [
        {
          agent: 'securityagent',
          status: 'flagged',
          p: 0.71,
          summary:
            'Customer-visible text is new; it matters whether it can carry markup.',
          flags: [
            {
              kind: 'needs_person',
              title: 'Notes are printed on the invoice',
              detail:
                'Whatever is typed in a note is shown to the customer, so a note containing HTML could change how the invoice looks or run in their browser.',
              question: 'Are notes plain text only?',
              changes: [
                ['Note text', 'not stored', 'stored and shown to the customer'],
              ],
              paths: ['src/notes.ts', 'migrations/0004_notes.sql'],
              snippet: {
                path: 'src/notes.ts',
                find: 'export function cleanNote',
                lines: 5,
                why: 'trims, but does not escape',
              },
              decision: {
                kind: 'approve',
                by: 'admin',
                at: { d: 5, h: 17, m: 10 },
                reason: 'Plain text only. The printed invoice escapes it.',
              },
            },
          ],
        },
        {
          agent: 'dataagent',
          status: 'approved',
          p: 0.88,
          summary: 'A nullable column; old invoices read exactly as before.',
          flags: [],
        },
      ],
    },
  },
  {
    branch: 'stack-tree',
    title: 'Group the invoice list by customer',
    body: 'The list now also returns a subtotal for each customer.',
    author: 'admin',
    via: 'Codex',
    session: 's3',
    request: 'Show the invoice list grouped by customer with a subtotal each.',
    commits: [
      {
        at: { d: 4, h: 13, m: 0 },
        message: 'Group the invoice list by customer',
        ops: {
          append: {
            'src/invoices.ts': `
export function groupByCustomer(invoices: Invoice[]): Map<string, Invoice[]> {
  const groups = new Map<string, Invoice[]>();
  for (const invoice of invoices) {
    const list = groups.get(invoice.customer) ?? [];
    list.push(invoice);
    groups.set(invoice.customer, list);
  }
  return groups;
}
`,
          },
          edit: {
            'src/api/routes.ts': [
              [
                "import { newInvoice, total, type Invoice } from '../invoices';",
                "import {\n  groupByCustomer,\n  newInvoice,\n  total,\n  type Invoice,\n} from '../invoices';",
              ],
              [
                '    total: formatMoney(total(invoices)),\n  });',
                `    total: formatMoney(total(invoices)),
    byCustomer: Object.fromEntries(
      [...groupByCustomer(invoices)].map(([customer, list]) => [
        customer,
        formatMoney(total(list)),
      ])
    ),
  });`,
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 4, h: 13, m: 15 },
    approvedAt: { d: 4, h: 17, m: 50 },
    mergedAt: { d: 4, h: 18, m: 5 },
    approver: 'cho',
    merger: 'cho',
    auto: false,
    keepBranch: true,
    summaries: {
      'src/invoices.ts':
        'Adds groupByCustomer, which collects invoices into one list per customer.',
      'src/api/routes.ts': 'The list response gains a byCustomer subtotal.',
    },
    review: {
      durationMs: 38_000,
      at: { d: 4, h: 13, m: 18 },
      agents: [
        {
          agent: 'featuresagent',
          status: 'flagged',
          p: 0.69,
          summary:
            'The list gains a field that shows each customer’s subtotal.',
          flags: [
            {
              kind: 'needs_person',
              title: 'The list now shows what each customer has been invoiced',
              detail:
                'The list response gains a byCustomer total, so anything that can read the list sees what each customer has been invoiced.',
              question:
                'Is it fine for the list to show what each customer has been invoiced?',
              changes: [
                [
                  'byCustomer on the list',
                  'not in the response',
                  'a subtotal for each customer',
                ],
              ],
              paths: ['src/api/routes.ts'],
              snippet: {
                path: 'src/api/routes.ts',
                find: 'byCustomer: Object.fromEntries',
                lines: 6,
                why: 'the new field',
              },
              decision: {
                kind: 'approve',
                by: 'cho',
                at: { d: 4, h: 16, m: 40 },
              },
            },
          ],
        },
      ],
    },
  },
  {
    branch: 'codex/s4-overdue-flag',
    title: 'Flag invoices that are past their due date',
    body: 'Each invoice in the list now says whether it is overdue: unpaid, and past its due date.',
    author: 'admin',
    via: 'Codex',
    session: 's4',
    request: 'Mark invoices that are late so I can chase them.',
    commits: [
      {
        at: { d: 3, h: 14, m: 20 },
        message: 'Flag invoices that are past their due date',
        ops: {
          append: {
            'src/invoices.ts': `
export function isOverdue(invoice: Invoice, today = new Date()): boolean {
  return !isPaid(invoice) && invoice.dueOn < today.toISOString().slice(0, 10);
}
`,
          },
          edit: {
            'src/api/routes.ts': [
              [
                '  groupByCustomer,\n  newInvoice,',
                '  groupByCustomer,\n  isOverdue,\n  newInvoice,',
              ],
              [
                '      amount: formatMoney(i.amountCents),\n    })),',
                '      amount: formatMoney(i.amountCents),\n      overdue: isOverdue(i),\n    })),',
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 3, h: 14, m: 32 },
    approvedAt: { d: 3, h: 16, m: 10 },
    mergedAt: { d: 3, h: 16, m: 20 },
    approver: 'cho',
    merger: 'admin',
    auto: true,
    keepBranch: false,
    summaries: {
      'src/invoices.ts': 'Adds isOverdue: unpaid and past the due date.',
      'src/api/routes.ts': 'Each invoice in the list carries an overdue flag.',
    },
    review: {
      durationMs: 36_000,
      at: { d: 3, h: 14, m: 36 },
      agents: [
        {
          agent: 'featuresagent',
          status: 'changes_requested',
          p: 0.83,
          summary: 'A new field is added to the list response.',
          flags: [
            {
              kind: 'change_requested',
              title: 'New overdue field in the list response',
              detail:
                'The list now returns an overdue flag on every invoice, which anything reading the list will see.',
              changes: [
                [
                  'overdue on each invoice',
                  'not in the response',
                  'true or false',
                ],
              ],
              paths: ['src/api/routes.ts'],
              snippet: {
                path: 'src/api/routes.ts',
                find: 'overdue: isOverdue',
                lines: 1,
                why: 'new field',
              },
              decision: {
                kind: 'dismiss',
                by: 'cho',
                at: { d: 3, h: 15, m: 55 },
                teach: 'Adding a field to a response is not a breaking change.',
              },
            },
          ],
        },
      ],
    },
  },
  {
    branch: 'faster-conflict-resolution',
    title: 'Speed up loading the invoice list',
    body: 'Adds an index on customer and a short-lived cache for slow lookups.',
    author: 'admin',
    via: 'Claude Code',
    session: 's5',
    request:
      'The invoice list is slow now that I have a few thousand. Speed it up.',
    commits: [
      {
        at: { d: 2, h: 13, m: 45 },
        message: 'Index invoices by customer and cache the list',
        ops: {
          write: {
            'migrations/0005_customer_index.sql':
              'CREATE INDEX invoices_customer_idx ON invoices (customer);\n',
            'src/cache.ts': `// Keeps an answer for a few seconds so the list doesn't recompute on every request.
export function memoizeFor<T>(ms: number, compute: () => T): () => T {
  let value: T | undefined;
  let expires = 0;
  return () => {
    const now = Date.now();
    if (value === undefined || now >= expires) {
      value = compute();
      expires = now + ms;
    }
    return value;
  };
}
`,
          },
        },
      },
    ],
    openedAt: { d: 2, h: 14, m: 0 },
    approvedAt: { d: 2, h: 16, m: 40 },
    mergedAt: { d: 2, h: 16, m: 50 },
    approver: 'cho',
    merger: 'cho',
    auto: true,
    keepBranch: true,
    summaries: {
      'migrations/0005_customer_index.sql':
        'Adds an index on invoices.customer.',
      'src/cache.ts':
        'Adds memoizeFor, which keeps a computed answer for a number of milliseconds.',
    },
    review: {
      durationMs: 44_000,
      at: { d: 2, h: 14, m: 4 },
      agents: [
        {
          agent: 'dataagent',
          status: 'approved',
          p: 0.9,
          summary: 'An index only; no rows change.',
          flags: [],
        },
        {
          agent: 'shippingagent',
          status: 'flagged',
          p: 0.76,
          summary: 'A migration has to run before the new code goes live.',
          flags: [
            {
              kind: 'needs_person',
              title: 'Run the index migration before deploying',
              detail:
                'The new index only exists once migration 0005 has run, so it must be applied before the release goes out.',
              question: 'Will the index migration run before this goes live?',
              changes: [
                [
                  'Migration 0005',
                  'not applied',
                  'must be applied before deploy',
                ],
              ],
              paths: ['migrations/0005_customer_index.sql'],
              snippet: {
                path: 'migrations/0005_customer_index.sql',
                find: 'CREATE INDEX',
                lines: 1,
                why: 'needs to run first',
              },
              decision: {
                kind: 'approve',
                by: 'cho',
                at: { d: 2, h: 16, m: 30 },
                reason: 'The deploy script runs migrations first.',
              },
            },
          ],
        },
      ],
    },
  },
];

// ── Pull requests still open ─────────────────────────────────────────────────
// Opened in this order, so their numbers follow it (after the eight merged ones). All of them branch from main as it
// is after the last merge, so none needs a rebase; `claude/s4-invoice-pdf` branches from `claude/s4-usd-invoices`.

export const OPEN = [
  {
    key: 'live-token',
    branch: 'codex/s2-live-token',
    title: 'Refresh the live-update token before it expires',
    body: 'The live page kept a token that ran out after a while, and stopped updating. It now asks for a new token a minute before the old one expires.\n\nThe lifetime is `LIVE_TOKEN_TTL_SECONDS` (900 by default).',
    author: 'admin',
    via: 'Codex',
    session: 's2',
    request:
      'The live page stops updating after a while. Refresh the token before it runs out.',
    commits: [
      {
        at: { d: 2, h: 18, m: 30 },
        message: 'Refresh the live-update token before it expires',
        ops: {
          write: {
            'src/live.ts': `// Live updates: the page keeps a short-lived token and asks for a new one before it runs out.
const REFRESH_MARGIN_SECONDS = 60;

export interface LiveToken {
  value: string;
  expiresAt: number;
}

export function ttlSeconds(env: { LIVE_TOKEN_TTL_SECONDS?: string }): number {
  return Number(env.LIVE_TOKEN_TTL_SECONDS ?? 900);
}

export function needsRefresh(token: LiveToken, now = Date.now()): boolean {
  return token.expiresAt - now < REFRESH_MARGIN_SECONDS * 1000;
}

export async function currentToken(
  token: LiveToken | null,
  fetchToken: () => Promise<LiveToken>
): Promise<LiveToken> {
  if (token && !needsRefresh(token)) return token;
  return fetchToken();
}
`,
          },
          edit: {
            'README.md': [
              [
                '## Money',
                '## Live updates\n\nThe page asks for a new live token a minute before the old one expires. Set\n`LIVE_TOKEN_TTL_SECONDS` to change how long a token lasts (default 900).\n\n## Money',
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 2, h: 18, m: 45 },
    updatedAt: { d: 1, h: 15, m: 22 },
    summaries: {
      'src/live.ts':
        'Adds a live token that is refreshed a minute before it expires.',
      'README.md': 'Documents the LIVE_TOKEN_TTL_SECONDS setting.',
    },
    review: {
      durationMs: 58_000,
      at: { d: 2, h: 18, m: 50 },
      agents: [
        {
          agent: 'featuresagent',
          status: 'approved',
          p: 0.52,
          summary: 'A new module; nothing existing is changed.',
          flags: [],
        },
        {
          agent: 'shippingagent',
          status: 'flagged',
          p: 0.81,
          summary: 'Reads a new setting that has to exist in production.',
          flags: [
            {
              kind: 'needs_person',
              title: 'New setting LIVE_TOKEN_TTL_SECONDS',
              detail:
                'The change reads LIVE_TOKEN_TTL_SECONDS, which production may not have set.',
              question: 'Is LIVE_TOKEN_TTL_SECONDS set in production?',
              changes: [
                [
                  'LIVE_TOKEN_TTL_SECONDS',
                  'not read',
                  'read, 900 when missing',
                ],
              ],
              paths: ['src/live.ts', 'README.md'],
              snippet: {
                path: 'src/live.ts',
                find: 'export function ttlSeconds',
                lines: 3,
                why: 'reads the new setting',
              },
              decision: {
                kind: 'approve',
                by: 'admin',
                via: 'GitOrange AI',
                at: { d: 1, h: 15, m: 20 },
                reason:
                  'The setting falls back to 900 seconds, so production keeps working without a value.',
              },
            },
          ],
        },
      ],
    },
    check: 'running',
  },
  {
    key: 'usd',
    branch: 'claude/s4-usd-invoices',
    title: 'Support invoices in US dollars',
    body: 'Invoices can now be in Canadian or US dollars. The currency is stored on each invoice, and the list shows it.\n\nExisting invoices get CAD.',
    author: 'admin',
    via: 'Claude Code',
    session: 's4',
    request:
      'Make invoices work in US dollars too. Some of my clients pay in USD.',
    commits: [
      {
        at: { d: 2, h: 20, m: 10 },
        message: 'Store the currency on each invoice',
        ops: {
          write: {
            'migrations/0006_invoice_currency.sql':
              "ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL DEFAULT 'CAD';\n",
          },
          edit: {
            'src/invoices.ts': [
              [
                '// Invoices: the shape we store, and the arithmetic on it.\n',
                "import type { Currency } from './currency';\n\n// Invoices: the shape we store, and the arithmetic on it.\n",
              ],
              [
                '  note: string | null;\n}',
                '  note: string | null;\n  currency: Currency;\n}',
              ],
              [
                '  termsDays = 30\n): Invoice {',
                "  termsDays = 30,\n  currency: Currency = 'CAD'\n): Invoice {",
              ],
              ['    note: null,\n  };', '    note: null,\n    currency,\n  };'],
            ],
          },
        },
      },
      {
        at: { d: 2, h: 20, m: 55 },
        message: "Format amounts in the invoice's own currency",
        ops: {
          write: {
            'src/currency.ts': `// Money is whole cents, in one currency per invoice.
export type Currency = 'CAD' | 'USD';

const SYMBOL: Record<Currency, string> = { CAD: 'CA$', USD: 'US$' };

export function formatMoney(cents: number, currency: Currency = 'CAD'): string {
  const sign = cents < 0 ? '-' : '';
  const amount = (Math.abs(cents) / 100).toLocaleString('en-CA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return \`\${sign}\${SYMBOL[currency]}\${amount}\`;
}

export function parseMoney(text: string): number {
  const cleaned = text.replace(/[^0-9.-]/g, '');
  return Math.round(Number.parseFloat(cleaned) * 100);
}
`,
          },
          edit: {
            'src/api/routes.ts': [
              [
                '      amount: formatMoney(i.amountCents),\n      overdue',
                '      amount: formatMoney(i.amountCents, i.currency),\n      overdue',
              ],
            ],
            'README.md': [
              [
                ENDS_MONEY,
                'Amounts are stored as whole cents. An invoice is in Canadian or US dollars, and a new one is in Canadian dollars unless you say otherwise.',
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 2, h: 21, m: 5 },
    updatedAt: { d: 1, h: 9, m: 10 },
    summaries: {
      'migrations/0006_invoice_currency.sql':
        'Adds a currency column to invoices, CAD on every existing row.',
      'src/invoices.ts':
        'Adds currency to the Invoice type and to newInvoice (CAD by default).',
      'src/currency.ts':
        'Formats amounts with CA$ or US$ depending on the invoice currency.',
      'src/api/routes.ts': 'The list formats each amount in its own currency.',
      'README.md': 'Describes the two currencies.',
    },
    review: {
      durationMs: 63_000,
      at: { d: 2, h: 21, m: 10 },
      agents: [
        {
          agent: 'dataagent',
          status: 'flagged',
          p: 0.98,
          summary:
            'A new column; every existing invoice will be marked Canadian dollars.',
          flags: [
            {
              kind: 'needs_person',
              title: 'Existing invoices become Canadian dollars',
              detail:
                'Every invoice already in the database gets the currency CAD, so any that were in another currency would now read wrongly.',
              question: 'Were all your invoices so far in Canadian dollars?',
              changes: [
                [
                  'currency on existing invoices',
                  'not stored',
                  'CAD on every row',
                ],
                ['currency on new invoices', 'always dollars', 'CAD or USD'],
              ],
              paths: [
                'migrations/0006_invoice_currency.sql',
                'src/currency.ts',
              ],
              snippet: {
                path: 'migrations/0006_invoice_currency.sql',
                find: 'ALTER TABLE',
                lines: 1,
                why: 'the default applies to old rows',
              },
            },
          ],
        },
        {
          agent: 'securityagent',
          status: 'approved',
          p: 0.46,
          summary:
            'The currency is a fixed pair of values; nothing from a request reaches SQL or HTML.',
          flags: [],
        },
        {
          agent: 'featuresagent',
          status: 'approved',
          p: 0.64,
          summary:
            'Amounts now read CA$ instead of $, which is intended by the description.',
          flags: [],
        },
      ],
    },
    check: 'success',
  },
  {
    key: 'pdf',
    branch: 'claude/s4-invoice-pdf',
    title: 'Download an invoice as a PDF',
    body: 'Adds `GET /invoices/:id/pdf`, a one-page PDF of an invoice.\n\nBuilds on the US dollar change, so it prints the invoice currency.',
    author: 'admin',
    via: 'Claude Code',
    session: 's4',
    request: 'Let me download an invoice as a PDF to email to a customer.',
    stackedOn: 'usd',
    commits: [
      {
        at: { d: 1, h: 9, m: 20 },
        message: 'Add a PDF download for each invoice',
        ops: {
          write: {
            'src/pdf.ts': `import { formatMoney } from './currency';
import type { Invoice } from './invoices';

// A one-page invoice as a plain PDF: no fonts or images to embed, so the file stays small.
export function renderInvoicePdf(invoice: Invoice): Uint8Array {
  const lines = [
    \`Invoice \${invoice.number}\`,
    \`Customer: \${invoice.customer}\`,
    \`Issued: \${invoice.issuedOn}   Due: \${invoice.dueOn}\`,
    \`Amount: \${formatMoney(invoice.amountCents, invoice.currency)}\`,
  ];
  const escape = (text: string) => text.replace(/[()\\\\]/g, '\\\\$&');
  const content = lines
    .map((line, i) => \`BT /F1 12 Tf 72 \${720 - i * 18} Td (\${escape(line)}) Tj ET\`)
    .join('\\n');
  return new TextEncoder().encode(\`%PDF-1.4\\n\${content}\\n%%EOF\`);
}
`,
          },
          edit: {
            'src/api/routes.ts': [
              [
                "} from '../invoices';",
                "} from '../invoices';\nimport { renderInvoicePdf } from '../pdf';",
              ],
              [
                "  return json({ error: 'Not found' }, 404);\n}",
                `  const pdf = url.pathname.match(/^\\/invoices\\/(\\d+)\\/pdf$/);
  if (pdf && request.method === 'GET') {
    const invoice = invoices.find((i) => i.id === Number(pdf[1]));
    if (!invoice) return json({ error: 'Not found' }, 404);
    return new Response(renderInvoicePdf(invoice), {
      headers: { 'content-type': 'application/pdf' },
    });
  }
  return json({ error: 'Not found' }, 404);
}`,
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 1, h: 9, m: 40 },
    updatedAt: { d: 1, h: 9, m: 50 },
    summaries: {
      'src/pdf.ts': 'Renders an invoice as a one-page PDF.',
      'src/api/routes.ts': 'Adds GET /invoices/:id/pdf.',
    },
    review: {
      durationMs: null,
      at: { d: 1, h: 9, m: 45 },
      status: 'reviewing',
      agents: [
        {
          agent: 'securityagent',
          status: 'reviewing',
          p: 0.88,
          summary: null,
          flags: [],
        },
        {
          agent: 'featuresagent',
          status: 'approved',
          p: 0.7,
          summary: 'A new route; nothing existing changes.',
          flags: [],
        },
      ],
    },
    check: 'success',
  },
  {
    key: 'rate-limit',
    branch: 'codex/s5-rate-limit',
    title: 'Rate-limit the invoice API',
    body: 'Each client can make 60 requests a minute. After that the API answers 429 until the minute is up.',
    author: 'admin',
    via: 'Codex',
    session: 's5',
    request: 'Someone is hammering the API. Add a rate limit.',
    commits: [
      {
        at: { d: 1, h: 13, m: 0 },
        message: 'Limit each client to 60 requests a minute',
        ops: {
          write: {
            'src/api/rateLimit.ts': `// At most LIMIT requests per client per minute. The client is whoever the proxy says it is.
const LIMIT = 60;
const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

export function rateLimit(request: Request): Response | null {
  const client = request.headers.get('x-forwarded-for') ?? 'unknown';
  const now = Date.now();
  const recent = (hits.get(client) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(client, recent);
  if (recent.length > LIMIT) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }
  return null;
}
`,
          },
          edit: {
            'src/api/routes.ts': [
              [
                'const invoices: Invoice[] = [];',
                "import { rateLimit } from './rateLimit';\n\nconst invoices: Invoice[] = [];",
              ],
              [
                'export function handle(request: Request): Promise<Response> | Response {\n  const url = new URL(request.url);',
                'export function handle(request: Request): Promise<Response> | Response {\n  const limited = rateLimit(request);\n  if (limited) return limited;\n  const url = new URL(request.url);',
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 1, h: 13, m: 12 },
    updatedAt: { d: 1, h: 13, m: 40 },
    summaries: {
      'src/api/rateLimit.ts':
        'Counts requests per client in memory and answers 429 past 60 a minute.',
      'src/api/routes.ts': 'Every request goes through the rate limit first.',
    },
    review: {
      durationMs: 71_000,
      at: { d: 1, h: 13, m: 20 },
      agents: [
        {
          agent: 'securityagent',
          status: 'changes_requested',
          p: 0.96,
          summary: 'The rate limit can be skipped by changing a header.',
          flags: [
            {
              kind: 'change_requested',
              title: 'The rate limit trusts a header the caller sets',
              detail:
                'The limit is keyed on X-Forwarded-For, which any client can change, so sending a different value with each request skips it. Key it on the connecting address (CF-Connecting-IP) instead.',
              changes: [
                ['Client identity', 'none', 'X-Forwarded-For header'],
                ['Limit', 'none', '60 requests a minute per header value'],
              ],
              paths: ['src/api/rateLimit.ts'],
              snippet: {
                path: 'src/api/rateLimit.ts',
                find: 'const client = request.headers.get',
                lines: 1,
                why: 'the caller chooses this value',
              },
            },
          ],
        },
        {
          agent: 'featuresagent',
          status: 'approved',
          p: 0.58,
          summary: 'A new limit, described in the pull request.',
          flags: [],
        },
      ],
    },
    check: 'success',
  },
  {
    key: 'signin-log',
    branch: 'claude/s6-signin-log',
    title: 'Log every sign-in attempt',
    body: 'Records who tried to sign in, from where and when, and shows the log at `GET /sign-ins`.\n\nThe invoice list now needs a sign-in too, so the log means something.',
    author: 'admin',
    via: 'Claude Code',
    session: 's6',
    request: 'Log every sign-in attempt so I can see who is trying to get in.',
    commits: [
      {
        at: { d: 0, ago: 5 },
        message: 'Log every sign-in attempt',
        ops: {
          write: {
            'migrations/0007_sign_in_log.sql': `CREATE TABLE sign_in_log (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL,
  ok INTEGER NOT NULL,
  ip TEXT,
  at TEXT NOT NULL
);
`,
            'src/auth.ts': `// Sign-in: who is calling, and a record of every attempt.
export interface SignInAttempt {
  email: string;
  ok: boolean;
  ip: string | null;
  at: string;
}

const log: SignInAttempt[] = [];

export function recordSignIn(email: string, ok: boolean, request: Request): void {
  log.push({
    email,
    ok,
    ip: request.headers.get('x-forwarded-for'),
    at: new Date().toISOString(),
  });
}

export function signedInUser(request: Request): string | null {
  const header = request.headers.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

export function signInLog(): SignInAttempt[] {
  return log;
}
`,
          },
          edit: {
            'src/api/routes.ts': [
              [
                "import { formatMoney } from '../currency';",
                "import { signInLog, signedInUser } from '../auth';\nimport { formatMoney } from '../currency';",
              ],
              [
                "  if (url.pathname === '/invoices' && request.method === 'GET') {\n    return listInvoices();\n  }",
                "  if (url.pathname === '/invoices' && request.method === 'GET') {\n    if (!signedInUser(request)) return json({ error: 'Sign in first' }, 401);\n    return listInvoices();\n  }\n  if (url.pathname === '/sign-ins' && request.method === 'GET') {\n    if (!signedInUser(request)) return json({ error: 'Sign in first' }, 401);\n    return json({ attempts: signInLog() });\n  }",
              ],
            ],
          },
        },
      },
    ],
    openedAt: { d: 0, ago: 4.5 },
    updatedAt: { d: 0, ago: 2 },
    summaries: {
      'migrations/0007_sign_in_log.sql': 'Creates the sign_in_log table.',
      'src/auth.ts':
        'Records each sign-in attempt and reads who is signed in from the Authorization header.',
      'src/api/routes.ts':
        'The invoice list needs a sign-in, and GET /sign-ins returns the log.',
    },
    review: {
      durationMs: 55_000,
      at: { d: 0, ago: 4.2 },
      agents: [
        {
          agent: 'securityagent',
          status: 'approved',
          p: 0.74,
          summary: 'Both routes check for a signed-in caller before answering.',
          flags: [],
        },
        {
          agent: 'dataagent',
          status: 'approved',
          p: 0.6,
          summary: 'A new table only; existing data is untouched.',
          flags: [],
        },
        {
          agent: 'featuresagent',
          status: 'flagged',
          p: 0.92,
          summary:
            'The invoice list used to answer anyone; it now needs a sign-in.',
          flags: [
            {
              kind: 'needs_person',
              title: 'The invoice list now needs a sign-in',
              detail:
                'Anyone or anything that reads the invoice list without signing in will now get a 401 instead of the list.',
              question: 'Should the invoice list now need a sign-in?',
              changes: [
                [
                  'GET /invoices',
                  'open to anyone',
                  'answers 401 without a sign-in',
                ],
              ],
              paths: ['src/api/routes.ts'],
              snippet: {
                path: 'src/api/routes.ts',
                find: "if (!signedInUser(request)) return json({ error: 'Sign in first' }, 401);",
                lines: 1,
                why: 'the list is now guarded',
              },
              assignee: 'cho',
              assignedBy: 'admin',
              assignedAt: { d: 0, ago: 2 },
            },
          ],
        },
      ],
    },
    check: 'success',
  },
  {
    key: 'insights',
    branch: 'cho/insights-findings',
    title: 'Add a helper that lists the customers who have been invoiced',
    body: 'A small helper for a customers page later: every customer who has an invoice, once, A to Z. Nothing calls it yet.',
    author: 'cho',
    via: null,
    session: null,
    request: null,
    autoMergeOff: true,
    commits: [
      {
        at: { d: 0, ago: 2.5 },
        message: 'Add a helper that lists the customers who have been invoiced',
        ops: {
          // New files only, and nothing wired in: nothing here depends on, or is depended on by, another pull request.
          write: {
            'src/customers.ts': `import type { Invoice } from './invoices';

// The customers who have been invoiced, A to Z.
export function distinctCustomers(invoices: Invoice[]): string[] {
  const names = new Set(invoices.map((invoice) => invoice.customer));
  return [...names].sort((a, b) => a.localeCompare(b));
}
`,
            'src/customers.test.ts': `import { describe, expect, it } from 'vitest';
import { distinctCustomers } from './customers';
import { newInvoice } from './invoices';

describe('distinctCustomers', () => {
  it('lists each customer once, A to Z', () => {
    const day = new Date('2026-09-01');
    const invoices = [
      newInvoice(1, 'Birch & Co', 10_000, day),
      newInvoice(2, 'Acme', 5_000, day),
      newInvoice(3, 'Birch & Co', 2_500, day),
    ];
    expect(distinctCustomers(invoices)).toEqual(['Acme', 'Birch & Co']);
  });
});
`,
          },
        },
      },
    ],
    openedAt: { d: 0, ago: 2.3 },
    updatedAt: { d: 0, ago: 1.5 },
    summaries: {
      'src/customers.ts':
        'Adds distinctCustomers: every customer name once, A to Z.',
      'src/customers.test.ts': 'Tests distinctCustomers.',
    },
    review: {
      durationMs: 33_000,
      at: { d: 0, ago: 2.1 },
      agents: [
        {
          agent: 'featuresagent',
          status: 'approved',
          p: 0.57,
          summary:
            'A new helper that nothing calls yet; nothing existing changes.',
          flags: [],
        },
      ],
    },
    check: 'success',
  },
];

/** Main's test history is built from the landings; the run that failed is the one on this merged branch's landing. */
export const FAILED_PUSH_RUN = 'rebase-merging';

/** Fixer's recent attempts (rebase runs): which pull request, how it ended, and when. */
export const REBASE_RUNS = [
  {
    branch: 'claude/s3-invoice-notes',
    status: 'succeeded',
    at: { d: 5, h: 17, m: 12 },
    seconds: 38,
  },
  {
    branch: 'stack-tree',
    status: 'failed',
    at: { d: 4, h: 17, m: 40 },
    seconds: 71,
    error: 'Could not combine the changes to src/api/routes.ts.',
  },
  {
    branch: 'faster-conflict-resolution',
    status: 'succeeded',
    at: { d: 2, h: 16, m: 35 },
    seconds: 44,
  },
];

/** What each agent learned from a dismissed change request: a committed lesson. */
export const LESSONS = [
  {
    agent: 'dataagent',
    branch: 'claude/s1-line-items',
    finished: { d: 9, h: 18, m: 0 },
    summary:
      'Added a rule: do not ask for an index on a table that is still small.',
  },
  {
    agent: 'featuresagent',
    branch: 'codex/s4-overdue-flag',
    finished: { d: 3, h: 18, m: 30 },
    summary:
      'Added a rule: a new field on a response is not a breaking change.',
  },
];
