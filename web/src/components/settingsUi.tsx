// keel 0.18.57 the small pieces of the Settings page (docs: the redesign's Settings-*.dc.html mockups): a segmented
// control, a switch and a whole row that switches, a section that folds, a status pill, the letter tile, radio cards,
// a coloured note and the numbered steps of a login. Real buttons with aria-pressed / role="switch" / role="radio",
// so a keyboard and a screen reader use them like the native ones. The look is styles/settings.css (st-*).
// A plugin's settings piece (Jira, GitLab, Databases) uses the same ones through @keel/web-sdk.

import { useId, type KeyboardEvent, type ReactNode } from "react";

/** One choice out of a few, as a row of buttons: [ every AC | end of lane | end of flow ]. */
export function Seg<T extends string | number | boolean>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`ss-seg${className ? ` ${className}` : ""}`}
    >
      {options.map(([v, l]) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={v === value}
          disabled={disabled}
          onClick={() => v !== value && onChange(v)}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** The switch's track and knob (inside a button that has role="switch"). */
export const Knob = ({ on }: { on: boolean }) => (
  <span className={`ss-track${on ? " on" : ""}`} aria-hidden="true">
    <span />
  </span>
);

/** A small switch with its words next to it: [◯—] Only changed. */
export function Switch({
  on,
  onChange,
  children,
  disabled,
  className,
  id,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={on}
      disabled={disabled}
      className={`ss-sw${className ? ` ${className}` : ""}`}
      onClick={() => onChange(!on)}
    >
      <Knob on={on} />
      <span>{children}</span>
    </button>
  );
}

/** A whole row that switches: its title, one line of help, the switch on the right. */
export function SwitchRow({
  on,
  onChange,
  title,
  help,
  disabled,
  testId,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  title: ReactNode;
  help?: ReactNode;
  disabled?: boolean;
  testId?: string;
}) {
  const id = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-labelledby={`${id}-t`}
      aria-describedby={help ? `${id}-h` : undefined}
      disabled={disabled}
      className="ss-swrow"
      data-testid={testId}
      onClick={() => onChange(!on)}
    >
      <span className="ss-swrow-l">
        <span id={`${id}-t`} className="ss-swrow-t">
          {title}
        </span>
        {help && (
          <span id={`${id}-h`} className="ss-meta">
            {help}
          </span>
        )}
      </span>
      <Knob on={on} />
    </button>
  );
}

export type Tone = "ok" | "warn" | "run" | "bad" | "off" | "accent";
const PILL: Record<Tone, string> = {
  ok: "p-ok",
  warn: "p-warn",
  run: "p-run",
  bad: "p-bad",
  off: "p-idle",
  accent: "p-acc",
};

/** A status pill: a dot and a word, in the colour of its state. */
export const TonePill = ({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  title?: string;
}) => (
  <span className={`pill ss-pill ${PILL[tone]}`} title={title}>
    {children}
  </span>
);

/** The square with a letter (a provider, a plugin, a Jira project). */
export const Tile = ({
  children,
  on,
  className,
}: {
  children: ReactNode;
  on?: boolean;
  className?: string;
}) => (
  <span
    className={`ss-tile${on ? " on" : ""}${className ? ` ${className}` : ""}`}
    aria-hidden="true"
  >
    {children}
  </span>
);

/** A coloured note: an error, a warning, done, or plain information. */
export function Note({
  tone,
  children,
  role,
  className,
}: {
  tone: "err" | "warn" | "ok" | "info";
  children: ReactNode;
  role?: "alert" | "status" | "note";
  className?: string;
}) {
  return (
    <div
      className={`ss-note t-${tone}${className ? ` ${className}` : ""}`}
      role={role}
    >
      {children}
    </div>
  );
}

/** Radio cards: one choice with a title and a line each (What this keel does, How agents reach Claude, a cap's scope).
 *  The arrow keys move the choice, like native radio buttons. */
export function RadioCards<T extends string>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label?: string;
  labelledBy?: string;
  value: T;
  options: { id: T; title: ReactNode; sub?: ReactNode; side?: ReactNode }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const d =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (!d) return;
    e.preventDefault();
    const next = options[(i + d + options.length) % options.length];
    onChange(next.id);
    const box = e.currentTarget.parentElement;
    window.setTimeout(
      () =>
        box
          ?.querySelector<HTMLElement>(
            `[data-opt="${CSS.escape(String(next.id))}"]`,
          )
          ?.focus(),
      0,
    );
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`ss-opts${className ? ` ${className}` : ""}`}
    >
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={o.id === value}
          data-opt={o.id}
          disabled={disabled}
          tabIndex={
            o.id === value || (!options.some((x) => x.id === value) && i === 0)
              ? 0
              : -1
          }
          className="ss-opt"
          onClick={() => o.id !== value && onChange(o.id)}
          onKeyDown={(e) => move(e, i)}
        >
          <span className="ss-radio" aria-hidden="true">
            <span />
          </span>
          <span className="ss-opt-t">
            <b>{o.title}</b>
            {o.sub && <span className="ss-meta">{o.sub}</span>}
          </span>
          {o.side && <span className="ss-opt-s">{o.side}</span>}
        </button>
      ))}
    </div>
  );
}

/** A section that folds: its title and one line on the button, a count of what is changed, the rows under it. */
export function Fold({
  id,
  title,
  sub,
  open,
  onToggle,
  badge,
  children,
  testId,
}: {
  id: string;
  title: ReactNode;
  sub?: ReactNode;
  open: boolean;
  onToggle: () => void;
  badge?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="ss-card ss-foldcard"
      id={`st-${id}`}
      aria-labelledby={`st-${id}-h`}
      data-testid={testId}
    >
      <button
        type="button"
        className="ss-fold"
        aria-expanded={open}
        aria-controls={`st-${id}-b`}
        onClick={onToggle}
      >
        <span className="ss-fold-a" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="ss-fold-t">
          <span id={`st-${id}-h`} className="ss-fold-h">
            {title}
          </span>
          {sub && <span className="ss-meta">{sub}</span>}
        </span>
        {badge}
      </button>
      {open && (
        <div className="ss-fold-b" id={`st-${id}-b`}>
          {children}
        </div>
      )}
    </section>
  );
}

export type StepState = "todo" | "now" | "done" | "failed";
export type StepItem = { title: ReactNode; state: StepState; body?: ReactNode };

/** Numbered steps with a line between them (a login): ✓ for a done step, ! for a failed one, the current one in the
 *  accent colour with its own buttons under its title. */
export function Steps({
  steps,
  label = "Steps",
}: {
  steps: StepItem[];
  label?: string;
}) {
  return (
    <ol className="ss-steps" aria-label={label}>
      {steps.map((s, i) => (
        <li
          key={i}
          className={`ss-step s-${s.state}`}
          aria-current={
            s.state === "now" || s.state === "failed" ? "step" : undefined
          }
        >
          <span className="ss-step-rail" aria-hidden="true">
            <span className="ss-step-n">
              {s.state === "done" ? "✓" : s.state === "failed" ? "!" : i + 1}
            </span>
            {i < steps.length - 1 && <span className="ss-step-line" />}
          </span>
          <div className="ss-step-b">
            <span className="ss-step-h">
              <b>{s.title}</b>
              {s.state !== "todo" && i < steps.length - 1 && (
                <span className="ss-meta">
                  {s.state === "done"
                    ? "done"
                    : s.state === "failed"
                      ? "failed"
                      : "now"}
                </span>
              )}
            </span>
            {s.body}
          </div>
        </li>
      ))}
    </ol>
  );
}
