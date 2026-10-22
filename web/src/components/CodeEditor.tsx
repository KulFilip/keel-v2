// A small code editor: keel's highlighting (highlight.ts, the same as CodeBlock) under a transparent textarea, with
// line numbers. Errors given as {line, message} mark their line number and are listed under the editor; a click on one
// puts the caret on that line. Tab inserts two spaces (with several lines selected it indents each line); Escape
// then Tab leaves the editor, so a keyboard user is not trapped. v0.17.2 (the rule pack YAML); any language highlight.ts knows.

import { useMemo, useRef, type KeyboardEvent } from "react";
import { highlight, useLanguage } from "./highlight";

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
  const arrived = useLanguage(lang);
  const html = useMemo(() => {
    const text = value.endsWith("\n") ? value + " " : value;
    return highlight(text, lang) ?? escape(text);
  }, [value, lang, arrived]); // eslint-disable-line react-hooks/exhaustive-deps
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
  // After Escape the next Tab is not trapped (it moves focus on, like in any other field).
  const leave = useRef(false);
  /** Replace [from, to) with text the way typing does, so the browser's undo (Ctrl+Z) still works; then select [selA, selB). */
  const edit = (a: HTMLTextAreaElement, from: number, to: number, text: string, selA: number, selB: number) => {
    a.focus();
    a.setSelectionRange(from, to);
    let done = false;
    try { done = typeof document.execCommand === "function" && document.execCommand("insertText", false, text); } catch { done = false; }
    if (!done) { // no execCommand (jsdom, old browsers): write the text ourselves; native undo is lost then
      a.setRangeText(text, from, to, "end");
      onChange(a.value);
    }
    a.setSelectionRange(selA, selB);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { leave.current = true; return; }
    if (e.key !== "Tab") { leave.current = false; return; }
    if (e.shiftKey || readOnly || leave.current) return;
    e.preventDefault();
    const a = e.currentTarget;
    const { selectionStart: s, selectionEnd: t } = a;
    if (value.slice(s, t).includes("\n")) {
      // several lines selected: indent every line the selection touches (not a last line it only reaches the start of)
      const from = value.lastIndexOf("\n", s - 1) + 1;
      const lines = value.slice(from, t).split("\n");
      const n = lines.length - (lines[lines.length - 1] === "" ? 1 : 0);
      const block = lines.map((l, i) => (i < n ? "  " + l : l)).join("\n");
      edit(a, from, t, block, s + 2, t + 2 * n);
    } else {
      edit(a, s, t, "  ", s + 2, s + 2);
    }
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
            onChange={(e) => onChange(e.target.value)} onScroll={sync} onKeyDown={onKey} onBlur={() => { leave.current = false; }} wrap="off" />
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
