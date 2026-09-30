/**
 * The parts of user management that need the Auth Admin API.
 *
 *   POST   /admin-users               { full_name, phone, email?, password, role_ids? }
 *   PATCH  /admin-users/:id           { phone?, email?, password? }
 *   POST   /admin-users/:id/block     { blocked }
 *   DELETE /admin-users/:id
 *
 * Creating a login, changing its phone/email/password, banning it and
 * deleting it all need the service-role key, which must never reach a
 * browser. Everything else about users and roles (names, notes, role
 * assignment, the role editor) is plain RPCs from the console.
 *
 * Authorisation is NOT decided here. Every request is checked by calling
 * the database AS THE CALLER -- has_permission(), can_manage_user(),
 * set_user_roles(), set_user_blocked() -- so the escalation and last-admin
 * guards in 20260930000100_rbac.sql apply to this function exactly as they
 * do to the console. The service-role client only acts once the database
 * has said yes.
 */

import { type AuthError, createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

import { HttpError, env, json, readJson, serve, str, subpath } from '../_shared/http.ts';
import { parseLoginIdentifier, passwordProblem } from '../_shared/identifier.ts';

const SUPABASE_URL = env('SUPABASE_URL');
const ANON_KEY = env('SUPABASE_ANON_KEY');
const SERVICE_ROLE_KEY = env('SUPABASE_SERVICE_ROLE_KEY');

const noSession = { auth: { autoRefreshToken: false, persistSession: false } } as const;
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, noSession);

// "Deactivated" is a ban with no practical end. Supabase refuses to refresh
// a banned user's session, so they are signed out within one access-token
// lifetime; has_permission() already treats them as having no access.
const BAN_FOREVER = '876000h';

interface Caller {
  id: string;
  db: SupabaseClient;
}

async function authenticate(req: Request): Promise<Caller> {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'Sign in first.', 'unauthenticated');

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) {
    throw new HttpError(401, 'Your session expired. Please sign in again.', 'unauthenticated');
  }

  const db = createClient(SUPABASE_URL, ANON_KEY, {
    ...noSession,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { id: data.user.id, db };
}

/** Runs an RPC as the caller; a refusal from the database becomes a 403/400/409. */
async function asCaller<T>(caller: Caller, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await caller.db.rpc(fn, args);
  if (error) {
    const status =
      error.code === '42501'
        ? 403
        : error.code === 'P0002'
          ? 404
          : error.code === '23503'
            ? 409
            : 400;
    throw new HttpError(status, error.message, error.code ?? 'rejected');
  }
  return data as T;
}

async function requireManage(caller: Caller, userId: string): Promise<void> {
  const allowed = await asCaller<boolean>(caller, 'can_manage_user', { p_user_id: userId });
  if (!allowed) {
    throw new HttpError(
      403,
      'You cannot change this account. You need "Manage user accounts", and at least the access they have.',
      'forbidden',
    );
  }
}

function authFailure(error: AuthError): HttpError {
  const message = error.message.toLowerCase();
  if (
    error.code === 'phone_exists' ||
    error.code === 'email_exists' ||
    message.includes('already')
  ) {
    return new HttpError(409, 'Someone already has that mobile number or email.', 'conflict');
  }
  if (error.code === 'weak_password') return new HttpError(400, error.message, 'weak_password');
  console.error('auth admin error', error);
  return new HttpError(
    502,
    'The account service did not accept that. Please try again.',
    'auth_error',
  );
}

function parsePhone(value: unknown): string {
  const id = parseLoginIdentifier(str(value));
  if (!id || id.kind !== 'phone') {
    throw new HttpError(400, 'Enter a PH mobile number (09xx xxx xxxx).', 'invalid_phone');
  }
  return id.value;
}

function parseEmail(value: unknown): string | null {
  const raw = str(value).trim();
  if (!raw) return null;
  const id = parseLoginIdentifier(raw);
  if (!id || id.kind !== 'email')
    throw new HttpError(400, 'That email address does not look right.', 'invalid_email');
  return id.value;
}

function parsePassword(value: unknown): string {
  const password = str(value);
  const problem = passwordProblem(password);
  if (problem) throw new HttpError(400, problem, 'weak_password');
  return password;
}

// ---------------------------------------------------------------- create

async function createUser(req: Request, caller: Caller): Promise<Response> {
  const has = await asCaller<boolean>(caller, 'has_permission', { p_permission: 'users.manage' });
  if (!has)
    throw new HttpError(403, 'You need the "Manage user accounts" permission.', 'forbidden');

  const body = await readJson<{
    full_name: string;
    phone: string;
    email: string;
    password: string;
    role_ids: string[];
  }>(req);

  const fullName = str(body.full_name).trim();
  if (!fullName) throw new HttpError(400, 'Enter their name.', 'invalid_name');
  const phone = parsePhone(body.phone);
  const email = parseEmail(body.email);
  const password = parsePassword(body.password);
  const roleIds = Array.isArray(body.role_ids) ? body.role_ids.map(str).filter(Boolean) : [];

  const { data, error } = await admin.auth.admin.createUser({
    phone,
    phone_confirm: true,
    ...(email ? { email, email_confirm: true } : {}),
    password,
    user_metadata: { full_name: fullName },
  });
  if (error || !data.user) throw authFailure(error!);

  const userId = data.user.id;

  if (roleIds.length > 0) {
    try {
      // As the caller: the database decides whether they may grant these.
      await asCaller(caller, 'set_user_roles', { p_user_id: userId, p_role_ids: roleIds });
    } catch (e) {
      // Do not leave a half-made account behind.
      await admin.auth.admin.deleteUser(userId);
      throw e;
    }
  }

  return json({ id: userId }, 201);
}

// ---------------------------------------------------------------- update

async function updateUser(req: Request, caller: Caller, userId: string): Promise<Response> {
  await requireManage(caller, userId);

  const body = await readJson<{ phone: string; email: string; password: string }>(req);
  const patch: Record<string, unknown> = {};

  const phone = body.phone !== undefined ? parsePhone(body.phone) : undefined;
  if (phone) Object.assign(patch, { phone, phone_confirm: true });

  if (body.email !== undefined) {
    const email = parseEmail(body.email);
    // An empty string removes the email login; the phone login remains.
    Object.assign(patch, email ? { email, email_confirm: true } : { email: '' });
  }

  if (body.password !== undefined && str(body.password) !== '') {
    patch.password = parsePassword(body.password);
  }

  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'Nothing to change.', 'empty_patch');
  }

  const { error } = await admin.auth.admin.updateUserById(userId, patch);
  if (error) throw authFailure(error);

  // handle_new_user() copies the phone into profiles only at sign-up.
  if (phone) {
    const { error: profileError } = await admin.from('profiles').update({ phone }).eq('id', userId);
    if (profileError) throw profileError;
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------- block

async function blockUser(req: Request, caller: Caller, userId: string): Promise<Response> {
  const body = await readJson<{ blocked: boolean }>(req);
  if (typeof body.blocked !== 'boolean') {
    throw new HttpError(400, '`blocked` must be true or false.', 'invalid_body');
  }

  // The database checks permission, self-deactivation and the last admin.
  await asCaller(caller, 'set_user_blocked', { p_user_id: userId, p_blocked: body.blocked });

  const { error } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: body.blocked ? BAN_FOREVER : 'none',
  });
  if (error) {
    // The profile flag already cuts off every permission; the ban is what
    // stops the session refreshing. Put the flag back so the two agree.
    await asCaller(caller, 'set_user_blocked', { p_user_id: userId, p_blocked: !body.blocked });
    throw authFailure(error);
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------- delete

async function deleteUser(caller: Caller, userId: string): Promise<Response> {
  if (userId === caller.id) {
    throw new HttpError(400, 'You cannot delete your own account.', 'self');
  }
  await requireManage(caller, userId);

  // Bookings, wallet entries and ratings reference the person. Deleting them
  // would either fail on a foreign key or erase dispute evidence, so an
  // account with any history can only be deactivated.
  const { count, error: countError } = await admin
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .or(`customer_id.eq.${userId},driver_id.eq.${userId}`);
  if (countError) throw countError;
  if ((count ?? 0) > 0) {
    throw new HttpError(
      409,
      'This person has booking history, so their account cannot be deleted. Deactivate it instead.',
      'has_history',
    );
  }

  // Dropping every role first runs the last-admin guard as the caller.
  await asCaller(caller, 'set_user_roles', { p_user_id: userId, p_role_ids: [] });

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    console.error('deleteUser failed', error);
    throw new HttpError(
      409,
      'This account is still referenced elsewhere and cannot be deleted. Deactivate it instead.',
      'has_history',
    );
  }

  return json({ ok: true });
}

// ---------------------------------------------------------------- router

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  const caller = await authenticate(req);
  const parts = subpath(req, 'admin-users').split('/').filter(Boolean);
  const [userId, action] = parts;

  if (parts.length === 0 && req.method === 'POST') return createUser(req, caller);

  if (!userId || !UUID.test(userId) || parts.length > 2) {
    throw new HttpError(404, 'Not found.', 'not_found');
  }

  if (!action && req.method === 'PATCH') return updateUser(req, caller, userId);
  if (!action && req.method === 'DELETE') return deleteUser(caller, userId);
  if (action === 'block' && req.method === 'POST') return blockUser(req, caller, userId);

  throw new HttpError(405, 'Method not allowed.', 'method_not_allowed');
});
