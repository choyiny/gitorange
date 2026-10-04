import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { aiGateway } from '../lib/ai-gateway';
import { workersAiModels } from '../review/models';

/** A fake AI binding that records each call's gateway option and answers like a chat model. */
function recordingEnv(gatewayId: string) {
  const calls: { model: string; options: unknown }[] = [];
  const AI = {
    run: async (model: string, _input: unknown, options?: unknown) => {
      calls.push({ model, options });
      if (model.includes('clef')) return { answers: {} };
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                files: ['a.ts'],
                detail: 'Adds a.',
                changes: [{ what: 'a', before: 'none', after: 'a' }],
                diagram: ['flowchart LR', 'A --> B'],
                snippets: [],
              }),
            },
            finish_reason: 'stop',
          },
        ],
      };
    },
  };
  return {
    env: {
      ...env,
      AI,
      AI_GATEWAY: gatewayId,
      BASE_URL: 'https://git.example.com',
    } as unknown as CloudflareBindings,
    calls,
  };
}

describe('AI Gateway', () => {
  it('routes every review call through the gateway, tagged with its feature', async () => {
    const { env: e, calls } = recordingEnv('default');
    const models = workersAiModels(
      e,
      { summary: '@cf/zai-org/glm-5.3-flash', review: '@cf/zai-org/glm-5.3' },
      { classificationId: 'c1' }
    );
    await models.summarize({
      path: 'a.ts',
      status: 'added',
      additions: 1,
      deletions: 0,
      diff: '+a',
    });
    await models.classify('clef', { files: [] }, {});
    await models.selectFiles!({ flag: 'f', summaries: 's', paths: ['a.ts'] });
    await models.investigate({
      flag: 'f',
      title: 't',
      description: '',
      summaries: 's',
      diffs: 'd',
      paths: ['a.ts'],
    });
    expect(calls.map((c) => c.options)).toEqual(
      [
        'review-summary',
        'review-classify',
        'review-select',
        'review-investigate',
      ].map((feature) => ({
        gateway: {
          id: 'default',
          metadata: {
            feature,
            instance: 'git.example.com',
            classification: 'c1',
          },
        },
      }))
    );
  });

  it("records each call's tokens for usage, with the review's pull request", async () => {
    const { env: e } = recordingEnv('default');
    const AI = {
      run: async (model: string) =>
        model.includes('clef')
          ? { answers: {} }
          : {
              choices: [{ message: { content: 'Adds a.' } }],
              usage: {
                prompt_tokens: 120,
                completion_tokens: 30,
                prompt_tokens_details: { cached_tokens: 20 },
              },
            },
    };
    const models = workersAiModels(
      { ...e, AI } as never,
      { summary: '@cf/zai-org/glm-5.3-flash', review: '@cf/zai-org/glm-5.3' },
      { classificationId: 'no-such-classification' }
    );
    await models.summarize({
      path: 'a.ts',
      status: 'added',
      additions: 1,
      deletions: 0,
      diff: '+a',
    });
    await models.classify('clef', { files: [] }, {});
    const rows = (
      await env.DB.prepare(
        'SELECT feature, model, tokens_in, tokens_out, tokens_cached, classification_id, repository_id FROM ai_usage ORDER BY feature DESC'
      ).all()
    ).results;
    expect(rows).toEqual([
      {
        feature: 'review-summary',
        model: '@cf/zai-org/glm-5.3-flash',
        tokens_in: 120,
        tokens_out: 30,
        tokens_cached: 20,
        classification_id: 'no-such-classification',
        repository_id: null,
      },
      {
        feature: 'review-classify',
        model: '@cf/cloudflare/clef',
        tokens_in: null,
        tokens_out: null,
        tokens_cached: null,
        classification_id: 'no-such-classification',
        repository_id: null,
      },
    ]);
  });

  it('"off" calls Workers AI directly; unset means the default gateway', () => {
    const base = { BASE_URL: 'https://git.example.com' };
    expect(
      aiGateway({ ...base, AI_GATEWAY: 'off' } as never, 'merge-resolution')
    ).toBeUndefined();
    expect(
      aiGateway({ ...base, AI_GATEWAY: '' } as never, 'merge-resolution')
    ).toEqual({
      id: 'default',
      metadata: { feature: 'merge-resolution', instance: 'git.example.com' },
    });
  });
});
