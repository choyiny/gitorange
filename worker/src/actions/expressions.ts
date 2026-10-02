/**
 * GitHub Actions expressions: the `${{ … }}` language used in workflow files and `if:` conditions.
 * Supports literals, context access (`github.sha`, `matrix['node']`, `steps.build.outputs.x`),
 * `! == != < <= > >= && ||`, and the common functions. Comparison and truthiness follow GitHub's
 * rules: strings compare case-insensitively and mismatched types are compared as numbers.
 */

export type Value =
  null | boolean | number | string | Value[] | { [key: string]: Value };

export type JobStatus = 'success' | 'failure' | 'cancelled';

export interface EvalOptions {
  /** The status `success()`, `failure()`, and `cancelled()` read. Defaults to success. */
  status?: JobStatus;
}

export class ExpressionError extends Error {}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string };

const OPS = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '<',
  '>',
  '!',
  '(',
  ')',
  '[',
  ']',
  '.',
  ',',
];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new ExpressionError('Unterminated string');
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += src[i++];
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    const num = /^(?:0x[0-9a-f]+|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(
      src.slice(i)
    );
    if (
      num &&
      (ch !== '-' || out.length === 0 || out[out.length - 1].t === 'op')
    ) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'ident', v: id[0] });
      i += id[0].length;
      continue;
    }
    if (ch === '*') {
      out.push({ t: 'ident', v: '*' });
      i++;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpressionError(`Unexpected character '${ch}'`);
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

type Node =
  | { k: 'lit'; v: Value }
  | { k: 'ctx'; name: string }
  | { k: 'index'; obj: Node; key: Node }
  | { k: 'not'; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'call'; fn: string; args: Node[] };

const PRECEDENCE: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '<=': 4,
  '>': 4,
  '>=': 4,
};

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExpressionError(`Expected '${v}'`);
    pos++;
  };

  function primary(): Node {
    const tok = tokens[pos++];
    if (!tok) throw new ExpressionError('Unexpected end of expression');
    let node: Node;
    if (tok.t === 'num') node = { k: 'lit', v: tok.v };
    else if (tok.t === 'str') node = { k: 'lit', v: tok.v };
    else if (tok.t === 'op' && tok.v === '(') {
      node = expr(0);
      expect(')');
    } else if (tok.t === 'op' && tok.v === '!') {
      return { k: 'not', e: primary() };
    } else if (tok.t === 'ident') {
      if (tok.v === 'true' || tok.v === 'false')
        node = { k: 'lit', v: tok.v === 'true' };
      else if (tok.v === 'null') node = { k: 'lit', v: null };
      else if (isOp('(')) {
        pos++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(expr(0));
          while (isOp(',')) {
            pos++;
            args.push(expr(0));
          }
        }
        expect(')');
        node = { k: 'call', fn: tok.v.toLowerCase(), args };
      } else node = { k: 'ctx', name: tok.v };
    } else throw new ExpressionError(`Unexpected '${tok.v}'`);

    for (;;) {
      if (isOp('.')) {
        pos++;
        const key = tokens[pos++];
        if (!key || key.t !== 'ident')
          throw new ExpressionError('Expected a property name');
        node = { k: 'index', obj: node, key: { k: 'lit', v: key.v } };
      } else if (isOp('[')) {
        pos++;
        const key = expr(0);
        expect(']');
        node = { k: 'index', obj: node, key };
      } else return node;
    }
  }

  function expr(minPrec: number): Node {
    let left = primary();
    for (;;) {
      const tok = peek();
      if (tok?.t !== 'op') return left;
      const op = tok.v;
      const prec = PRECEDENCE[op];
      if (prec === undefined || prec < minPrec) return left;
      pos++;
      const right = expr(prec + 1);
      left = { k: 'bin', op, l: left, r: right };
    }
  }

  const node = expr(0);
  if (pos < tokens.length)
    throw new ExpressionError(`Unexpected '${tokens[pos].v}'`);
  return node;
}

export function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === '') return false;
  if (typeof v === 'number' && Number.isNaN(v)) return false;
  return true;
}

function toNumber(v: Value): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v.trim() === '' ? 0 : Number(v);
  return NaN;
}

export function toText(v: Value): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(v, null, 2);
}

function compare(op: string, a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    const x = a.toUpperCase();
    const y = b.toUpperCase();
    if (op === '==') return x === y;
    if (op === '!=') return x !== y;
    if (op === '<') return x < y;
    if (op === '<=') return x <= y;
    if (op === '>') return x > y;
    return x >= y;
  }
  const objA = a !== null && typeof a === 'object';
  const objB = b !== null && typeof b === 'object';
  if (objA || objB) {
    const same = a === b;
    return op === '==' ? same : op === '!=' ? !same : false;
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (op === '==') return x === y;
  if (op === '!=') return x !== y;
  if (op === '<') return x < y;
  if (op === '<=') return x <= y;
  if (op === '>') return x > y;
  return x >= y;
}

function index(obj: Value, key: Value): Value {
  if (obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) {
    if (key === '*') return obj;
    const i = toNumber(key);
    return Number.isInteger(i) ? (obj[i] ?? null) : null;
  }
  if (key === '*') return Object.values(obj);
  const wanted = toText(key).toLowerCase();
  for (const [k, v] of Object.entries(obj))
    if (k.toLowerCase() === wanted) return v;
  return null;
}

function contains(haystack: Value, needle: Value): boolean {
  if (Array.isArray(haystack))
    return haystack.some((x) => compare('==', x, needle));
  return toText(haystack).toLowerCase().includes(toText(needle).toLowerCase());
}

function evalNode(
  node: Node,
  ctx: Record<string, Value>,
  opts: EvalOptions
): Value {
  switch (node.k) {
    case 'lit':
      return node.v;
    case 'ctx': {
      const hit = Object.entries(ctx).find(
        ([k]) => k.toLowerCase() === node.name.toLowerCase()
      );
      if (!hit)
        throw new ExpressionError(`Unrecognized named-value: '${node.name}'`);
      return hit[1];
    }
    case 'index':
      return index(
        evalNode(node.obj, ctx, opts),
        evalNode(node.key, ctx, opts)
      );
    case 'not':
      return !truthy(evalNode(node.e, ctx, opts));
    case 'bin': {
      const l = evalNode(node.l, ctx, opts);
      if (node.op === '&&') return truthy(l) ? evalNode(node.r, ctx, opts) : l;
      if (node.op === '||') return truthy(l) ? l : evalNode(node.r, ctx, opts);
      return compare(node.op, l, evalNode(node.r, ctx, opts));
    }
    case 'call': {
      const status = opts.status ?? 'success';
      const args = () => node.args.map((a) => evalNode(a, ctx, opts));
      switch (node.fn) {
        case 'success':
          return status === 'success';
        case 'failure':
          return status === 'failure';
        case 'cancelled':
          return status === 'cancelled';
        case 'always':
          return true;
        case 'contains': {
          const [h, n] = args();
          return contains(h, n);
        }
        case 'startswith': {
          const [s, p] = args();
          return toText(s).toLowerCase().startsWith(toText(p).toLowerCase());
        }
        case 'endswith': {
          const [s, p] = args();
          return toText(s).toLowerCase().endsWith(toText(p).toLowerCase());
        }
        case 'format': {
          const [fmt, ...rest] = args();
          return toText(fmt)
            .replace(/\{(\d+)\}/g, (_, i) => toText(rest[Number(i)] ?? null))
            .replace(/\{\{/g, '{')
            .replace(/\}\}/g, '}');
        }
        case 'join': {
          const [arr, sep] = args();
          const s = sep === undefined ? ',' : toText(sep);
          return Array.isArray(arr) ? arr.map(toText).join(s) : toText(arr);
        }
        case 'tojson':
          return JSON.stringify(args()[0], null, 2);
        case 'fromjson': {
          try {
            return JSON.parse(toText(args()[0])) as Value;
          } catch {
            throw new ExpressionError('fromJSON: invalid JSON');
          }
        }
        default:
          throw new ExpressionError(`Unsupported function: ${node.fn}()`);
      }
    }
  }
}

export function evaluate(
  src: string,
  ctx: Record<string, Value>,
  opts: EvalOptions = {}
): Value {
  return evalNode(parse(tokenize(src)), ctx, opts);
}

const TEMPLATE = /\$\{\{([\s\S]*?)\}\}/g;

/** Replaces every `${{ expr }}` in `text`. */
export function interpolate(
  text: string,
  ctx: Record<string, Value>,
  opts: EvalOptions = {}
): string {
  return text.replace(TEMPLATE, (_, e: string) =>
    toText(evaluate(e, ctx, opts))
  );
}

/**
 * Evaluates an `if:` condition. Like GitHub, a bare `${{ }}` wrapper is optional and a condition
 * with no status function implicitly means `success() && (…)`.
 */
export function evaluateCondition(
  condition: string | boolean | undefined,
  ctx: Record<string, Value>,
  opts: EvalOptions = {}
): boolean {
  if (condition === undefined || condition === '')
    return (opts.status ?? 'success') === 'success';
  if (typeof condition === 'boolean')
    return condition && (opts.status ?? 'success') === 'success';
  let src = condition.trim();
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(src);
  if (whole && !whole[1].includes('}}')) src = whole[1].trim();
  else if (src.includes('${{'))
    src = `'${interpolate(src, ctx, opts).replace(/'/g, "''")}'`;
  if (!/\b(success|failure|cancelled|always)\s*\(/i.test(src))
    src = `success() && (${src})`;
  return truthy(evaluate(src, ctx, opts));
}
