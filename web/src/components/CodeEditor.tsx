// A small code editor: keel's highlighting (highlight.ts, the same as CodeBlock) under a transparent textarea, with
// line numbers. Errors given as {line, message} mark their line number and are listed under the editor; a click on one
// puts the caret on that line. Tab inserts two spaces. v0.17.2 (the rule pack YAML); any language highlight.ts knows.

import { useMemo, useRef, type KeyboardEvent } from "react";
import { highlight } from "./highlight";

export type LineError = { line: number; message: string };

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function CodeEditor({ id, value, onChange, lang = "yaml", rows = 18, errors = [], label, readOnly }: {
  id: string; value: string; onChange: (v: string) => void; lang?: string; rows?: number; errors?: LineError[];
  label?: string; readOnly?: boolean;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  // a trailing newline needs a character after it, or the last empty line has no height in the <pre>
  const html = useMemo(() => {
    const text = value.endsWith("\n") ? value + " " : value;
    return highlight(text, lang) ?? escape(text);
  }, [value, lang]);
  const count = value.split("\n").length;
  const bad = new Map<number, string>();
  for (const e of errors) bad.set(e.line, bad.has(e.line) ? `${bad.get(e.line)}\n${e.message}` : e.message);

  const sync = () => {
    const a = area.current;
    if (!a) return;
    if (pre.current) {
      pre.current.scrollTop = a.scrollTop;
      pre.current.scrollLeft = a.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = a.scrollTop;
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab" || e.shiftKey || readOnly) return;
    e.preventDefault();
    const a = e.currentTarget;
    const { selectionStart: s, selectionEnd: t } = a;
    onChange(value.slice(0, s) + "  " + value.slice(t));
    requestAnimationFrame(() => a.setSelectionRange(s + 2, s + 2));
  };
  const goTo = (line: number) => {
    const a = area.current;
    if (!a) return;
    const at = value.split("\n").slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    a.focus();
    a.setSelectionRange(at, at);
    a.scrollTop = Math.max(0, (line - 3) * 19);
    sync();
  };

  return (
    <div className="ce-wrap">
      <div className="ce" style={{ height: `calc(${rows} * var(--ce-lh) + 2 * var(--ce-pad))` }}>
        <div className="ce-gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
            <span key={n} className={bad.has(n) ? "ce-bad" : undefined} title={bad.get(n)}>{n}</span>
          ))}
        </div>
        <div className="ce-body">
          <pre className="ce-pre" ref={pre} aria-hidden="true"><code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: html }} /></pre>
          <textarea id={id} ref={area} className="ce-input" value={value} spellCheck={false} autoCapitalize="off" autoComplete="off"
            aria-label={label} aria-invalid={errors.length > 0 || undefined} readOnly={readOnly}
            onChange={(e) => onChange(e.target.value)} onScroll={sync} onKeyDown={onKey} wrap="off" />
        </div>
      </div>
      {errors.length > 0 && (
        <ul className="ce-errors" role="alert" aria-label="Errors">
          {[...errors].sort((a, b) => a.line - b.line).map((e, i) => (
            <li key={i}><button type="button" className="ce-line" onClick={() => goTo(e.line)}>line {e.line}</button> {e.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
