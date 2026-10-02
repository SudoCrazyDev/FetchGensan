/**
 * Password sign-in and password reset, behind rate limits.
 *
 *   POST /auth/login             { identifier, password }
 *   POST /auth/password/forgot   { identifier }
 *   POST /auth/password/reset    { identifier, code, password }
 *
 * `identifier` is a PH mobile number in any common shape, or an email.
 *
 * login and reset answer with a Supabase session -- a short-lived access
 * token (a JWT, `jwt_expiry` in config.toml) and a single-use refresh
 * token. The apps hand both to `supabase.auth.setSession()`, after which
 * supabase-js refreshes on its own and RLS sees the user exactly as if
 * they had signed in directly. This function adds the rules Supabase Auth
 * cannot express, and nothing else:
 *
 *   - five wrong passwords per account per 15 minutes, then a wait;
 *   - a high per-IP ceiling on top (see the migration for why it is high);
 *   - deactivated accounts are refused even with the right password;
 *   - forgot-password never reveals whether an account exists.
 *
 * verify_jwt is off for this function in config.toml: nobody calling it
 * has a session yet.
 */

import { createClient, type Session, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { HttpError, clientIp, env, json, readJson, serve, str, subpath } from '../_shared/http.ts';
import {
  type LoginIdentifier,
  parseLoginIdentifier,
  passwordProblem,
} from '../_shared/identifier.ts';
import { type Limit, clear, hit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = env('SUPABASE_URL');
const ANON_KEY = env('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');

const LIMITS = {
  loginAccount: { bucket: 'login:id', max: 5, windowSeconds: 15 * 60 },
  loginIp: { bucket: 'login:ip', max: 100, windowSeconds: 15 * 60 },
  forgotAccount: { bucket: 'forgot:id', max: 3, windowSeconds: 60 * 60 },
  forgotIp: { bucket: 'forgot:ip', max: 30, windowSeconds: 60 * 60 },
  resetAccount: { bucket: 'reset:id', max: 5, windowSeconds: 15 * 60 },
  resetIp: { bucket: 'reset:ip', max: 50, windowSeconds: 15 * 60 },
} satisfies Record<string, Limit>;

const DEACTIVATED =
  'This account has been deactivated. Contact FetchGensan support if you think this is a mistake.';

const noSession = { auth: { autoRefreshToken: false, persistSession: false } } as const;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, noSession);

/** A fresh anon client per request: signing in mutates client state. */
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, noSession);
}

function requireIdentifier(value: unknown): LoginIdentifier {
  const id = parseLoginIdentifier(str(value));
  if (!id) {
    throw new HttpError(
      400,
      'Enter your mobile number (09xx xxx xxxx) or email address.',
      'invalid_identifier',
    );
  }
  return id;
}

function credentials(id: LoginIdentifier, password: string) {
  return id.kind === 'phone' ? { phone: id.value, password } : { email: id.value, password };
}

/**
 * Everything the apps need after sign-in, in one round trip. Permissions
 * are read AS the new user, through RLS, so this cannot report more than
 * the database would actually allow.
 */
async function sessionResponse(session: Session): Promise<Response> {
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    ...noSession,
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });

  const [{ data: profile }, { data: permissions }] = await Promise.all([
    asUser.from('profiles').select('full_name, role').eq('id', session.user.id).maybeSingle(),
    asUser.rpc('my_permissions'),
  ]);

  return json({
    session: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      token_type: session.token_type,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
    },
    user: {
      id: session.user.id,
      phone: session.user.phone ? `+${session.user.phone.replace(/^\+/, '')}` : null,
      email: session.user.email || null,
      full_name: profile?.full_name ?? '',
      account_type: profile?.role ?? 'customer',
    },
    permissions: (permissions as string[] | null) ?? [],
  });
}

async function isBlocked(userId: string): Promise<boolean> {
  const { data, error } = await admin
    .from('profiles')
    .select('is_blocked')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return data?.is_blocked ?? false;
}

// ---------------------------------------------------------------- login

async function login(req: Request): Promise<Response> {
  const body = await readJson<{ identifier: string; password: string }>(req);
  const id = requireIdentifier(body.identifier);
  const password = str(body.password);
  if (!password) throw new HttpError(400, 'Enter your password.', 'invalid_password');

  // IP first, so a script spraying many accounts from one address is cut
  // off without burning any single account's allowance.
  await hit(admin, LIMITS.loginIp, clientIp(req), 'Too many sign-in attempts from this network.');
  await hit(admin, LIMITS.loginAccount, id.value, 'Too many wrong passwords for this account.');

  const { data, error } = await anonClient().auth.signInWithPassword(credentials(id, password));

  if (error || !data.session) {
    const code = (error as { code?: string } | null)?.code ?? '';
    if (code === 'user_banned') throw new HttpError(403, DEACTIVATED, 'account_disabled');
    if (
      code === 'invalid_credentials' ||
      code === 'phone_not_confirmed' ||
      code === 'email_not_confirmed'
    ) {
      // One message for "no such account", "wrong password" and "never set a
      // password": telling them apart tells a stranger which numbers are
      // customers. The UI's hint covers the OTP-era accounts with no
      // password yet.
      throw new HttpError(
        401,
        'That mobile number or email and password do not match.',
        'invalid_credentials',
      );
    }
    console.error('signInWithPassword failed', error);
    throw new HttpError(
      502,
      'Sign-in is briefly unavailable. Please try again.',
      'auth_unavailable',
    );
  }

  if (await isBlocked(data.session.user.id)) {
    await admin.auth.admin.signOut(data.session.access_token, 'global');
    throw new HttpError(403, DEACTIVATED, 'account_disabled');
  }

  await clear(admin, LIMITS.loginAccount, id.value);
  return sessionResponse(data.session);
}

// ---------------------------------------------------------------- forgot

async function forgot(req: Request): Promise<Response> {
  const body = await readJson<{ identifier: string }>(req);
  const id = requireIdentifier(body.identifier);

  await hit(admin, LIMITS.forgotIp, clientIp(req), 'Too many reset requests from this network.');
  await hit(admin, LIMITS.forgotAccount, id.value, 'We have already sent several codes.');

  const auth = anonClient().auth;
  const { error } =
    id.kind === 'phone'
      ? // shouldCreateUser: false -- "forgot password" must never sign
        // someone up. For an unknown number this errors, and that error is
        // swallowed below so the response is identical either way.
        await auth.signInWithOtp({ phone: id.value, options: { shouldCreateUser: false } })
      : await auth.resetPasswordForEmail(id.value);

  if (error) console.info('reset code not sent', id.kind, error.code ?? error.message);

  return json(
    {
      ok: true,
      channel: id.kind === 'phone' ? 'sms' : 'email',
      message:
        id.kind === 'phone'
          ? 'If that number has an account, we have texted it a 6-digit code.'
          : 'If that email has an account, we have sent it a 6-digit code.',
    },
    202,
  );
}

// ---------------------------------------------------------------- reset

async function reset(req: Request): Promise<Response> {
  const body = await readJson<{ identifier: string; code: string; password: string }>(req);
  const id = requireIdentifier(body.identifier);
  const code = str(body.code).replace(/\s/g, '');
  const password = str(body.password);

  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit code.', 'invalid_code');
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem, 'weak_password');

  await hit(admin, LIMITS.resetIp, clientIp(req), 'Too many attempts from this network.');
  await hit(admin, LIMITS.resetAccount, id.value, 'Too many wrong codes.');

  const auth = anonClient().auth;
  const { data, error } =
    id.kind === 'phone'
      ? await auth.verifyOtp({ phone: id.value, token: code, type: 'sms' })
      : await auth.verifyOtp({ email: id.value, token: code, type: 'recovery' });

  if (error || !data.session || !data.user) {
    throw new HttpError(
      400,
      'That code is wrong or has expired. Request a new one.',
      'invalid_code',
    );
  }

  const userId = data.user.id;
  if (await isBlocked(userId)) {
    await admin.auth.admin.signOut(data.session.access_token, 'global');
    throw new HttpError(403, DEACTIVATED, 'account_disabled');
  }

  const { error: updateError } = await admin.auth.admin.updateUserById(userId, { password });
  if (updateError) {
    // Supabase's own policy (leaked-password check, if enabled) speaks here.
    throw new HttpError(400, updateError.message, 'weak_password');
  }

  // Whoever knew the old password must not stay signed in on another phone.
  await admin.auth.admin.signOut(data.session.access_token, 'global');

  await clear(admin, LIMITS.resetAccount, id.value);
  // A reset proves ownership, so it also lifts a sign-in lockout.
  await clear(admin, LIMITS.loginAccount, id.value);

  const { data: fresh, error: signInError } = await anonClient().auth.signInWithPassword(
    credentials(id, password),
  );
  if (signInError || !fresh.session) {
    console.error('sign-in after reset failed', signInError);
    throw new HttpError(
      502,
      'Your password was changed. Please sign in with it.',
      'signin_after_reset_failed',
    );
  }

  return sessionResponse(fresh.session);
}

// ---------------------------------------------------------------- router

serve(async (req) => {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');

  switch (subpath(req, 'auth')) {
    case '/login':
      return login(req);
    case '/password/forgot':
      return forgot(req);
    case '/password/reset':
      return reset(req);
    default:
      throw new HttpError(404, 'Not found.', 'not_found');
  }
});
