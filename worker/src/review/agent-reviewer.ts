import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import { Workspace, type DurableObjectStorageLike } from '@cloudflare/computer';
import { createPiTools } from '@cloudflare/computer/tools/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import {
  CompactionTask,
  createRegistry,
  GenerationTask,
  Harness,
  hook,
  type ToolRegistration,
} from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { createAI } from 'agents/models/pi-ai';
import { prReviewers } from '../db/app.schema';
import { schema } from '../db/schema';
import { aiGateway } from '../lib/ai-gateway';
import { gitForName } from '../lib/repos';
import { checkoutHead, notCheckedOutText } from './checkout';
import { ignoreMatcher } from './ignore';
import { sameAttempt } from './outcome';
import {
  addPiResponse,
  fenceToolOutput,
  NOT_CHECKED_OUT_PATH,
  PI_EXPIRE_SLACK_MS,
  PI_MAX_NUDGES,
  PI_NO_USAGE,
  PI_OPERATION,
  PI_START_STOPPED,
  PI_TOMBSTONE_MS,
  PI_TOOLS,
  piAnswerProblem,
  PiCounter,
  piRequestDecision,
  PiStartGate,
  piStartMeta,
  piStartResult,
  piSettledStatus,
  piNudge,
  piSystemPrompt,
  piToolBlock,
  piToolBudgetSpent,
  piUserPrompt,
  REPO_ROOT,
  REVIEW_ROOT,
  type PiMeta,
  type PiReviewerApi,
  type PiStartRequest,
  type PiStartResult,
  type PiStatus,
  type PiUsage,
} from './pi-contract';

/** The fallback model; each start names the configured one (Site admin's `ai.review_pi_model`, else `REVIEW_MODEL`). */
const DEFAULT_PI_MODEL = '@cf/zai-org/glm-5.3';

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');

/** Resolves once `signal` aborts (or after `ms`, or at once without a signal). */
const abortedOrAfter = (signal: AbortSignal | undefined, ms: number) =>
  new Promise<void>((resolve) => {
    if (!signal || signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

const dirOf = (abs: string) => abs.split('/').slice(0, -1).join('/') || '/';

/** A final answer's text (pi's assistant message: text, thinking and tool-call parts). */
function answerText(message: { content: readonly unknown[] }): string {
  return message.content
    .map((c) =>
      c && typeof c === 'object' && (c as { type?: string }).type === 'text'
        ? String((c as { text?: unknown }).text ?? '')
        : ''
    )
    .join('');
}

function aiSettings(env: CloudflareBindings) {
  const gateway = aiGateway(env, 'review-agent-pi');
  return gateway ? { binding: env.AI, gateway } : { binding: env.AI };
}

/**
 * One Pi review of one reviewer row attempt (named `<pr_reviewers.id>:<generation>`). `start` copies the head
 * commit's text files into /repo of a Cloudflare Computer workspace in this object's SQLite and submits one prompt;
 * pi then works through read-only tools (read, ls, find, grep — no shell, network, git or write), each result fenced
 * as untrusted. Only the final answer's text and counts ever leave this object; `stop` (or the `expire` job,
 * PI_EXPIRE_SLACK_MS after the wall clock ends) deletes everything it stored, the transcript included, leaving only a
 * tombstone (`stopped`) that makes a late start do nothing, itself deleted PI_TOMBSTONE_MS later.
 */
export class AgentReviewer
  extends DurableObject<CloudflareBindings>
  implements PiReviewerApi
{
  readonly ai = createAI(aiSettings(this.env));
  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
  });
  readonly registry = createRegistry();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const models = createModels();
      models.setProvider(this.ai.provider);
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: {
            // Doubling backoff (2, 4, 8, 16, 32 s) rides out Workers AI rate limits.
            retry: { enabled: true, maxRetries: 5, baseDelayMs: 2000 },
          },
          onReport: (error) => console.warn('[review] pi report', error),
        },
        context
      );
    },
    defaults: {
      model: this.ai((this.env.REVIEW_MODEL || DEFAULT_PI_MODEL) as never),
      thinkingLevel: 'low',
    },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);
  private installed = false;
  /** Set once everything is deleted: nothing may reopen pi's storage after that. */
  private wiped = false;
  /** Concurrent starts join one; a stop makes a start in flight fail before it stores or submits anything. */
  private readonly gate = new PiStartGate<PiStartResult>();
  /** Tool calls, counted in memory so a round's parallel calls can't spend past the budget together. */
  private readonly toolCalls = new PiCounter(
    () => this.ctx.storage.get<number>('toolCalls'),
    (n) => this.ctx.storage.put('toolCalls', n)
  );

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    // An evicted object wakes (an RPC, or pi's alarm resuming the run) with an empty registry: reinstall the
    // reviewer before anything runs, from the draft when the start that submitted the run didn't finish.
    void ctx.blockConcurrencyWhile(async () => {
      const meta = (await this.meta()) ?? (await this.draft());
      if (meta) this.install(meta);
    });
  }

  private meta() {
    return this.ctx.storage.get<PiMeta>('meta');
  }

  private draft() {
    return this.ctx.storage.get<PiMeta>('draft');
  }

  private async usage(): Promise<PiUsage> {
    return (await this.ctx.storage.get<PiUsage>('usage')) ?? PI_NO_USAGE;
  }

  /** The Workspace's read-only file tools as pi-durable tools: guarded, budgeted, every text result fenced. */
  private tools(meta: PiMeta): ToolRegistration[] {
    const { tools, execute } = createPiTools({
      workspace: this.workspace,
      readonly: true,
    });
    return tools
      .filter((t) => (PI_TOOLS as readonly string[]).includes(t.name))
      .map((tool): ToolRegistration => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as never,
        replay: 'safe',
        execute: async (args, api, context) => {
          const blocked = piToolBlock(
            tool.name,
            (args ?? {}) as Record<string, unknown>
          );
          if (blocked)
            return {
              content: [{ type: 'text', text: blocked }],
              isError: true,
            };
          if (!(await this.toolCalls.take(meta.maxToolCalls)))
            return {
              content: [
                { type: 'text', text: piToolBudgetSpent(meta.maxToolCalls) },
              ],
              isError: true,
            };
          const { content, isError } = await execute(
            { id: api.callId, name: tool.name, arguments: args },
            { abortSignal: context.abortSignal }
          );
          // Text only (the file tools return no images), and all of it fenced.
          return {
            content: content.flatMap((c) =>
              c.type === 'text'
                ? [{ ...c, text: fenceToolOutput(c.text, meta.suffix) }]
                : []
            ),
            isError,
          };
        },
      }));
  }

  private install(meta: PiMeta) {
    if (this.installed) return;
    this.installed = true;
    this.registry.install({
      name: 'reviewer',
      sections: [
        {
          key: 'preamble',
          render: () => piSystemPrompt(meta.handle, meta.maxToolCalls),
          tag: false,
        },
      ],
      tools: this.tools(meta),
      hooks: [
        // This object caps its own spend: every response is counted, and the request that would pass the limits
        // aborts the run instead. pi swallows a hook's error unless the invocation is aborted, so the abort comes
        // first: it marks the task and signals this invocation, and the throw then ends it; the run settles
        // 'aborted', which status() reports as the limit.
        hook(GenerationTask, {
          beforeRequest: async (_request, _api, context) => {
            const decision = piRequestDecision(
              await this.usage(),
              meta,
              (await this.ctx.storage.get<string>('limited')) ?? null
            );
            if (decision.action === 'proceed') return undefined;
            if (decision.first) {
              await this.ctx.storage.put('limited', decision.reason);
              this.ctx.waitUntil(this.notifySettled());
            }
            // Not awaited: the abort joins this invocation, which is waiting here.
            this.ctx.waitUntil(
              this.harness
                .abort({ operationId: PI_OPERATION })
                .catch((e: unknown) =>
                  console.warn('[review] could not abort at the limit', e)
                )
            );
            await abortedOrAfter(context.abortSignal, 30_000);
            throw new Error(decision.reason);
          },
          afterResponse: async (message) => {
            // A response landing after the wipe must not write the counters back.
            if (this.wiped) return;
            await this.ctx.storage.put(
              'usage',
              addPiResponse(await this.usage(), message)
            );
          },
        }),
        // A compaction is a model call too, but its response never reaches afterResponse: count it as a call here
        // (its tokens aren't counted: pi's hooks don't expose them) and decline it past the limits, so the next
        // request stops the run.
        hook(CompactionTask, {
          beforeCompact: async () => {
            const usage = await this.usage();
            const decision = piRequestDecision(
              usage,
              meta,
              (await this.ctx.storage.get<string>('limited')) ?? null
            );
            if (decision.action === 'stop') return { decline: true };
            await this.ctx.storage.put('usage', {
              ...usage,
              modelCalls: usage.modelCalls + 1,
            });
            return undefined;
          },
        }),
        // An answer that doesn't meet the contract goes back with what is wrong (bounded); a usable one settles the
        // run, and the Workflow hears about it.
        hook(GenerationTask, {
          onYield: async (answer) => {
            const problem = piAnswerProblem(
              answerText(answer),
              meta.changedPaths
            );
            if (problem) {
              const nudges =
                (await this.ctx.storage.get<number>('nudges')) ?? 0;
              if (nudges < PI_MAX_NUDGES) {
                await this.ctx.storage.put('nudges', nudges + 1);
                return { continue: piNudge(problem) };
              }
            }
            this.ctx.waitUntil(this.notifySettled());
            return undefined;
          },
        }),
      ],
    });
  }

  /** Tells the waiting Workflow the run settled. Best effort: the Workflow checks every 2 minutes anyway. */
  private async notifySettled() {
    if (this.wiped) return;
    try {
      await this.harness.wait(PI_OPERATION, {
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      // Still running, or the wait was cut short: the event still nudges the Workflow to look.
    }
    if (this.wiped) return;
    const meta = (await this.meta()) ?? (await this.draft());
    if (!meta?.notify) return;
    try {
      const instance = await this.env.MERGE_RESOLUTION.get(
        meta.notify.instanceId
      );
      await instance.sendEvent({ type: meta.notify.type, payload: {} });
    } catch (e) {
      console.warn('[review] could not notify the review', meta.notify, e);
    }
  }

  start(request: PiStartRequest): Promise<PiStartResult> {
    if (this.gate.stopped) return Promise.resolve(PI_START_STOPPED);
    return this.gate.run(() => this.startOnce(request));
  }

  /** This reviewer row attempt (the request's id and generation, which name this object) is still reviewing. */
  private async stillWanted(request: PiStartRequest): Promise<boolean> {
    const row = await drizzle(this.env.DB, { schema })
      .select({ id: prReviewers.id })
      .from(prReviewers)
      .where(
        sameAttempt({
          id: request.reviewerId,
          createdAt: new Date(request.generation),
        })
      )
      .get();
    return row !== undefined;
  }

  private async startOnce(request: PiStartRequest): Promise<PiStartResult> {
    const gate = this.gate;
    // Stopped before, maybe by an instance since evicted: a late start (a retried or replayed step) does nothing.
    if ((await this.stopped()) !== undefined) return PI_START_STOPPED;
    // Cancelled, superseded or retried since the Workflow read the row: stop whatever ran, start nothing.
    if (!(await this.stillWanted(request))) {
      gate.stop();
      await this.halt();
      return PI_START_STOPPED;
    }
    const existing = await this.meta();
    // Joined: what this run runs with (a retried start may carry settings changed since).
    if (existing) return piStartResult(existing);
    // Stored before the checkout: the tag and the clock are chosen once (a start that died after submitting sent a
    // prompt naming this tag, and its clock started then), and a stop during the checkout finds something to wipe.
    const meta = piStartMeta(
      request,
      await this.draft(),
      Date.now(),
      randomHex
    );
    gate.check();
    await this.ctx.storage.put('draft', meta);
    const git = gitForName(this.env, request.repository.artifactsName);
    const checkout = await checkoutHead(
      git,
      request.headSha,
      {
        first: meta.changedPaths,
        ignored: ignoreMatcher(request.ignoreText),
      },
      async (path, text) => {
        gate.check();
        const abs = `${REPO_ROOT}/${path}`;
        await this.workspace.fs.mkdir(dirOf(abs), { recursive: true });
        await this.workspace.fs.writeFile(abs, text);
      }
    );
    gate.check();
    await this.workspace.fs.mkdir(REVIEW_ROOT, { recursive: true });
    await this.workspace.fs.writeFile(
      NOT_CHECKED_OUT_PATH,
      notCheckedOutText(checkout)
    );
    gate.check();
    this.install(meta);
    await this.harness.session().setModel(this.ai(meta.model as never));
    // Whatever happens to the Workflow, this object deletes itself after the wall clock plus slack.
    gate.check();
    await this.lifecycle.jobs.push({
      id: 'expire',
      fn: 'expire',
      time: meta.startedAt + meta.wallClockMs + PI_EXPIRE_SLACK_MS,
    });
    // The same operation id: a start retried after this line joins the same run.
    gate.check();
    await this.harness.submit(
      piUserPrompt(request.input, meta.suffix, {
        headSha: request.headSha,
        files: checkout.files,
        skipped: checkout.skipped.length + (checkout.truncated ? 1 : 0),
      }),
      { operationId: PI_OPERATION }
    );
    // Last: a start that died before this line checks out and submits again (both idempotent).
    gate.check();
    await this.ctx.storage.put('meta', meta);
    this.ctx.waitUntil(this.notifySettled());
    return piStartResult(meta);
  }

  async status(): Promise<PiStatus> {
    const meta = await this.meta();
    const toolCalls = await this.toolCalls.read();
    const usage = await this.usage();
    const counts = {
      turns: usage.modelCalls,
      toolCalls,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokensCached: usage.tokensCached,
    };
    if (!meta) return { state: 'missing', startedAt: 0, ...counts };
    // The counters this object keeps as responses arrive; the transcript itself never leaves.
    const base = { startedAt: meta.startedAt, ...counts };
    const pending = await this.harness.pending();
    if (pending.some((p) => p.operationId === PI_OPERATION))
      return { state: 'running', ...base };
    const settled = await this.harness
      .wait(PI_OPERATION, { signal: AbortSignal.timeout(10_000) })
      .catch(() => null);
    const limited = (await this.ctx.storage.get<string>('limited')) ?? null;
    return { ...piSettledStatus(settled, limited), ...base };
  }

  async stop(): Promise<void> {
    // First, before any await: a start in flight stops at its next step, and no later one runs.
    this.gate.stop();
    await this.gate.settled();
    await this.halt();
  }

  /** Wipes what a start left (a draft, maybe a run), or tombstones a name that never started. */
  private async halt() {
    if ((await this.meta()) || (await this.draft())) await this.wipe();
    else if ((await this.stopped()) === undefined) await this.tombstone();
  }

  /** When this object was stopped, if it was. */
  private stopped() {
    return this.ctx.storage.get<number>('stopped');
  }

  /** Durable, unlike the gate: no later start runs, on any instance, until the alarm forgets this object. */
  private async tombstone() {
    const at = Date.now();
    await this.ctx.storage.put('stopped', at);
    await this.ctx.storage.setAlarm(at + PI_TOMBSTONE_MS);
  }

  /**
   * A stopped object's only alarm forgets it, tombstone included (the Lifecycle's alarms were disabled and deleted with
   * the rest); any other is the Lifecycle's (pi's jobs, `expire`).
   */
  async alarm() {
    const stopped = await this.stopped();
    if (stopped === undefined) return this.lifecycle.alarm();
    if (Date.now() < stopped + PI_TOMBSTONE_MS)
      return this.ctx.storage.setAlarm(stopped + PI_TOMBSTONE_MS);
    await this.ctx.storage.deleteAll();
  }

  /** Lifecycle job: the review's hard stop, whether or not the Workflow came back. */
  async onJob({ job }: { job: { fn: string } }) {
    if (job.fn === 'expire') await this.wipe();
  }

  /**
   * Aborts the run and deletes everything: workspace, transcript, counters, the Lifecycle's alarms. Final for this
   * object: the tombstone written last makes any later start() on the same name do nothing (names are per reviewer row
   * attempt, `<id>:<generation>`, so the Workflow never reuses one after stopping it).
   */
  private async wipe() {
    this.wiped = true;
    this.gate.stop();
    await this.harness.abort({ operationId: PI_OPERATION }).catch(() => false);
    await this.lifecycle.disableAlarms();
    await this.harness.dispose();
    await this.ctx.storage.deleteAll();
    this.toolCalls.reset();
    // After deleteAll, which would erase it.
    await this.tombstone();
  }
}
