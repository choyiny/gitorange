export class ApiError extends Error {
  status: number;
  body: any;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<T> {
  const headers = new Headers(init?.headers);
  const hasBody = init?.json !== undefined;
  if (hasBody) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    body: hasBody ? JSON.stringify(init!.json) : init?.body,
    headers,
  });
  const isJson = (res.headers.get('content-type') || '').includes(
    'application/json'
  );
  const body = isJson
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);
  if (!res.ok) {
    const message =
      (body &&
        typeof body === 'object' &&
        'error' in body &&
        String(body.error)) ||
      `Request failed: ${res.status}`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body;
    if (b?.error?.issues)
      return b.error.issues.map((i: any) => i.message).join(', ');
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
