/**
 * The FetchGensan mark and wordmark. Geometry comes from
 * brand/scripts/build.mjs -- regenerate there, then copy the paths here.
 */

const PIN =
  'M242.4 470.7 L123.9 319.8 A168 168 0 1 1 388.1 319.8 L269.6 470.7 Q256 488 242.4 470.7 Z';
const F = 'M190 128 H330 L317 178 H242 V198 H306 L293 246 H242 V304 H190 Z';

/** The pin mark alone. The F is painted in the page background colour. */
export function LogoMark({ className = 'h-7' }: { className?: string }) {
  return (
    <svg viewBox="88 48 336 440" className={className} aria-hidden="true">
      <path d={PIN} className="fill-mark" />
      <path d={F} className="fill-bg stroke-bg" strokeWidth={6} strokeLinejoin="round" />
    </svg>
  );
}

/** Mark plus wordmark, set live in the brand face. */
export function Logo({ size = 'md', label }: { size?: 'md' | 'lg'; label?: string }) {
  const lg = size === 'lg';
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark className={lg ? 'h-10' : 'h-7'} />
      <span className="flex flex-col leading-none">
        <span
          className={`font-brand font-extrabold tracking-[-0.02em] ${lg ? 'text-2xl' : 'text-lg'}`}
        >
          Fetch<span className="text-brand">Gensan</span>
        </span>
        {label && (
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
            {label}
          </span>
        )}
      </span>
    </span>
  );
}
