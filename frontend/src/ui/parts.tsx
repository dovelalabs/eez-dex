/**
 * The small shared pieces — RD-2 §7 preamble, FE-11.
 *
 * Empty, loading and error are components here rather than a `null` return
 * scattered through the views, because the preamble makes them first-class:
 * every panel has to be able to say *why* it is showing nothing, and a quiet
 * chain has to look quiet rather than broken.
 */

import type { ReactNode } from "react";

/** A titled panel, with an optional aside on the right of its heading. */
export function Panel({
  title,
  aside,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="panel">
      <div className="row">
        <h2>{title}</h2>
        {aside === undefined ? null : <div className="row-tight small muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

/** A status pill. `tone` is the token, never a colour. */
export function Chip({
  tone = "",
  children,
  title,
}: {
  readonly tone?: "" | "ok" | "warn" | "bad" | "free" | "repair";
  readonly children: ReactNode;
  readonly title?: string | undefined;
}): React.JSX.Element {
  return (
    <span className={`chip ${tone}`} title={title}>
      {children}
    </span>
  );
}

/**
 * Nothing to show, and the reason.
 *
 * The reason is required. "No data" with no explanation is the failure mode
 * the §7 preamble is written against.
 */
export function Empty({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <p className="empty">{children}</p>;
}

/** A short aside that is not an error: a fact about the state on screen. */
export function Notice({
  tone = "",
  children,
}: {
  readonly tone?: "" | "warn" | "bad" | "free" | "repair";
  readonly children: ReactNode;
}): React.JSX.Element {
  return <p className={`notice ${tone}`}>{children}</p>;
}

/** A label and its value, aligned as a row of a definition list. */
export function Fact({
  label,
  value,
  title,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly title?: string | undefined;
}): React.JSX.Element {
  return (
    <div className="row" title={title}>
      <span className="small muted">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

/** A labelled input. */
export function Field({
  label,
  children,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
