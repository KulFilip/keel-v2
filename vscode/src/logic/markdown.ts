// A small, safe markdown renderer for agent answers in the webviews: every character of the text is escaped first, then
// only a few known tags are added (headings, lists, quotes, code blocks, inline code, bold, italic, http(s) links).
// A `path:line` becomes a link with data-open / data-line that the webview turns into "open this file here".

import { fileRefs } from "./format";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline markdown of one (unescaped) line. */
export function inline(text: string, linkFiles = true): string {
  // split out `code` first: nothing inside it is formatted
  const parts = text.split(/(`[^`\n]+`)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${esc(part.slice(1, -1))}</code>`;
      return formatText(part, linkFiles);
    })
    .join("");
}

function formatText(text: string, linkFiles: boolean): string {
  // links [label](http…) are kept aside before escaping so their URL survives intact
  const links: string[] = [];
  let t = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => {
      links.push(`<a href="${esc(url)}">${esc(label)}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    },
  );
  // file refs: on the raw text, then escaped piece by piece
  let html = "";
  if (linkFiles) {
    let at = 0;
    for (const r of fileRefs(t)) {
      html += styled(esc(t.slice(at, r.start)));
      html += `<a href="#" class="file-ref" data-open="${esc(r.path)}" data-line="${r.line}">${esc(t.slice(r.start, r.end))}</a>`;
      at = r.end;
    }
    html += styled(esc(t.slice(at)));
  } else {
    html = styled(esc(t));
  }
  t = html.replace(
    /\u0000(\d+)\u0000/g,
    (_m, n: string) => links[Number(n)] ?? "",
  );
  return t;
}

/** Bold and italic on already escaped text. */
function styled(s: string): string {
  return s
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
}

/** Markdown text as HTML (block level: fences, headings, lists, quotes, rules, paragraphs). */
export function renderMarkdown(text: string, linkFiles = true): string {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  const flushPara = () => {
    if (para.length)
      out.push(`<p>${para.map((l) => inline(l, linkFiles)).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list)
      out.push(
        `<${list.tag}>${list.items.map((i) => `<li>${inline(i, linkFiles)}</li>`).join("")}</${list.tag}>`,
      );
    list = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      flushList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1]))
        body.push(lines[i++]);
      const lang = fence[2] ? ` class="lang-${esc(fence[2])}"` : "";
      out.push(`<pre><code${lang}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      flushList();
      const n = Math.min(h[1].length + 2, 6); // inside a card: h1 → h3
      out.push(`<h${n}>${inline(h[2], linkFiles)}</h${n}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr>");
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul ?? ol)![1]);
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(q[1], linkFiles)}</blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list) {
      // a continuation line of the last item
      if (/^\s{2,}/.test(line)) {
        list.items[list.items.length - 1] += " " + line.trim();
        continue;
      }
      flushList();
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

/** The ref a path cited in an answer belongs to (0.18.57): the ref the answer read it from, else the answer's own. */
export function sourceRef(
  source: { ref?: string | null; paths?: Record<string, string> | null } | null | undefined,
  path: string,
): string | null {
  return source?.paths?.[path] ?? source?.paths?.[path.replace(/^\.\//, "")] ?? source?.ref ?? null;
}

const unesc = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Rendered markdown whose path:line links also name the ref their file is at (data-ref), so a click opens that file
 *  as the branch, review ref or commit the answer was made from has it. */
export function withFileRefs(
  html: string,
  source: { ref?: string | null; paths?: Record<string, string> | null } | null | undefined,
): string {
  if (!source) return html;
  return html.replace(/(<a href="#" class="file-ref" data-open=")([^"]*)(")/g, (m, a: string, p: string, b: string) => {
    const ref = sourceRef(source, unesc(p));
    return ref ? `${a}${p}${b} data-ref="${esc(ref)}"` : m;
  });
}
