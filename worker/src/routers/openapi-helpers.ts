import { z } from '@hono/zod-openapi';

export const errorSchema = z.object({ error: z.string() });

export const json200Response = <T extends z.ZodType>(
  schema: T,
  description: string
) => ({
  200: { content: { 'application/json': { schema } }, description },
});

export const json201Response = <T extends z.ZodType>(
  schema: T,
  description: string
) => ({
  201: { content: { 'application/json': { schema } }, description },
});

const err = (description: string) => ({
  content: { 'application/json': { schema: errorSchema } },
  description,
});

export const json400Response = { 400: err('Invalid Request') };
export const json401Response = { 401: err('Unauthorized') };
export const json403Response = { 403: err('Forbidden') };
export const json404Response = { 404: err('Not Found') };
export const json409Response = { 409: err('Conflict') };

export const okSchema = z.object({ ok: z.literal(true) });

/** Turns zod-openapi validation failures into the same `{ error }` shape every route returns. */
export const validationHook = (
  result: {
    success: boolean;
    error?: { issues: { message: string; path: PropertyKey[] }[] };
  },
  c: any
) => {
  if (!result.success) {
    const message = result
      .error!.issues.map((i) =>
        i.path.length
          ? `${String(i.path[i.path.length - 1])}: ${i.message}`
          : i.message
      )
      .join('; ');
    return c.json({ error: message }, 400);
  }
};
