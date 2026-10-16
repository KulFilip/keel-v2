// Code in keel's colours: highlight.js (the highlighter the dashboard uses) finds the tokens, and each token class gets
// one of the palette's code roles (the web's --hl-* colours). A diff is green and red line by line.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import type { Paint, Role } from "./theme";
import { renderDiff } from "./diff";

const LANGS = { bash, css, diff, go, java, javascript, json, kotlin, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang);
const ALIAS: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", py: "python", sh: "bash",
  shell: "bash", zsh: "bash", console: "bash", kt: "kotlin", kts: "kotlin", yml: "yaml", html: "xml", md: "markdown", patch: "diff", rs: "rust" };

/** highlight.js's token classes → the palette's code roles (the web's hljs colours). */
export const CLASS_ROLE: Record<string, Role> = {
  keyword: "kw", built_in: "kw", literal: "kw", "selector-tag": "kw", meta: "faint", doctag: "kw",
  string: "str", regexp: "str", symbol: "str", "template-string": "str", subst: "fg",
  number: "num", comment: "com", quote: "com",
  title: "fn", "title.function": "fn", "title.function.invoke": "fn", function: "fn", section: "fn",
  attr: "attr", attribute: "attr", property: "attr", variable: "attr", "template-variable": "attr", params: "fg",
  type: "type", "title.class": "type", "title.class.inherited": "type", class: "type", "selector-class": "type", tag: "kw", name: "kw",
  addition: "add", deletion: "del",
};

export function language(name: string): string | null {
  const n = (name || "").toLowerCase();
  const l = ALIAS[n] ?? n;
  return l && hljs.getLanguage(l) ? l : null;
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (m) => ENT[m] ?? m);

/** highlight.js's HTML (nested <span class="hljs-…">) → text coloured by the innermost class that has a role. */
export function htmlToAnsi(html: string, p: Paint): string {
  const stack: (Role | null)[] = [];
  let out = "";
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) {
      const cls = m[1].split(/\s+/).map((c) => c.replace(/^hljs-/, "")).filter((c) => c !== "hljs");
      const key = cls.join(".").replace(/_$/, "");
      stack.push(CLASS_ROLE[key] ?? CLASS_ROLE[cls[0]] ?? null);
    } else if (m[0] === "</span>") stack.pop();
    else {
      const role = [...stack].reverse().find((r) => r !== null) ?? null;
      const text = unescape(m[2]);
      out += role ? p[role](text) : text;
    }
  }
  return out;
}

/** One code block, line by line (each line coloured on its own, so a terminal never carries a colour over). */
export function highlight(code: string, lang: string, p: Paint): string[] {
  const lines = code.split("\n");
  if (!p.colored) return lines;
  const l = language(lang) ?? (looksLikeDiff(code) ? "diff" : null);
  if (!l) return lines.map((x) => p.fg(x));
  if (l === "diff") return renderDiff(code, p);
  const html = hljs.highlight(code, { language: l, ignoreIllegals: true }).value;
  // a token may span lines (a block comment): close and reopen its colour on each line
  return splitHtmlLines(html).map((h) => htmlToAnsi(h, p));
}

function splitHtmlLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const m of html.matchAll(/<span class="[^"]+">|<\/span>|\n|[^<\n]+/g)) {
    const t = m[0];
    if (t === "\n") {
      out.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else {
      if (t.startsWith("<span")) open.push(t);
      else if (t === "</span>") open.pop();
      cur += t;
    }
  }
  out.push(cur);
  return out;
}

export const looksLikeDiff = (code: string) => /^(@@ |--- |\+\+\+ )/m.test(code) && /^[+-]/m.test(code);
