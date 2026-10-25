// The Database plugin's dbModel, split out of DbTool.tsx (DbTool.tsx re-exports what index.tsx and the tests use).



export const KIND: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
};
const SEP = "::";

/** A database tab's path: `<connection>` is its console, `<connection>::<table>` a table. */
export const dbPath = (conn: string, table?: string) =>
  table ? `${conn}${SEP}${table}` : conn;
export function parseDbPath(path: string): { conn: string; table?: string } {
  const i = path.indexOf(SEP);
  return i < 0
    ? { conn: path }
    : { conn: path.slice(0, i), table: path.slice(i + SEP.length) };
}
export const dbTabTitle = (path: string) => {
  const { conn, table } = parseDbPath(path);
  return table ? `${table} · ${conn}` : `console · ${conn}`;
};

// keel 0.18.55: a name keel writes into SQL (the table tab, Map › Query) is quoted for its database when it needs it:
// "…" on PostgreSQL and SQLite, `…` on MySQL. PostgreSQL folds plain names to lower case, so a capital needs quotes there.
const RESERVED = new Set(
  ("all and any as asc between by case check column constraint create cross current_user default delete desc distinct drop " +
    "else end except exists false fetch for foreign from full grant group having in index inner insert intersect into is join " +
    "key left like limit natural not null offset on or order outer primary references right select session_user set some " +
    "table then to true union unique update user using values when where window with").split(" "),
);

export function quoteIdent(name: string, kind: string): string {
  const plain = kind === "postgres" ? /^[a-z_][a-z0-9_$]*$/ : /^[A-Za-z_][A-Za-z0-9_$]*$/;
  if (plain.test(name) && !RESERVED.has(name.toLowerCase())) return name;
  return kind === "mysql" ? "`" + name.replace(/`/g, "``") + "`" : '"' + name.replace(/"/g, '""') + '"';
}

/** A table as keel's schema names it: PostgreSQL's tables outside `public` come as schema.table. */
export function quoteTable(name: string, kind: string): string {
  const dot = name.indexOf(".");
  if (kind === "postgres" && dot > 0) {
    return `${quoteIdent(name.slice(0, dot), kind)}.${quoteIdent(name.slice(dot + 1), kind)}`;
  }
  return quoteIdent(name, kind);
}

export const tableSelect = (name: string, kind: string, limit: number) =>
  `SELECT * FROM ${quoteTable(name, kind)} LIMIT ${limit}`;

/** The text's statements (they end at `;` outside quotes), without the empty ones. */
export function statements(text: string): string[] {
  const out: string[] = [];
  let start = 0,
    quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === ";") {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The statement under the cursor (statements end at `;` outside quotes), or the selection when there is one. */
export function statementAt(
  text: string,
  from: number,
  to: number = from,
): string {
  if (to > from) return text.slice(from, to).trim();
  const parts: [number, number][] = [];
  let start = 0,
    quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === ";") {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, text.length]);
  const hit =
    parts.find(([a, b]) => from >= a && from <= b + 1) ??
    parts[parts.length - 1];
  const stmt = text.slice(hit[0], hit[1]).trim();
  return stmt || text.trim();
}

export function readStore(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* the console still works, unsaved */
  }
}
