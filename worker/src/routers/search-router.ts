import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { SEARCH_LIMIT, search } from '../lib/search';
import type { AppEnv } from '../variables';
import {
  json200Response,
  json400Response,
  json401Response,
  validationHook,
} from './openapi-helpers';

// Global search (worker/src/lib/search.ts). Members only; every list respects what the caller can read.

const searchResultsSchema = z
  .object({
    /** `owner/name`. */
    repos: z.array(
      z.object({ name: z.string(), description: z.string().nullable() })
    ),
    pulls: z.array(
      z.object({
        repo: z.string(),
        number: z.number(),
        title: z.string(),
        state: z.string(),
      })
    ),
    agents: z.array(
      z.object({ handle: z.string(), name: z.string(), color: z.string() })
    ),
    people: z.array(
      z.object({ login: z.string(), name: z.string().nullable() })
    ),
    /** Only with `repo`. */
    branches: z.array(z.object({ repo: z.string(), name: z.string() })),
    /** Only with `repo`: paths on its default branch. */
    files: z.array(z.object({ repo: z.string(), path: z.string() })),
  })
  .openapi('SearchResults');

export const searchRouter = new OpenAPIHono<AppEnv>({
  defaultHook: validationHook,
});

const searchRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Search'],
  summary: 'Search',
  description: `Repositories, pull requests (by title, or by number with "#12"), agents and people matching \`q\`, at most ${SEARCH_LIMIT} of each, only among what you can read. With \`repo\`, also that repository's branches and the files on its default branch.`,
  request: {
    query: z.object({
      q: z.string().max(200).default(''),
      repo: z
        .string()
        .regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name')
        .optional()
        .openapi({
          description:
            'owner/name: search its branches and files too, and rank its pull requests first.',
        }),
    }),
  },
  responses: {
    ...json200Response(searchResultsSchema, 'What matched'),
    ...json400Response,
    ...json401Response,
  },
});
searchRouter.openapi(searchRoute, async (c) => {
  const { q, repo } = c.req.valid('query');
  return c.json(await search(c.env, c.get('db'), c.get('user')!, q, repo), 200);
});
