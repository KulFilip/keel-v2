// v0.11.0 the Database plugin's tool window on the Code page, IntelliJ style. The side bar (DbExplorer) shows every
// connection as a tree: connection ▸ tables ▸ columns, with primary keys and foreign keys; a connection opens a query
// console, a table opens its data. The editor tab (DbTab) is a console (SQL, ⌘↵ runs the statement under the cursor or
// the selection, a history) or a table (its first 100 rows, and its structure). Reads run at once; a change of data is
// counted first and runs after Run it, on a local or test database only.
// The Database plugin's part (plugins/db): it imports only react and @keel/web-sdk.

import { ConsoleTab } from "./DbConsole";
import { TableTab } from "./DbTableTab";
import { parseDbPath } from "./dbModel";

export { dbPath, dbTabTitle, parseDbPath, statementAt } from "./dbModel";
export { DbExplorer } from "./DbExplorer";

export function DbTab({
  pid,
  path,
  onConn,
}: {
  pid: string;
  path: string;
  /** The console moved to another database: its tab follows (title and place). */
  onConn?: (conn: string) => void;
}) {
  const { conn, table } = parseDbPath(path);
  return table ? (
    <TableTab pid={pid} conn={conn} table={table} />
  ) : (
    <ConsoleTab pid={pid} initial={conn} onConn={onConn} />
  );
}
