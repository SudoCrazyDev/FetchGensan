'use client';

import { useMemo, useState } from 'react';

import { type Permission, type PermissionKey, type RoleSummary, humanizeError } from '@fetch/api';
import {
  useCreateRole,
  useDeleteRole,
  useMyPermissions,
  usePermissionCatalogue,
  useRoles,
  useUpdateRole,
} from '@fetch/api/react';

import { Shell } from '@/components/Shell';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorNote,
  Modal,
  TextField,
  inputClass,
} from '@/components/ui';

export default function RolesPage() {
  return (
    <Shell requires="users.view">
      <Roles />
    </Shell>
  );
}

function Roles() {
  const { data: roles, isLoading, error } = useRoles();
  const { data: catalogue = [] } = usePermissionCatalogue();
  const { data: mine = [] } = useMyPermissions();
  const [editing, setEditing] = useState<RoleSummary | 'new' | null>(null);

  const canEdit = mine.includes('roles.manage');
  const labelOf = useMemo(() => new Map(catalogue.map((p) => [p.key, p.label])), [catalogue]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Roles</h1>
          <p className="text-sm text-muted">
            A role is a named set of permissions. Give roles to people on the Users page.
          </p>
        </div>
        {canEdit ? <Button onClick={() => setEditing('new')}>New role</Button> : null}
      </div>

      {error ? (
        <ErrorNote>{humanizeError(error)}</ErrorNote>
      ) : isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(roles ?? []).map((role) => (
            <Card key={role.id} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="flex flex-wrap items-center gap-2 font-bold">
                    {role.name}
                    {role.is_system ? <Badge>Built in</Badge> : null}
                  </h2>
                  <p className="font-mono text-xs text-muted">{role.key}</p>
                </div>
                <span className="whitespace-nowrap text-sm text-muted">
                  {role.user_count} {role.user_count === 1 ? 'person' : 'people'}
                </span>
              </div>
              {role.description ? <p className="text-sm text-muted">{role.description}</p> : null}
              <div className="flex flex-wrap gap-1">
                {role.key === 'admin' ? (
                  <Badge tone="attention">Every permission</Badge>
                ) : role.permissions.length === 0 ? (
                  <span className="text-xs text-muted">No permissions</span>
                ) : (
                  role.permissions.map((p) => (
                    <Badge key={p} tone="progress">
                      {labelOf.get(p) ?? p}
                    </Badge>
                  ))
                )}
              </div>
              <div className="mt-auto pt-1">
                <Button variant="secondary" onClick={() => setEditing(role)}>
                  {canEdit && role.key !== 'admin' ? 'Edit' : 'View'}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing ? (
        <RoleModal
          role={editing === 'new' ? null : editing}
          catalogue={catalogue}
          mine={mine}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

/** "Shift lead" -> "shift_lead": the key a new role is saved under. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);
  return slug;
}

function RoleModal({
  role,
  catalogue,
  mine,
  canEdit,
  onClose,
}: {
  role: RoleSummary | null;
  catalogue: Permission[];
  mine: PermissionKey[];
  canEdit: boolean;
  onClose: () => void;
}) {
  const create = useCreateRole();
  const update = useUpdateRole();
  const remove = useDeleteRole();

  const isAdmin = role?.key === 'admin';
  const editable = canEdit && !isAdmin;

  const [name, setName] = useState(role?.name ?? '');
  const [key, setKey] = useState(role?.key ?? '');
  const [keyTouched, setKeyTouched] = useState(false);
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<PermissionKey>>(new Set(role?.permissions ?? []));
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  const busy = create.isPending || update.isPending || remove.isPending;
  const mutationError = create.error ?? update.error ?? remove.error;
  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);

  const groups = useMemo(() => {
    const out = new Map<string, Permission[]>();
    for (const p of catalogue) out.set(p.category, [...(out.get(p.category) ?? []), p]);
    return [...out.entries()];
  }, [catalogue]);

  const effectiveKey = role ? role.key : keyTouched ? key : slugify(name);

  function save() {
    setFieldError(null);
    if (!name.trim()) return setFieldError({ field: 'name', message: 'Give the role a name.' });
    if (!role && !/^[a-z][a-z0-9_]{1,39}$/.test(effectiveKey)) {
      return setFieldError({
        field: 'key',
        message: '2–40 lowercase letters, digits or underscores, starting with a letter.',
      });
    }
    const permissions = [...selected];
    if (role) {
      update.mutate(
        { roleId: role.id, name: name.trim(), description: description.trim(), permissions },
        { onSuccess: onClose },
      );
    } else {
      create.mutate(
        { key: effectiveKey, name: name.trim(), description: description.trim(), permissions },
        { onSuccess: onClose },
      );
    }
  }

  function deleteRole() {
    if (!role) return;
    if (!window.confirm(`Delete the ${role.name} role? This cannot be undone.`)) return;
    remove.mutate(role.id, { onSuccess: onClose });
  }

  return (
    <Modal
      title={role ? role.name : 'New role'}
      onClose={onClose}
      busy={busy}
      wide
      footer={
        editable ? (
          <>
            {role && !role.is_system ? (
              <Button
                variant="danger"
                className="mr-auto"
                onClick={deleteRole}
                disabled={busy || role.user_count > 0}
                title={
                  role.user_count > 0 ? 'Take this role off everyone who has it first.' : undefined
                }
              >
                Delete role
              </Button>
            ) : null}
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? 'Saving…' : role ? 'Save changes' : 'Create role'}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      {isAdmin ? (
        <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted">
          Admin is built in. It always has every permission, including any added later, and cannot
          be changed or deleted.
        </p>
      ) : role?.is_system && editable ? (
        <p className="rounded-lg bg-raised px-3 py-2 text-sm text-muted">
          {role.name} is built in: you can change what it can do, but not delete it.
        </p>
      ) : null}

      {role && role.user_count > 0 && editable ? (
        <p className="text-xs text-brand">
          Changes apply straight away to the {role.user_count}{' '}
          {role.user_count === 1 ? 'person' : 'people'} with this role.
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
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Shift lead"
          maxLength={60}
          error={errorFor('name')}
          disabled={!editable}
        />
        <TextField
          label="Key"
          value={effectiveKey}
          onChange={(e) => {
            setKeyTouched(true);
            setKey(e.target.value.toLowerCase());
          }}
          placeholder="shift_lead"
          maxLength={40}
          className="[&_input]:font-mono"
          error={errorFor('key')}
          hint={
            role
              ? 'Keys cannot change after a role is created.'
              : 'Used by code and scripts. Cannot change later.'
          }
          disabled={!editable || !!role}
        />
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-bold uppercase tracking-wide text-muted">Description</span>
          <textarea
            className={`${inputClass} min-h-16`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={280}
            placeholder="What is this role for?"
            disabled={!editable}
          />
        </label>
        <button type="submit" hidden />
      </form>

      <div className="flex flex-col gap-4">
        <h3 className="text-xs font-bold uppercase tracking-wide text-muted">Permissions</h3>
        {groups.map(([category, permissions]) => (
          <fieldset key={category} className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold">{category}</legend>
            {permissions.map((p) => {
              const checked = isAdmin || selected.has(p.key);
              const grantable = mine.includes(p.key);
              return (
                <Checkbox
                  key={p.key}
                  checked={checked}
                  disabled={!editable || (!checked && !grantable)}
                  disabledReason={
                    editable && !checked && !grantable
                      ? 'You cannot grant this because you do not have it yourself.'
                      : undefined
                  }
                  onChange={(on) => {
                    const next = new Set(selected);
                    if (on) next.add(p.key);
                    else next.delete(p.key);
                    setSelected(next);
                  }}
                  label={p.label}
                  description={p.description}
                />
              );
            })}
          </fieldset>
        ))}
      </div>

      <ErrorNote>{mutationError ? humanizeError(mutationError) : null}</ErrorNote>
    </Modal>
  );
}
