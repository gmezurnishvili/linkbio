"use client";

import { useEffect, useRef } from "react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
} from "react";
import type { Dimension } from "@/lib/api/types";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* Context dimensions keep one colour across the whole product: a blue chip in
   the rule builder, a blue rail segment on the block row, a blue line in the
   trace. Learning the palette once is the point. */
export const DIMENSION_TONE: Record<Dimension, { text: string; wash: string; bar: string }> = {
  country: { text: "text-geo", wash: "bg-geo-wash", bar: "bg-geo" },
  region: { text: "text-geo", wash: "bg-geo-wash", bar: "bg-geo" },
  device: { text: "text-device", wash: "bg-device-wash", bar: "bg-device" },
  os: { text: "text-device", wash: "bg-device-wash", bar: "bg-device" },
  language: { text: "text-device", wash: "bg-device-wash", bar: "bg-device" },
  referrer: { text: "text-muted", wash: "bg-sunk", bar: "bg-line-strong" },
  time: { text: "text-clock", wash: "bg-clock-wash", bar: "bg-clock" },
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "quiet" | "danger";
  size?: "sm" | "md";
};

export function Button({
  variant = "default",
  size = "md",
  className,
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-desk font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const sizes = { sm: "h-8 px-2.5 text-[0.8125rem]", md: "h-9 px-3 text-sm" };
  const variants = {
    default: "border border-line bg-panel hover:border-line-strong",
    primary: "bg-ink text-white hover:opacity-90",
    quiet: "text-muted hover:bg-sunk hover:text-ink",
    danger: "border border-alert/25 text-alert hover:bg-alert-wash",
  };
  return <button className={cx(base, sizes[size], variants[variant], className)} {...rest} />;
}

export function Chip({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "geo" | "device" | "clock" | "alert" | "live";
  className?: string;
}) {
  const tones = {
    neutral: "bg-sunk text-muted",
    geo: "bg-geo-wash text-geo",
    device: "bg-device-wash text-device",
    clock: "bg-clock-wash text-clock",
    alert: "bg-alert-wash text-alert",
    live: "bg-live-wash text-live",
  };
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.6875rem] leading-4",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  // A <label> with no text names the control it wraps as the empty string,
  // which is worse for a screen reader than no label element at all. Without
  // one, the control carries its own aria-label and this is only a layout box.
  const Wrapper = label ? "label" : "div";
  return (
    <Wrapper className="flex flex-col gap-1.5">
      {label ? <span className="text-[0.8125rem] text-muted">{label}</span> : null}
      {children}
      {error ? (
        <span role="alert" className="text-[0.75rem] text-alert">
          {error}
        </span>
      ) : hint ? (
        <span className="text-[0.75rem] text-faint">{hint}</span>
      ) : null}
    </Wrapper>
  );
}

const CONTROL =
  "h-9 w-full rounded-desk border border-line bg-panel px-2.5 text-sm outline-none focus:border-geo disabled:bg-sunk";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, className)} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: InputHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className={cx(CONTROL, "pr-7", className)} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-2.5 text-left disabled:opacity-50"
    >
      <span
        className={cx(
          "mt-0.5 flex h-[18px] w-[30px] flex-none items-center rounded-full p-0.5 transition-colors",
          checked ? "bg-ink" : "bg-line-strong",
        )}
      >
        <span
          className={cx(
            "h-[14px] w-[14px] rounded-full bg-white transition-transform",
            checked && "translate-x-[12px]",
          )}
        />
      </span>
      <span>
        <span className="block text-sm">{label}</span>
        {description ? (
          <span className="block text-[0.75rem] text-muted">{description}</span>
        ) : null}
      </span>
    </button>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Right-hand drawer.
 *
 * It covers the editor, so while it is open it has to behave like a modal
 * dialog even though it doesn't look like one: focus moves in, stays in, and
 * goes back to whatever opened it. Escape only ever worked if focus was already
 * inside, which it never was — the row that opens a sheet sits outside it.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!open || !root || !panel) return;

    const opener = document.activeElement;
    panel.focus();

    // Everything behind the scrim is unreachable by pointer already; `inert`
    // says the same to the tab order and to a screen reader. Walking the
    // sheet's own ancestors keeps this true without a portal.
    const held: HTMLElement[] = [];
    for (let node: HTMLElement | null = root; node && node !== document.body; ) {
      const parent: HTMLElement | null = node.parentElement;
      for (const sibling of Array.from(parent?.children ?? [])) {
        if (sibling === node || !(sibling instanceof HTMLElement) || sibling.inert) continue;
        sibling.inert = true;
        held.push(sibling);
      }
      node = parent;
    }

    return () => {
      for (const el of held) el.inert = false;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;

    const panel = panelRef.current;
    if (!panel) return;
    const stops = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) {
      e.preventDefault();
      return;
    }
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (!open) return null;
  return (
    <div ref={rootRef} className="fixed inset-0 z-40 flex justify-end" onKeyDown={onKeyDown}>
      <div
        className="absolute inset-0 bg-ink/15"
        onClick={onClose}
        role="presentation"
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-[26rem] flex-col border-l border-line bg-panel outline-none"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[0.9375rem] font-medium">{title}</h2>
          <Button variant="quiet" size="sm" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <footer className="flex items-center gap-2 border-t border-line px-4 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-desk border border-dashed border-line-strong px-5 py-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-[24rem] text-[0.8125rem] text-muted">{body}</p>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
