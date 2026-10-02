'use client';

/** Small shared pieces for the console. Tailwind classes, no component lib. */

import { type InputHTMLAttributes, type ReactNode, useEffect, useId, useRef, useState } from 'react';

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
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  className?: string;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const styles = {
    primary: 'bg-brand text-bg hover:bg-brand-strong',
    secondary: 'bg-raised text-ink hover:bg-line border border-line',
    danger: 'bg-bad/15 text-bad hover:bg-bad/25',
    ghost: 'text-brand hover:bg-raised',
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
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
  'w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-ink outline-none placeholder:text-muted/60 focus:border-brand disabled:opacity-50';

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

export function TextField({
  label,
  hint,
  error,
  trailing,
  className = '',
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  /** Rendered inside the label row, right-aligned -- e.g. a "Generate" link. */
  trailing?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-bold uppercase tracking-wide text-muted">
          {label}
        </label>
        {trailing}
      </div>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-note` : undefined}
        className={`${inputClass} ${error ? 'border-bad' : ''}`}
        {...input}
      />
      {error ? (
        <p id={`${id}-note`} className="text-xs text-bad">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-note`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  disabledReason,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 rounded-lg border border-line px-3 py-2.5 transition ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-raised'
      } ${checked ? 'border-brand/60 bg-brand/5' : ''}`}
      title={disabled ? disabledReason : undefined}
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--amber)]"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-semibold">{label}</span>
        {description ? <span className="text-xs text-muted">{description}</span> : null}
        {disabled && disabledReason ? (
          <span className="text-xs text-brand">{disabledReason}</span>
        ) : null}
      </span>
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

/**
 * A centred dialog. Escape and the backdrop close it unless `busy`, so a
 * save in flight cannot be abandoned half-way by a stray click.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  busy = false,
  wide = false,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  wide?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
    // Focus once on open, not on every busy flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`my-auto flex w-full flex-col rounded-2xl border border-line bg-surface shadow-2xl ${
          wide ? 'max-w-2xl' : 'max-w-lg'
        }`}
      >
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-lg font-bold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-xl leading-none text-muted hover:bg-raised hover:text-ink disabled:opacity-40"
          >
            ×
          </button>
        </div>
        <div className="flex flex-col gap-5 px-5 py-5">{children}</div>
        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-bad/10 px-3 py-2 text-sm text-bad">
      {children}
    </p>
  );
}

export function EmptyNote({ title, body }: { title: string; body?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <p className="font-semibold">{title}</p>
      {body ? <p className="max-w-md text-sm text-muted">{body}</p> : null}
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
    open ? (
    <Modal title={title} onClose={onCancel} busy={busy}>
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
    ) : null
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

/** ErrorNote for a caught error: renders nothing when there is none. */
export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <ErrorNote>{humanizeError(error)}</ErrorNote>;
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
