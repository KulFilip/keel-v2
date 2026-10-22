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
