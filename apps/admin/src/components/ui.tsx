'use client';

/** Small shared pieces for the console. Tailwind classes, no component lib. */

import { useState, type ReactNode } from 'react';

import { humanizeError } from '@fetch/api';

export function Card({
  children,
  className = '',
  urgent = false,
}: {
  children: ReactNode;
  className?: string;
  urgent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-surface p-4 ${
        urgent ? 'urgent border-2' : 'border-line'
      } ${className}`}
    >
      {children}
    </div>
  );
}

const TONES = {
  neutral: 'bg-raised text-muted',
  progress: 'bg-info/15 text-info',
  success: 'bg-ok/15 text-ok',
  danger: 'bg-bad/15 text-bad',
  attention: 'bg-brand/15 text-brand',
} as const;

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled = false,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  className?: string;
}) {
  const styles = {
    primary: 'bg-brand text-bg hover:bg-brand-strong',
    secondary: 'bg-raised text-ink hover:bg-line border border-line',
    danger: 'bg-bad/15 text-bad hover:bg-bad/25',
  }[variant];

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-40 disabled:cursor-not-allowed ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3">
      <div className="text-[11px] font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${tone ?? ''}`}>{value}</div>
    </div>
  );
}

export const inputClass =
  'w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink outline-none placeholder:text-muted/70 focus:border-brand disabled:opacity-50';

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="text-[11px] font-bold uppercase tracking-wide text-muted">{children}</span>
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </span>
  );
}

export function FieldRow({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <Label hint={hint}>{label}</Label>
      {children}
    </label>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  wide = false,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-[10vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`w-full ${wide ? 'max-w-3xl' : 'max-w-md'} rounded-xl border border-line bg-surface p-5 shadow-2xl`}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-muted hover:bg-raised hover:text-ink"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * A one-field prompt in a modal, replacing window.prompt -- which some
 * browsers suppress after a few uses and which cannot show a validation
 * message.
 */
export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  initialValue = '',
  confirmLabel = 'Confirm',
  danger = false,
  required = false,
  inputMode,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  danger?: boolean;
  required?: boolean;
  inputMode?: 'text' | 'decimal' | 'numeric';
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <PromptBody
        key={`${title}-${initialValue}`}
        description={description}
        label={label}
        placeholder={placeholder}
        initialValue={initialValue}
        confirmLabel={confirmLabel}
        danger={danger}
        required={required}
        inputMode={inputMode}
        busy={busy}
        error={error}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    </Modal>
  );
}

function PromptBody(props: {
  description?: ReactNode;
  label: string;
  placeholder?: string;
  initialValue: string;
  confirmLabel: string;
  danger: boolean;
  required: boolean;
  inputMode?: 'text' | 'decimal' | 'numeric';
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(props.initialValue);
  const blocked = props.required && value.trim() === '';

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) props.onConfirm(value);
      }}
    >
      {props.description ? <div className="text-sm text-muted">{props.description}</div> : null}
      <FieldRow label={props.label}>
        <input
          autoFocus
          className={inputClass}
          value={value}
          inputMode={props.inputMode}
          placeholder={props.placeholder}
          onChange={(e) => setValue(e.target.value)}
        />
      </FieldRow>
      {props.error ? <p className="text-sm text-bad">{props.error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={props.onCancel}>
          Cancel
        </Button>
        <SubmitButton variant={props.danger ? 'danger' : 'primary'} disabled={blocked || props.busy}>
          {props.busy ? 'Working…' : props.confirmLabel}
        </SubmitButton>
      </div>
    </form>
  );
}

export function SubmitButton({
  children,
  variant = 'primary',
  disabled = false,
}: {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
}) {
  const styles = {
    primary: 'bg-brand text-bg hover:bg-brand-strong',
    secondary: 'bg-raised text-ink hover:bg-line border border-line',
    danger: 'bg-bad/15 text-bad hover:bg-bad/25',
  }[variant];
  return (
    <button
      type="submit"
      disabled={disabled}
      className={`rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="text-sm text-bad">{humanizeError(error)}</p>;
}

export function Th({ children, right = false }: { children?: ReactNode; right?: boolean }) {
  return (
    <th
      className={`whitespace-nowrap px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-muted ${
        right ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  right = false,
  className = '',
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2.5 align-top ${right ? 'text-right tabular-nums' : ''} ${className}`}>
      {children}
    </td>
  );
}

const MANILA = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** Every timestamp in the console is shown in Manila time, whatever the browser says. */
export function manilaTime(iso: string | null | undefined): string {
  return iso ? MANILA.format(new Date(iso)) : '—';
}
