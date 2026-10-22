// ⌘/Ctrl+A in a code, diff or document view selects that view's own text, not the whole window. Core owns it so every part
// (Code, Code Review) shares one behaviour; plugins use it through @keel/web-sdk.

import { useEffect, useRef, type RefObject } from "react";
import { isTyping, modalOpen } from "./keys";

type Mark = { a: Node; ao: number; f: Node; fo: number; text: string | null };
/** The select-all each view made last (cleared as soon as the selection is something else). */
const allMarks = new WeakMap<HTMLElement, Mark>();

/** The whole text of the view when its ⌘/Ctrl+A selection is still the page's selection, else null. */
export function selectedAll(box: HTMLElement | null | undefined): string | null {
  if (!box) return null;
  const m = allMarks.get(box);
  const sel = window.getSelection?.();
  if (!m || !sel || sel.isCollapsed) return null;
  const same = sel.anchorNode === m.a && sel.anchorOffset === m.ao && sel.focusNode === m.f && sel.focusOffset === m.fo;
  return same ? m.text ?? sel.toString() : null;
}

const hovered = (el: HTMLElement) => {
  try {
    return el.matches(":hover");
  } catch {
    return false;
  }
};

/**
 * ⌘/Ctrl+A while the view has the focus (a click puts it there) or the pointer is on it selects the view's own text,
 * not the whole page. A text field keeps its own ⌘/Ctrl+A. `rows` names the elements that hold the text (the first one
 * to the last one is selected); `whole` is what a copy of that selection gives (a long file only renders the rows on
 * screen, so the copy gives the whole file from here).
 */
export function useSelectAll(box: RefObject<HTMLElement | null>, rows?: string, whole?: () => string) {
  const wholeRef = useRef(whole);
  wholeRef.current = whole;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "a" || e.defaultPrevented) return;
      const el = box.current;
      if (!el || isTyping(e.target) || modalOpen()) return;
      if (!el.contains(document.activeElement) && !hovered(el)) return;
      const sel = window.getSelection?.();
      if (!sel) return;
      e.preventDefault();
      const all = rows ? el.querySelectorAll(rows) : [];
      const first = all[0];
      const last = all[all.length - 1];
      if (first && last) {
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(last, last.childNodes.length);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        sel.selectAllChildren(el);
      }
      if (sel.anchorNode && sel.focusNode) {
        allMarks.set(el, { a: sel.anchorNode, ao: sel.anchorOffset, f: sel.focusNode, fo: sel.focusOffset, text: wholeRef.current?.() ?? null });
      }
    };
    const onCopy = (e: ClipboardEvent) => {
      const text = selectedAll(box.current);
      if (text === null || !wholeRef.current || !e.clipboardData) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("copy", onCopy);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("copy", onCopy);
    };
  }, [box, rows]);
}


/**
 * Brings `el` to the middle of `scroller` by setting scrollTop. Unlike el.scrollIntoView it never moves an ancestor (the
 * window, or the IDE box that must not scroll), so the code stays the one thing that scrolls.
 */
export function scrollToCenter(scroller: HTMLElement | null | undefined, el: HTMLElement | null | undefined) {
  if (!scroller || !el) return;
  const s = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = scroller.scrollTop + (r.top - s.top) - (scroller.clientHeight - r.height) / 2;
  scroller.scrollTop = Math.max(0, top);
}
