'use client';

/** Small shared pieces for the console. Tailwind classes, no component lib. */

import type { ReactNode } from 'react';

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
