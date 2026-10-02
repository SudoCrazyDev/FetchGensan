'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  type DirectoryUser,
  type PermissionKey,
  type RoleSummary,
  humanizeError,
} from '@fetch/api';
import {
  useCreateUser,
  useDeleteUser,
  useDirectoryUsers,
  useMyPermissions,
  useRoles,
  useSessionUser,
  useSetUserBlocked,
  useUpdateUser,
} from '@fetch/api/react';
import { formatPhPhone, parseLoginIdentifier, passwordProblem } from '@fetch/core';

import { Shell } from '@/components/Shell';
import {
  Badge,
  Button,
  Checkbox,
  EmptyNote,
  ErrorNote,
  Modal,
  TextField,
  inputClass,
} from '@/components/ui';
import { canGrant, canManage, generatePassword, timeAgo } from '@/lib/access';

type Filter = 'all' | 'staff' | 'riders' | 'customers' | 'deactivated';

const FILTERS: { key: Filter; label: string; test: (u: DirectoryUser) => boolean }[] = [
  { key: 'all', label: 'Everyone', test: () => true },
  { key: 'staff', label: 'Staff', test: (u) => u.roles.length > 0 },
  { key: 'riders', label: 'Riders', test: (u) => u.is_driver },
  { key: 'customers', label: 'Customers', test: (u) => !u.is_driver && u.roles.length === 0 },
  { key: 'deactivated', label: 'Deactivated', test: (u) => u.is_blocked },
];

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export default function UsersPage() {
  return (
    <Shell requires="users.view">
      <Users />
    </Shell>
  );
}

function Users() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<DirectoryUser | 'new' | null>(null);

  const debounced = useDebounced(search.trim(), 250);
  const { data: users, isLoading, error } = useDirectoryUsers(debounced);
  const { data: roles = [] } = useRoles();
  const { data: mine = [] } = useMyPermissions();

  const visible = useMemo(() => {
    const test = FILTERS.find((f) => f.key === filter)!.test;
    return (users ?? []).filter(test);
  }, [users, filter]);

  const canCreate = mine.includes('users.manage');

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Users</h1>
          <p className="text-sm text-muted">
            Customers, riders and staff. Staff access comes from the roles you give them.
          </p>
        </div>
        {canCreate ? <Button onClick={() => setEditing('new')}>New user</Button> : null}
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <input
          type="search"
          className={`${inputClass} md:max-w-sm`}
          placeholder="Search name, mobile number or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search users"
        />
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <Button
              key={f.key}
              variant={filter === f.key ? 'primary' : 'secondary'}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>
      </div>

      {error ? (
        <ErrorNote>{humanizeError(error)}</ErrorNote>
      ) : isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : visible.length === 0 ? (
        <EmptyNote
          title={debounced ? `Nobody matches “${debounced}”` : 'Nobody here yet'}
          body={
            debounced
              ? 'Search looks at names, mobile numbers and email addresses.'
              : canCreate
                ? 'Create the first account with New user.'
                : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-surface text-[11px] font-bold uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Mobile</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Roles</th>
                <th className="px-4 py-3">Last sign-in</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {visible.map((u) => (
                <tr key={u.id} className="bg-bg hover:bg-surface/60">
                  <td className="px-4 py-3">
                    <div className="font-semibold">{u.full_name || 'No name yet'}</div>
                    <div className="text-xs text-muted">
                      {u.is_driver ? 'Rider' : u.roles.length ? 'Staff' : 'Customer'}
                      {u.notes ? ` · ${u.notes}` : ''}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono tabular-nums">{formatPhPhone(u.phone)}</td>
                  <td className="px-4 py-3 text-muted">{u.email ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {u.roles.length ? (
                        u.roles.map((r) => (
                          <Badge key={r.id} tone={r.key === 'admin' ? 'attention' : 'progress'}>
                            {r.name}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted">{timeAgo(u.last_sign_in_at)}</td>
                  <td className="px-4 py-3">
                    {u.is_blocked ? (
                      <Badge tone="danger">Deactivated</Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" onClick={() => setEditing(u)}>
                      {canManage(u, roles, mine) ? 'Edit' : 'View'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(users?.length ?? 0) >= 100 ? (
        <p className="text-xs text-muted">
          Showing the 100 newest matches. Search to narrow it down.
        </p>
      ) : null}

      {editing === 'new' ? (
        <CreateUserModal roles={roles} mine={mine} onClose={() => setEditing(null)} />
      ) : editing ? (
        <EditUserModal user={editing} roles={roles} mine={mine} onClose={() => setEditing(null)} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- roles picker

function RolePicker({
  roles,
  mine,
  selected,
  onChange,
  disabled,
}: {
  roles: RoleSummary[];
  mine: PermissionKey[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted">Roles</legend>
      {roles.length === 0 ? (
        <p className="text-sm text-muted">No roles yet. Create one on the Roles page.</p>
      ) : (
        roles.map((role) => {
          const held = selected.has(role.id);
          const grantable = canGrant(role, mine);
          return (
            <Checkbox
              key={role.id}
              checked={held}
              disabled={disabled || (!held && !grantable)}
              disabledReason={
                !held && !grantable
                  ? 'You cannot grant this: it includes access you do not have.'
                  : undefined
              }
              onChange={(checked) => {
                const next = new Set(selected);
                if (checked) next.add(role.id);
                else next.delete(role.id);
                onChange(next);
              }}
              label={role.name}
              description={role.description || `${role.permissions.length} permissions`}
            />
          );
        })
      )}
      <p className="text-xs text-muted">
        No roles means a regular customer or rider account with no console access.
      </p>
    </fieldset>
  );
}

// ---------------------------------------------------------------- create

function CreateUserModal({
  roles,
  mine,
  onClose,
}: {
  roles: RoleSummary[];
  mine: PermissionKey[];
  onClose: () => void;
}) {
  const create = useCreateUser();

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(() => generatePassword());
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [created, setCreated] = useState<{ name: string; password: string } | null>(null);

  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);

  function submit() {
    setFieldError(null);
    if (!fullName.trim()) return setFieldError({ field: 'name', message: 'Enter their name.' });
    const parsedPhone = parseLoginIdentifier(phone);
    if (!parsedPhone || parsedPhone.kind !== 'phone') {
      return setFieldError({
        field: 'phone',
        message: 'Enter a PH mobile number (09xx xxx xxxx).',
      });
    }
    if (email.trim()) {
      const parsedEmail = parseLoginIdentifier(email);
      if (!parsedEmail || parsedEmail.kind !== 'email') {
        return setFieldError({
          field: 'email',
          message: 'That email address does not look right.',
        });
      }
    }
    const problem = passwordProblem(password);
    if (problem) return setFieldError({ field: 'password', message: problem });

    create.mutate(
      {
        fullName: fullName.trim(),
        phone: parsedPhone.value,
        email: email.trim(),
        password,
        roleIds: [...roleIds],
      },
      { onSuccess: () => setCreated({ name: fullName.trim(), password }) },
    );
  }

  if (created) {
    return (
      <Modal
        title="Account created"
        onClose={onClose}
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <p className="text-sm">
          <span className="font-semibold">{created.name}</span> can sign in now with their mobile
          number{email.trim() ? ' or email' : ''} and this temporary password:
        </p>
        <p className="select-all rounded-lg bg-raised px-4 py-3 text-center font-mono text-lg">
          {created.password}
        </p>
        <p className="text-xs text-muted">
          It is not shown again. Give it to them in person or by text; they can change it any time
          with Forgot password.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="New user"
      onClose={onClose}
      busy={create.isPending}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {create.isPending ? 'Creating…' : 'Create account'}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label="Full name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={errorFor('name')}
          className="sm:col-span-2"
        />
        <TextField
          label="Mobile number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="0917 123 4567"
          inputMode="tel"
          error={errorFor('phone')}
          hint="They can sign in with this."
        />
        <TextField
          label="Email (optional)"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@fetchgensan.ph"
          error={errorFor('email')}
          hint="Staff usually sign in with email."
        />
        <TextField
          label="Temporary password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errorFor('password')}
          className="sm:col-span-2 [&_input]:font-mono"
          autoComplete="off"
          spellCheck={false}
          trailing={
            <button
              type="button"
              className="text-xs font-semibold text-brand hover:underline"
              onClick={() => setPassword(generatePassword())}
            >
              Generate another
            </button>
          }
        />
        <div className="sm:col-span-2">
          <RolePicker roles={roles} mine={mine} selected={roleIds} onChange={setRoleIds} />
        </div>
        {/* Lets Enter submit from any field. */}
        <button type="submit" hidden />
      </form>
      <ErrorNote>{create.error ? humanizeError(create.error) : null}</ErrorNote>
    </Modal>
  );
}

// ---------------------------------------------------------------- edit

function EditUserModal({
  user,
  roles,
  mine,
  onClose,
}: {
  user: DirectoryUser;
  roles: RoleSummary[];
  mine: PermissionKey[];
  onClose: () => void;
}) {
  const { userId: me } = useSessionUser();
  const update = useUpdateUser();
  const setBlocked = useSetUserBlocked();
  const remove = useDeleteUser();

  const editable = canManage(user, roles, mine);
  const isMe = user.id === me;

  const [fullName, setFullName] = useState(user.full_name);
  const [notes, setNotes] = useState(user.notes ?? '');
  const [phone, setPhone] = useState(formatPhPhone(user.phone));
  const [email, setEmail] = useState(user.email ?? '');
  const [password, setPassword] = useState('');
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set(user.roles.map((r) => r.id)));
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const busy = update.isPending || setBlocked.isPending || remove.isPending;
  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);

  function save() {
    setFieldError(null);
    setActionError(null);

    if (!fullName.trim()) return setFieldError({ field: 'name', message: 'Enter their name.' });

    const parsedPhone = parseLoginIdentifier(phone);
    if (!parsedPhone || parsedPhone.kind !== 'phone') {
      return setFieldError({
        field: 'phone',
        message: 'Enter a PH mobile number (09xx xxx xxxx).',
      });
    }
    let normalizedEmail = '';
    if (email.trim()) {
      const parsedEmail = parseLoginIdentifier(email);
      if (!parsedEmail || parsedEmail.kind !== 'email') {
        return setFieldError({
          field: 'email',
          message: 'That email address does not look right.',
        });
      }
      normalizedEmail = parsedEmail.value;
    }
    if (password) {
      const problem = passwordProblem(password);
      if (problem) return setFieldError({ field: 'password', message: problem });
    }

    const profileChanged =
      fullName.trim() !== user.full_name || notes.trim() !== (user.notes ?? '');
    const before = new Set(user.roles.map((r) => r.id));
    const rolesChanged = before.size !== roleIds.size || [...roleIds].some((id) => !before.has(id));

    const credentials: { phone?: string; email?: string; password?: string } = {};
    if (parsedPhone.value !== user.phone) credentials.phone = parsedPhone.value;
    if (normalizedEmail !== (user.email ?? '')) credentials.email = normalizedEmail;
    if (password) credentials.password = password;

    if (!profileChanged && !rolesChanged && Object.keys(credentials).length === 0) {
      onClose();
      return;
    }

    update.mutate(
      {
        userId: user.id,
        profile: profileChanged ? { fullName: fullName.trim(), notes: notes.trim() } : undefined,
        roleIds: rolesChanged ? [...roleIds] : undefined,
        credentials,
      },
      { onSuccess: onClose },
    );
  }

  function toggleBlocked() {
    const verb = user.is_blocked ? 'Reactivate' : 'Deactivate';
    const consequence = user.is_blocked
      ? 'They will be able to sign in again.'
      : 'They will be signed out and cannot sign in until reactivated. Their history is kept.';
    if (!window.confirm(`${verb} ${user.full_name || 'this account'}? ${consequence}`)) return;
    setActionError(null);
    setBlocked.mutate(
      { userId: user.id, blocked: !user.is_blocked },
      { onSuccess: onClose, onError: (e) => setActionError(humanizeError(e)) },
    );
  }

  function deleteUser() {
    if (
      !window.confirm(
        `Delete ${user.full_name || 'this account'} permanently? This cannot be undone. ` +
          'Accounts with bookings cannot be deleted; deactivate those instead.',
      )
    ) {
      return;
    }
    setActionError(null);
    remove.mutate(user.id, {
      onSuccess: onClose,
      onError: (e) => setActionError(humanizeError(e)),
    });
  }

  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          {user.full_name || 'No name yet'}
          {user.is_blocked ? <Badge tone="danger">Deactivated</Badge> : null}
        </span>
      }
      onClose={onClose}
      busy={busy}
      wide
      footer={
        editable ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {!editable ? (
        <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted">
          {mine.includes('users.manage')
            ? 'This person has access you do not, so only someone with at least their access can change their account.'
            : 'You can look, but changing accounts needs the “Manage user accounts” permission.'}
        </p>
      ) : null}

      <form
        className="grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextField
          label="Full name"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          error={errorFor('name')}
          disabled={!editable}
          className="sm:col-span-2"
        />
        <TextField
          label="Mobile number"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          error={errorFor('phone')}
          disabled={!editable}
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="None"
          error={errorFor('email')}
          hint={editable ? 'Clear it to remove email sign-in.' : undefined}
          disabled={!editable}
        />
        {editable ? (
          <TextField
            label="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Leave blank to keep their current one"
            error={errorFor('password')}
            autoComplete="off"
            spellCheck={false}
            className="sm:col-span-2 [&_input]:font-mono"
            hint={password ? 'Tell them this password; it is not shown again.' : undefined}
            trailing={
              <button
                type="button"
                className="text-xs font-semibold text-brand hover:underline"
                onClick={() => setPassword(generatePassword())}
              >
                Generate
              </button>
            }
          />
        ) : null}
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-bold uppercase tracking-wide text-muted">
            Notes for dispatch
          </span>
          <textarea
            className={`${inputClass} min-h-20`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Prefers a text before arrival"
            disabled={!editable}
          />
        </label>
        <div className="sm:col-span-2">
          <RolePicker
            roles={roles}
            mine={mine}
            selected={roleIds}
            onChange={setRoleIds}
            disabled={!editable}
          />
        </div>
        <button type="submit" hidden />
      </form>

      <ErrorNote>{update.error ? humanizeError(update.error) : null}</ErrorNote>

      <dl className="grid grid-cols-2 gap-3 rounded-lg bg-raised/50 px-4 py-3 text-xs">
        <div>
          <dt className="text-muted">Account created</dt>
          <dd>{new Date(user.created_at).toLocaleDateString('en-PH', { dateStyle: 'medium' })}</dd>
        </div>
        <div>
          <dt className="text-muted">Last sign-in</dt>
          <dd>{timeAgo(user.last_sign_in_at)}</dd>
        </div>
      </dl>

      {editable && !isMe ? (
        <div className="flex flex-col gap-3 rounded-lg border border-bad/30 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm">
              <div className="font-semibold">{user.is_blocked ? 'Reactivate' : 'Deactivate'}</div>
              <div className="text-xs text-muted">
                {user.is_blocked
                  ? 'Let them sign in again.'
                  : 'Signs them out and blocks sign-in. Keeps their history.'}
              </div>
            </div>
            <Button
              variant={user.is_blocked ? 'secondary' : 'danger'}
              onClick={toggleBlocked}
              disabled={busy}
            >
              {user.is_blocked ? 'Reactivate' : 'Deactivate'}
            </Button>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
            <div className="text-sm">
              <div className="font-semibold">Delete account</div>
              <div className="text-xs text-muted">
                Only for accounts made by mistake. Anyone with bookings must be deactivated instead.
              </div>
            </div>
            <Button variant="danger" onClick={deleteUser} disabled={busy}>
              Delete
            </Button>
          </div>
          <ErrorNote>{actionError}</ErrorNote>
        </div>
      ) : null}
    </Modal>
  );
}
