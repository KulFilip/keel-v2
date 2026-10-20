// keel 0.18.28 PHP and the other languages the person's projects use: loaded on first use (a lazy chunk each), and the
// ones the project's stacks name, loaded when the project opens (GET /api/projects/:pid/languages).

import { render, waitFor } from "@testing-library/react";
import hljs from "highlight.js/lib/core";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CodeBlock } from "../components/Code";
import { MarkdownView } from "../components/Markdown";
import { highlight, languageOf, loadLanguage, normLang, setStackLanguages } from "../components/highlight";
import { loadProjectLanguages } from "../components/stackLanguages";
import { server } from "./setup";

describe("languageOf (0.18.28)", () => {
  it("knows the new file endings and names", () => {
    const want: Record<string, string> = {
      "src/Kernel.php": "php", "templates/a.phtml": "php", "templates/base.html.twig": "twig", "config/x.xml": "xml",
      "index.html": "xml", "a.htm": "xml", "translations/m.en.xlf": "xml", "logo.svg": "xml", "App.vue": "xml",
      "a.css": "css", "a.scss": "scss", "main.go": "go", "lib.rs": "rust", "app.rb": "ruby", "P.cs": "csharp",
      "a.c": "c", "a.h": "c", "a.cc": "cpp", "a.cpp": "cpp", "a.hpp": "cpp", "App.swift": "swift", "php.ini": "ini",
      "pyproject.toml": "ini", "app.properties": "ini", ".env.dist": "ini", Dockerfile: "dockerfile", Makefile: "makefile",
      "build.gradle": "groovy", "schema.graphql": "graphql", "q.gql": "graphql", "composer.lock": "json",
      "phpstan.neon": "yaml", "phpunit.xml.dist": "xml", "nginx.conf": "nginx",
    };
    for (const [path, lang] of Object.entries(want)) expect([path, languageOf(path)]).toEqual([path, lang]);
    expect(normLang("php")).toBe("php");
    expect(normLang("html")).toBe("xml");
  });

  it("every language a stack may name (content/highlight-languages.json) is built in or loads", async () => {
    const names = (JSON.parse(readFileSync(resolve(process.cwd(), "../content/highlight-languages.json"), "utf8")) as { names: string[] }).names;
    for (const n of names) expect([n, await loadLanguage(n)]).toEqual([n, true]);
  });
});

describe("a .php file is coloured", () => {
  it("in a code block, once its language arrives", async () => {
    const { container } = render(<CodeBlock text={'<?php\nfunction ranked(array $p): int { return 1; }\n'} path="src/Rank.php" />);
    await waitFor(() => expect(container.querySelector("code.language-php .hljs-keyword")).not.toBeNull());
  });

  it("in a Markdown ```php fence", async () => {
    const { container } = render(<MarkdownView text={"```php\n<?php\nclass A { public function b(): void {} }\n```"} />);
    await waitFor(() => expect(container.querySelector(".hljs-keyword, .hljs-title")).not.toBeNull());
  });
});

describe("the project's stack languages (0.18.28)", () => {
  it("are registered after the languages call, and a file ending only the stack names is coloured", async () => {
    server.use(http.get("/api/projects/:pid/languages", () =>
      HttpResponse.json({ languages: [{ name: "php", ext: ["php", "inc"], stacks: ["symfony"] }, { name: "yaml", ext: ["neon"] }] })));
    expect(languageOf("lib/legacy.inc")).toBeNull();
    await loadProjectLanguages("demo");
    expect(languageOf("lib/legacy.inc")).toBe("php");
    await waitFor(() => expect(hljs.getLanguage("php")).toBeTruthy());
    expect(highlight("<?php echo 1;", "php")).toContain("hljs-");
    // another project: its own list (an empty one keeps the static map only)
    server.use(http.get("/api/projects/:pid/languages", () => HttpResponse.json({ languages: [] })));
    await loadProjectLanguages("other");
    expect(languageOf("lib/legacy.inc")).toBeNull();
    expect(languageOf("src/Kernel.php")).toBe("php");
    setStackLanguages([]);
  });
});
