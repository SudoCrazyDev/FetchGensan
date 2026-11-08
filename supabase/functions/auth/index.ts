/**
 * Password sign-in and password reset, behind rate limits.
 *
 *   POST /auth/login             { identifier, password }
 *   POST /auth/password/forgot   { identifier }
 *   POST /auth/password/reset    { identifier, code, password }
 *   POST /auth/register/start    { full_name, email, phone, password }
 *   POST /auth/register/verify   { email, code }
 *   POST /auth/register/resend   { email }
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
 *   - forgot-password never reveals whether an account exists;
 *   - customers sign themselves up with an emailed code, even though public
 *     sign-up is off in Supabase Auth (see the register section).
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
  registerAccount: { bucket: 'register:id', max: 5, windowSeconds: 60 * 60 },
  registerIp: { bucket: 'register:ip', max: 30, windowSeconds: 60 * 60 },
  verifyAccount: { bucket: 'verify:id', max: 5, windowSeconds: 15 * 60 },
  verifyIp: { bucket: 'verify:ip', max: 50, windowSeconds: 15 * 60 },
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

// ---------------------------------------------------------------- register
//
// Customer self sign-up. Public sign-up stays OFF in Supabase Auth, so
// nobody can create an account by calling Auth directly with the
// publishable key that ships in the app; accounts are created here, with
// the service role, after these checks.
//
//   start   creates the account with the email UNconfirmed and the phone
//           held back in app_metadata, then Supabase emails a 6-digit code
//           (the "Confirm signup" template, supabase/templates/confirmation.html).
//   verify  checks the code, which confirms the email, then attaches the
//           phone and answers with a session.
//
// The phone is attached only after the email is proven, so a half-finished
// sign-up cannot be used to sign in by phone, and cannot squat a number.
// The phone itself is not verified -- the emailed code is the proof of
// identity this flow asks for.
//
// New profiles default to verified (staff-made and seeded accounts), so
// start marks a self-registered one unverified right after creating it.
// The rider app then asks for ID photos, and record_customer_document()
// approves the account once all four are in.

const NAME_MAX = 80;

function requireEmail(value: unknown): string {
  const id = parseLoginIdentifier(str(value));
  if (!id || id.kind !== 'email') {
    throw new HttpError(400, 'Enter a valid email address.', 'invalid_email');
  }
  return id.value;
}

function requirePhone(value: unknown): string {
  const raw = str(value);
  // The app shows a fixed +63; accept the number with or without it.
  const id = parseLoginIdentifier(raw.includes('@') ? '' : raw);
  if (!id || id.kind !== 'phone') {
    throw new HttpError(
      400,
      'Enter your mobile number after +63, e.g. 917 123 4567.',
      'invalid_phone',
    );
  }
  return id.value;
}

function requireName(value: unknown): string {
  const name = str(value).trim().replace(/\s+/g, ' ');
  if (name.length < 2) throw new HttpError(400, 'Enter your full name.', 'invalid_name');
  if (name.length > NAME_MAX) {
    throw new HttpError(400, `Keep your name under ${NAME_MAX} characters.`, 'invalid_name');
  }
  return name;
}

interface Lookup {
  email_user_id: string | null;
  email_confirmed: boolean;
  self_registered: boolean;
  phone_owner_id: string | null;
}

async function lookup(email: string, phone: string): Promise<Lookup> {
  const { data, error } = await admin.rpc('registration_lookup', {
    p_email: email,
    p_phone: phone,
  });
  if (error) throw error;
  const row = (data as Lookup[] | null)?.[0];
  return (
    row ?? {
      email_user_id: null,
      email_confirmed: false,
      self_registered: false,
      phone_owner_id: null,
    }
  );
}

const EMAIL_TAKEN = 'That email already has an account. Sign in instead, or use Forgot password.';
const PHONE_TAKEN =
  'That mobile number is already on an account. Sign in with it, or use a different number.';

async function sendCode(email: string): Promise<void> {
  const { error } = await anonClient().auth.resend({ type: 'signup', email });
  if (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code === 'over_email_send_rate_limit') {
      throw new HttpError(
        429,
        'We have sent several codes already. Wait a minute and try again.',
        'rate_limited',
      );
    }
    console.error('sign-up code not sent', code || error.message);
    throw new HttpError(502, 'We could not send the code. Please try again.', 'email_failed');
  }
}

async function registerStart(req: Request): Promise<Response> {
  const body = await readJson<{
    full_name: string;
    email: string;
    phone: string;
    password: string;
  }>(req);
  const fullName = requireName(body.full_name);
  const email = requireEmail(body.email);
  const phone = requirePhone(body.phone);
  const password = str(body.password);
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem, 'weak_password');

  await hit(admin, LIMITS.registerIp, clientIp(req), 'Too many sign-ups from this network.');
  await hit(admin, LIMITS.registerAccount, email, 'Too many sign-up attempts for this email.');

  const found = await lookup(email, phone);

  // Saying "already has an account" does tell a stranger the email is
  // registered. Every sign-up form does; the alternative is a customer who
  // cannot work out why no code ever arrives.
  if (found.email_user_id && (found.email_confirmed || !found.self_registered)) {
    throw new HttpError(409, EMAIL_TAKEN, 'email_taken');
  }
  if (found.phone_owner_id && found.phone_owner_id !== found.email_user_id) {
    throw new HttpError(409, PHONE_TAKEN, 'phone_taken');
  }

  const app_metadata = { self_registered: true, pending_phone: phone };
  const user_metadata = { full_name: fullName };

  let userId: string;
  if (found.email_user_id) {
    // They started before and never entered the code. Start over with what
    // they typed this time.
    userId = found.email_user_id;
    const { error } = await admin.auth.admin.updateUserById(userId, {
      password,
      user_metadata,
      app_metadata,
    });
    if (error) throw new HttpError(400, error.message, 'weak_password');
  } else {
    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata,
      app_metadata,
    });
    if (error) {
      const code = (error as { code?: string }).code ?? '';
      if (code === 'email_exists') throw new HttpError(409, EMAIL_TAKEN, 'email_taken');
      if (code === 'weak_password') throw new HttpError(400, error.message, 'weak_password');
      console.error('createUser failed', code || error.message);
      throw new HttpError(
        502,
        'Sign-up is briefly unavailable. Please try again.',
        'auth_unavailable',
      );
    }
    userId = created.user.id;
  }

  // Unverified until the ID photos are in; see the note above.
  const { error: profileError } = await admin
    .from('profiles')
    .update({ full_name: fullName, verified_at: null })
    .eq('id', userId);
  if (profileError) throw profileError;

  await sendCode(email);
  return json({ ok: true, email, message: 'We have emailed you a 6-digit code.' }, 202);
}

async function registerResend(req: Request): Promise<Response> {
  const body = await readJson<{ email: string }>(req);
  const email = requireEmail(body.email);

  await hit(admin, LIMITS.registerIp, clientIp(req), 'Too many requests from this network.');
  await hit(admin, LIMITS.registerAccount, email, 'We have already sent several codes.');

  const found = await lookup(email, '');
  if (found.email_user_id && !found.email_confirmed && found.self_registered) {
    await sendCode(email);
  }
  // Same answer either way, so this cannot be used to test addresses.
  return json({ ok: true, message: 'If that sign-up is waiting, we have sent a new code.' }, 202);
}

async function registerVerify(req: Request): Promise<Response> {
  const body = await readJson<{ email: string; code: string }>(req);
  const email = requireEmail(body.email);
  const code = str(body.code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'Enter the 6-digit code.', 'invalid_code');

  await hit(admin, LIMITS.verifyIp, clientIp(req), 'Too many attempts from this network.');
  await hit(admin, LIMITS.verifyAccount, email, 'Too many wrong codes. Request a new one.');

  const { data, error } = await anonClient().auth.verifyOtp({ email, token: code, type: 'email' });
  if (error || !data.session || !data.user) {
    throw new HttpError(
      400,
      'That code is wrong or has expired. Request a new one.',
      'invalid_code',
    );
  }

  const user = data.user;
  const meta = (user.app_metadata ?? {}) as { self_registered?: boolean; pending_phone?: string };
  const phone = meta.pending_phone;

  if (phone) {
    // Someone may have taken the number between start and now.
    const found = await lookup(email, phone);
    if (found.phone_owner_id && found.phone_owner_id !== user.id) {
      throw new HttpError(409, PHONE_TAKEN, 'phone_taken');
    }

    const { data: updated, error: updateError } = await admin.auth.admin.updateUserById(user.id, {
      phone,
      phone_confirm: true,
      app_metadata: { self_registered: true, pending_phone: null },
    });
    if (updateError) {
      const c = (updateError as { code?: string }).code ?? '';
      if (c === 'phone_exists') throw new HttpError(409, PHONE_TAKEN, 'phone_taken');
      throw updateError;
    }
    // handle_new_user() filed the email as the profile's phone; put the
    // real number there now, in the +63 form the rest of the app uses.
    const { error: profileError } = await admin
      .from('profiles')
      .update({ phone })
      .eq('id', user.id);
    if (profileError) throw profileError;

    // The session was issued a moment before the phone was attached.
    if (updated?.user) data.session.user = updated.user;
  }

  await clear(admin, LIMITS.verifyAccount, email);
  await clear(admin, LIMITS.registerAccount, email);
  return sessionResponse(data.session);
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
    case '/register/start':
      return registerStart(req);
    case '/register/verify':
      return registerVerify(req);
    case '/register/resend':
      return registerResend(req);
    default:
      throw new HttpError(404, 'Not found.', 'not_found');
  }
});
