// Base UI primitives: buttons, cards, badges, form fields, states, tabs, drawer, dialog.

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
import { TriangleAlert, Check, ChevronRight, CircleHelp, Copy, Inbox, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { cx } from '../lib/cx';
import { TONE_BADGE, TONE_DOT, permissionTone, riskTone, statusLabel, statusTone, type Tone } from '../lib/status';
import { errorMessage } from '../api/client';

// ------------------------------------------------------------------ buttons

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'xs' | 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent-600 text-white hover:bg-accent-700 disabled:bg-accent-600/50 dark:bg-accent-500 dark:hover:bg-accent-400 dark:disabled:bg-accent-500/40',
  secondary:
    'bg-white text-zinc-800 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 disabled:text-zinc-400 dark:bg-zinc-900 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-800 dark:disabled:text-zinc-500',
  ghost:
    'text-zinc-700 hover:bg-zinc-100 disabled:text-zinc-400 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:disabled:text-zinc-600',
  danger:
    'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50 dark:bg-red-600 dark:hover:bg-red-500',
  success:
    'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-600/50 dark:bg-emerald-600 dark:hover:bg-emerald-500',
};

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-7 px-2 text-xs gap-1',
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

const BUTTON_BASE =
  'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed dark:focus-visible:ring-offset-zinc-950';

/** A router link styled as a button (never a button inside a link). */
export function ButtonLink({
  to,
  variant = 'secondary',
  size = 'sm',
  icon,
  children,
  className,
}: {
  to: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link to={to} className={cx(BUTTON_BASE, VARIANT[variant], SIZE[size], className)}>
      {icon}
      {children}
    </Link>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', loading = false, icon, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        BUTTON_BASE,
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ layout blocks

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cx(
        'min-w-0 rounded-lg border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
      <div className="flex min-w-0 items-start gap-2">
        {icon && <span className="mt-0.5 text-zinc-500 dark:text-zinc-400">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('p-4', className)}>{children}</div>;
}

export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
        {icon && <span className={cx('text-zinc-400', tone && 'text-current')}>{icon}</span>}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{value}</p>
      {hint && <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p>}
    </div>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-zinc-500 dark:text-zinc-400">{item.label}</dt>
          <dd className="min-w-0 break-words text-zinc-900 dark:text-zinc-100">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('font-mono text-[0.8125rem]', className)}>{children}</span>;
}

// ------------------------------------------------------------------ badges

export function Badge({
  tone = 'gray',
  children,
  className,
  dot = false,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE_BADGE[tone],
        className,
      )}
    >
      {dot && <span className={cx('h-1.5 w-1.5 rounded-full', TONE_DOT[tone])} aria-hidden />}
      {children}
    </span>
  );
}

export function StatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const tone = statusTone(status);
  return (
    <Badge tone={tone} dot className={className}>
      {statusLabel(status)}
    </Badge>
  );
}

export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  if (!risk) return <Badge tone="gray">unknown risk</Badge>;
  return (
    <Badge tone={riskTone(risk)} title={`Risk: ${risk}`}>
      {risk}
    </Badge>
  );
}

export function PermissionBadge({ permission }: { permission: string | null | undefined }) {
  if (!permission) return <Badge tone="gray">inherit</Badge>;
  return (
    <Badge tone={permissionTone(permission)} title={`Permission: ${permission}`}>
      {permission}
    </Badge>
  );
}

// ------------------------------------------------------------------ states

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex items-center">
      <LoaderCircle className={cx('h-4 w-4 animate-spin text-zinc-400', className)} aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-zinc-500 dark:text-zinc-400" role="status">
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function ErrorState({
  error,
  title = 'Something went wrong',
  onRetry,
  compact = false,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      role="alert"
      className={cx(
        'flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
        compact ? 'p-3' : 'p-4',
      )}
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 break-words">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <Button size="xs" variant="secondary" onClick={onRetry} icon={<RefreshCw className="h-3.5 w-3.5" />}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
      <span className="mb-3 rounded-full bg-zinc-100 p-3 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        {icon ?? <Inbox className="h-5 w-5" aria-hidden />}
      </span>
      <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Alert({
  tone = 'amber',
  title,
  children,
  icon,
  className,
}: {
  tone?: 'amber' | 'red' | 'blue' | 'green' | 'gray';
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const styles = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200',
    red: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200',
    blue: 'border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
    gray: 'border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200',
  }[tone];
  return (
    <div className={cx('flex items-start gap-3 rounded-lg border p-3 text-sm', styles, className)}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cx(title ? 'mt-0.5' : undefined, 'break-words')}>{children}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ form fields

const CONTROL =
  'block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 shadow-sm placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/30 disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:disabled:bg-zinc-900 aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-red-500/30';

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
  required,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  htmlFor: string;
  required?: boolean;
  className?: string;
}) {
  return (
    <div className={cx('space-y-1', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
        {label}
        {required && (
          <span className="ml-0.5 text-red-600" aria-hidden>
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-zinc-500 dark:text-zinc-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(
  function Input({ className, mono, ...rest }, ref) {
    return <input ref={ref} className={cx(CONTROL, 'h-9', mono && 'font-mono', className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }
>(function Textarea({ className, mono, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(CONTROL, 'min-h-[5rem] py-2', mono && 'font-mono text-[0.8125rem] leading-relaxed', className)}
      spellCheck={mono ? false : undefined}
      {...rest}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(CONTROL, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  showLabel = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={showLabel ? undefined : label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex items-center gap-2 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-zinc-950"
    >
      <span
        className={cx(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-accent-600 dark:bg-accent-500' : 'bg-zinc-300 dark:bg-zinc-700',
        )}
      >
        <span
          className={cx(
            'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-0.5',
          )}
        />
      </span>
      {showLabel && <span className="text-sm text-zinc-800 dark:text-zinc-200">{label}</span>}
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-description` : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-zinc-300 text-accent-600 focus:ring-accent-500 dark:border-zinc-600 dark:bg-zinc-900"
      />
      <div className="text-sm">
        <label htmlFor={id} className="text-zinc-800 dark:text-zinc-200">
          {label}
        </label>
        {description && (
          <div id={`${id}-description`} className="text-xs text-zinc-500 dark:text-zinc-400">
            {description}
          </div>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tabs

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="-mb-px flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800"
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              const index = tabs.findIndex((t) => t.id === value);
              if (event.key === 'ArrowRight') onChange(tabs[(index + 1) % tabs.length]!.id);
              if (event.key === 'ArrowLeft') onChange(tabs[(index - 1 + tabs.length) % tabs.length]!.id);
            }}
            className={cx(
              'inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500',
              active
                ? 'border-accent-600 text-accent-700 dark:border-accent-400 dark:text-accent-300'
                : 'border-transparent text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="rounded-full bg-zinc-100 px-1.5 text-xs tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ overlays

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 'max-w-2xl',
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEscape(open, onClose);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-zinc-950/40" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(
          'relative flex h-full w-full flex-col border-l border-zinc-200 bg-white shadow-xl focus:outline-none dark:border-zinc-800 dark:bg-zinc-900',
          width,
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEscape(open, onClose);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-zinc-950/40" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative w-full max-w-md rounded-lg border border-zinc-200 bg-white shadow-xl focus:outline-none dark:border-zinc-800 dark:bg-zinc-900"
      >
        <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 id={titleId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h2>
        </div>
        <div className="px-4 py-3 text-sm text-zinc-700 dark:text-zinc-300">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">{footer}</div>
        )}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

// ------------------------------------------------------------------ code / JSON

export function CopyButton({ text, label = 'Copy', size = 'xs' }: { text: string; label?: string; size?: ButtonSize }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size={size}
      variant="secondary"
      icon={copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function CodeBlock({
  children,
  className,
  maxHeight = 'max-h-96',
  copy = false,
}: {
  children: string;
  className?: string;
  maxHeight?: string;
  copy?: boolean;
}) {
  return (
    <div className="relative">
      {copy && (
        <div className="absolute right-2 top-2">
          <CopyButton text={children} />
        </div>
      )}
      <pre
        className={cx(
          'overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs leading-relaxed text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-200',
          maxHeight,
          className,
        )}
      >
        {children}
      </pre>
    </div>
  );
}

export function JsonBlock({ value, maxHeight, copy }: { value: unknown; maxHeight?: string; copy?: boolean }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? 'null';
  return (
    <CodeBlock maxHeight={maxHeight} copy={copy}>
      {text}
    </CodeBlock>
  );
}

export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded text-xs font-medium text-zinc-600 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        <ChevronRight className={cx('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        {summary}
      </button>
      {open && (
        <div id={id} className="mt-2">
          {children}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ help on demand

/** The small "?" button that shows or hides a short explanation. */
export function HelpButton({
  label,
  open,
  controls,
  onToggle,
  className,
}: {
  label: string;
  open: boolean;
  controls: string;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cx(
        'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full align-middle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500',
        open
          ? 'bg-accent-50 text-accent-700 dark:bg-accent-950/60 dark:text-accent-300'
          : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200',
        className,
      )}
    >
      <CircleHelp className="h-4 w-4" aria-hidden />
    </button>
  );
}

/** The revealed explanation: one or two short sentences. */
export function HelpPanel({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <div
      id={id}
      className={cx(
        'max-w-2xl rounded-md bg-zinc-50 px-3 py-2 text-sm text-zinc-700 ring-1 ring-inset ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * A "?" button and its panel, placed separately: `button` next to a title, `panel(...)` under it.
 * Keyboard accessible (a real button with aria-expanded / aria-controls).
 */
export function useHelp(label = 'How this works') {
  const [open, setOpen] = useState(false);
  const id = useId();
  return {
    open,
    button: <HelpButton label={label} open={open} controls={id} onToggle={() => setOpen((v) => !v)} />,
    panel: (content: ReactNode, className?: string) =>
      open ? (
        <HelpPanel id={id} className={className}>
          {content}
        </HelpPanel>
      ) : null,
  };
}

/** A "?" with its explanation right under it (for a line of its own, or the end of a row). */
export function Help({ label = 'How this works', children, className }: { label?: string; children: ReactNode; className?: string }) {
  const help = useHelp(label);
  return (
    <div className={cx('min-w-0', className)}>
      {help.button}
      {help.panel(children, 'mt-1.5')}
    </div>
  );
}

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    // `relative` keeps absolutely positioned descendants (sr-only labels) inside the scroll area.
    <div className={cx('relative overflow-x-auto', className)}>
      <table className="w-full min-w-full divide-y divide-zinc-200 text-left text-sm dark:divide-zinc-800">
        {children}
      </table>
    </div>
  );
}

export const TH = 'whitespace-nowrap px-3 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
export const TD = 'px-3 py-2 align-top text-zinc-800 dark:text-zinc-200';
