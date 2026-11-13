// Small shared building blocks, so every page looks and behaves the same.
import { useEffect, useId, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-emerald-700 text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500 border-transparent',
  secondary: 'bg-white text-slate-800 hover:bg-slate-50 border-slate-300 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-700 dark:hover:bg-slate-800',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100 border-transparent dark:text-slate-200 dark:hover:bg-slate-800',
  danger: 'bg-white text-red-700 hover:bg-red-50 border-red-300 dark:bg-slate-900 dark:text-red-400 dark:border-red-900 dark:hover:bg-red-950',
};

export function Button({ variant = 'secondary', busy, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={cx(
        'inline-flex min-h-9 items-center justify-center gap-2 rounded-md border px-3.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        className
      )}
    >
      {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

const FIELD = 'min-h-9 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(FIELD, props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(FIELD, 'pr-8', props.className)}>
      {children}
    </select>
  );
}

// A dropdown of checkboxes. Nothing ticked means "all". Not wrapped in a <label>,
// since the ticks inside are labels of their own.
export function MultiSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
  className,
}: {
  label: string;
  allLabel: string;
  options: [value: string, text: string][];
  selected: string[];
  onChange: (next: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const text = (value: string) => options.find(([v]) => v === value)?.[1] ?? value;
  const summary = !selected.length ? allLabel : selected.length === 1 ? text(selected[0]) : `${text(selected[0])} +${selected.length - 1}`;
  const toggle = (value: string) => onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  const row = 'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-slate-800 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800';

  return (
    <div ref={box} className={cx('relative flex min-w-0 flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400', className)}>
      <span id={`${id}-label`}>{label}</span>
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-labelledby={`${id}-label ${id}-value`}
        onClick={() => setOpen(!open)}
        className={cx(FIELD, 'flex items-center justify-between gap-2 text-left font-normal')}
      >
        <span id={`${id}-value`} className="truncate">
          {summary}
        </span>
        <ChevronDown className="size-4 shrink-0 text-slate-500" aria-hidden />
      </button>
      {open && (
        <div role="group" aria-labelledby={`${id}-label`} className="absolute top-full right-0 left-0 z-30 mt-1 max-h-72 min-w-48 overflow-auto rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <button type="button" className={cx(row, 'w-full font-medium')} onClick={() => onChange([])}>
            <Check className={cx('size-4', selected.length ? 'invisible' : 'text-emerald-600')} aria-hidden />
            {allLabel}
          </button>
          {options.map(([value, optionText]) => (
            <label key={value} className={row}>
              <input type="checkbox" className="size-4 accent-emerald-700" checked={selected.includes(value)} onChange={() => toggle(value)} />
              <span className="min-w-0 break-words">{optionText}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: string }) {
  return (
    <label className={cx('flex min-w-0 flex-col gap-1 text-xs font-medium text-slate-600 dark:text-slate-400', className)}>
      {label}
      {children}
      {hint && <span className="font-normal text-slate-500 dark:text-slate-400">{hint}</span>}
    </label>
  );
}

// accent: a colour along the top edge, such as a bank's.
export function Card({ title, actions, children, className, padded = true, accent }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean; accent?: string }) {
  return (
    <section
      className={cx('min-w-0 rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900', accent && 'border-t-4', className)}
      style={accent ? { borderTopColor: accent } : undefined}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</div>}
    </div>
  );
}

export function Banner({ tone = 'error', children }: { tone?: 'error' | 'info' | 'warning'; children: ReactNode }) {
  const tones = {
    error: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200',
    info: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
    warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100',
  };
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx('mb-4 flex gap-2 rounded-md border px-3 py-2 text-sm', tones[tone])}>
      {tone !== 'info' && <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <div>{children}</div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">{children}</p>;
}

export function Loading() {
  return (
    <div className="flex justify-center py-10 text-slate-500" role="status">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span className="sr-only">Loading</span>
    </div>
  );
}

export const TH = 'whitespace-nowrap px-3 py-2 text-left text-xs font-medium text-slate-600 dark:text-slate-400';
export const TD = 'px-3 py-2 align-top';
export const TR = 'border-t border-slate-100 dark:border-slate-800';

// A column heading that sorts the table when clicked.
export function SortHeader({ label, column, sort, dir, onSort, align }: { label: string; column: string; sort: string; dir: string; onSort: (column: string) => void; align?: 'right' }) {
  const active = sort === column;
  const Icon = active ? (dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th className={cx(TH, align === 'right' && 'text-right')} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" onClick={() => onSort(column)} className={cx('inline-flex items-center gap-1 hover:text-slate-900 dark:hover:text-white', active && 'text-slate-900 dark:text-white')}>
        {label}
        <Icon className={cx('size-3.5', !active && 'opacity-40')} aria-hidden />
      </button>
    </th>
  );
}

export function Pager({ offset, pageSize, total, onChange }: { offset: number; pageSize: number; total: number; onChange: (offset: number) => void }) {
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-sm dark:border-slate-800">
      <span className="text-slate-600 dark:text-slate-400">
        {offset + 1}–{Math.min(offset + pageSize, total)} of {total.toLocaleString()}
      </span>
      <div className="flex gap-2">
        <Button aria-label="Previous page" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - pageSize))}>
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <Button aria-label="Next page" disabled={offset + pageSize >= total} onClick={() => onChange(offset + pageSize)}>
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

// A modal for confirming a change that affects many records.
export function Confirm({ open, title, children, confirmLabel, onConfirm, onCancel, busy }: { open: boolean; title: string; children: ReactNode; confirmLabel: string; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} onCancel={onCancel} className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-lg border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100">
      <div className="p-5">
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-2 text-sm text-slate-600 dark:text-slate-300">{children}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
