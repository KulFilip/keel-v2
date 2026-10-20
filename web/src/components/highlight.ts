// Syntax highlighting: highlight.js core with the languages agents usually touch built in (keeps the bundle small),
// and 0.18.28 more languages (PHP, XML/HTML, CSS, Go, Rust, ...) loaded with import() the first time a file of that
// type is shown. Until it arrives the text shows plain; useLanguage(lang) re-renders a view once it is there.
// hljs escapes the source itself, so its HTML output is safe to insert.

import { useEffect, useState } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("python", python);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("java", java);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("diff", diff);

type LangModule = { default: Parameters<typeof hljs.registerLanguage>[1] };
/** 0.18.28 the languages loaded on first use (each its own small chunk) */
const LAZY: Record<string, () => Promise<LangModule>> = {
  php: () => import("highlight.js/lib/languages/php"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  c: () => import("highlight.js/lib/languages/c"),
  swift: () => import("highlight.js/lib/languages/swift"),
  ini: () => import("highlight.js/lib/languages/ini"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  groovy: () => import("highlight.js/lib/languages/groovy"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  nginx: () => import("highlight.js/lib/languages/nginx"),
  twig: () => import("highlight.js/lib/languages/twig"),
  django: () => import("highlight.js/lib/languages/django"),
};
const loading = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();

/** Load a lazy language (once); true when hljs knows it now. */
export function loadLanguage(lang: string | null | undefined): Promise<boolean> {
  if (!lang) return Promise.resolve(false);
  if (hljs.getLanguage(lang)) return Promise.resolve(true);
  const get = LAZY[lang];
  if (!get) return Promise.resolve(false);
  let p = loading.get(lang);
  if (!p) {
    p = get().then((m) => {
      hljs.registerLanguage(lang, m.default);
      listeners.forEach((f) => f());
      return true;
    }, () => false);
    loading.set(lang, p);
  }
  return p;
}

/** keel 0.18.28 the project's stack languages (GET /api/projects/{id}/languages): file ending → highlight.js name.
 *  They come before the static map below, which stays for files outside any stack. */
let STACK_EXT: Record<string, string> = {};

/** The project's stack languages, as the api lists them: each one is loaded now (the built-in ones are there). */
export function setStackLanguages(list: { name: string; ext: string[] }[]): void {
  const next: Record<string, string> = {};
  for (const l of list ?? []) {
    if (!l?.name || !(hljs.getLanguage(l.name) || LAZY[l.name])) continue;
    for (const e of l.ext ?? []) next[String(e).replace(/^\./, "").toLowerCase()] = l.name;
    void loadLanguage(l.name);
  }
  STACK_EXT = next;
  listeners.forEach((f) => f());
}

/** A view that highlights `lang`: loads it when it is a lazy one, and re-renders once it is there (or when the
 *  project's stack languages change). The returned number changes then (put it in a useMemo's deps). */
export function useLanguage(lang: string | null | undefined): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const on = () => live && setN((x) => x + 1);
    listeners.add(on);
    if (lang && !hljs.getLanguage(lang) && LAZY[lang]) void loadLanguage(lang);
    return () => {
      live = false;
      listeners.delete(on);
    };
  }, [lang]);
  return n;
}

const EXT: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  json: "json", jsonc: "json",
  py: "python",
  kt: "kotlin", kts: "kotlin",
  java: "java",
  sh: "bash", bash: "bash", zsh: "bash", env: "bash",
  yml: "yaml", yaml: "yaml", neon: "yaml",
  md: "markdown", markdown: "markdown",
  sql: "sql",
  diff: "diff", patch: "diff",
  php: "php", phtml: "php", twig: "twig",
  xml: "xml", html: "xml", htm: "xml", xlf: "xml", svg: "xml", vue: "xml",
  css: "css", scss: "scss",
  go: "go", rs: "rust", rb: "ruby", cs: "csharp",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
  swift: "swift",
  ini: "ini", toml: "ini", properties: "ini",
  gradle: "groovy", groovy: "groovy",
  graphql: "graphql", gql: "graphql",
};
const NAMES: Record<string, string> = { Dockerfile: "dockerfile", Makefile: "makefile", ".env": "bash", "gradlew": "bash",
  "composer.lock": "json", "phpunit.xml.dist": "xml", ".env.dist": "ini", "nginx.conf": "nginx" };
const ALIAS: Record<string, string> = { ...EXT, shell: "bash", console: "bash", javascript: "javascript", typescript: "typescript",
  python: "python", kotlin: "kotlin", html: "xml", docker: "dockerfile", make: "makefile", "c++": "cpp", "c#": "csharp",
  golang: "go", rust: "rust", ruby: "ruby", toml: "ini" };

/** The highlight language for a file path, from its extension; null when we do not know it. */
export function languageOf(path: string | undefined | null): string | null {
  if (!path) return null;
  const name = path.split("/").pop() ?? path;
  if (NAMES[name]) return NAMES[name];
  if (/^Dockerfile\./.test(name) || name.endsWith(".Dockerfile") || name.endsWith(".dockerfile")) return "dockerfile";
  // phpunit.xml.dist, .env.dist: the type before .dist
  if (name.endsWith(".dist")) return languageOf(name.slice(0, -5)) ?? "xml";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return STACK_EXT[ext] ?? EXT[ext] ?? null;
}

/** A fence tag (```ts, ```kotlin …) as a registered language, or null. */
export function normLang(tag: string | undefined | null): string | null {
  if (!tag) return null;
  const t = tag.toLowerCase();
  const l = ALIAS[t] ?? t;
  return hljs.getLanguage(l) || LAZY[l] ? l : null;
}

/** Highlighted HTML for `code`, or null (unknown language, too big, or hljs failed). */
export function highlight(code: string, lang: string | null): string | null {
  if (!lang || code.length > 200_000) return null;
  if (!hljs.getLanguage(lang)) {
    void loadLanguage(lang);            // a lazy language: plain until it arrives (useLanguage re-renders)
    return null;
  }
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
