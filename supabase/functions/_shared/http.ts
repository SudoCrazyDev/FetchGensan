/**
 * Request/response plumbing shared by the edge functions.
 *
 * Folders starting with `_` are not deployed as functions; Supabase bundles
 * them into whichever function imports them.
 */

// Auth is a bearer token, never a cookie, so a wildcard origin does not let
// another site act as a signed-in user. It does let the Expo web build and
// the console call these from the browser.
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-fetch-app',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
};

/**
 * An error whose message is written for a person. Anything else that
 * escapes a handler becomes a generic 500 and is only logged.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json', ...headers },
  });
}

export function serve(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

    try {
      return await handler(req);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(
          { error: error.message, code: error.code, ...error.extra },
          error.status,
          error.headers,
        );
      }
      console.error('unhandled', error);
      return json({ error: 'Something went wrong. Please try again.', code: 'internal' }, 500);
    }
  });
}

export async function readJson<T extends Record<string, unknown>>(
  req: Request,
): Promise<Partial<T>> {
  try {
    const body = await req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Partial<T>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'The request body must be a JSON object.', 'invalid_body');
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The caller's address. Supabase's edge puts the client first in
 * X-Forwarded-For. Only used as a rate-limit key, never trusted for
 * anything else -- it is trivially spoofable one hop further out.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown';
}

/** The path after the function name: `/auth/password/reset` -> `/password/reset`. */
export function subpath(req: Request, functionName: string): string {
  const path = new URL(req.url).pathname;
  const at = path.indexOf(`/${functionName}`);
  const rest = at === -1 ? path : path.slice(at + functionName.length + 1);
  return rest.replace(/\/+$/, '') || '/';
}

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
