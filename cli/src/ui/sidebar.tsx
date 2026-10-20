// keel TUI's sidebar, opencode's way: on a wide terminal (120 columns or more) a column on the right with the chat's
// context (tokens of the model's window, how full, what it cost), the project's flow (its step, the gate that waits;
// a click opens it), the MCP servers KeelBot can use here, and the files this answer changed. Ctrl+B or /sidebar
// shows or hides it, and keel TUI keeps the choice. Every colour is a theme role; NO_COLOR draws it as plain text.

import React from "react";
import { Box, Text } from "ink";
import type { Snapshot, KeelbotServer } from "../core/keel";
import { AGENT_TOOLS } from "../core/buttons";
import * as fmt from "../core/format";
import { cutTo } from "../core/tools";
import { useTheme } from "./theme";
import { Clickable } from "./click";

/** The sidebar's width, its border included. */
export const SIDEBAR_WIDTH = 36;
/** The terminal's width from which it shows. */
export const SIDEBAR_MIN = 120;

/** A file this answer changed: its status (added, modified, deleted) and its lines added and removed. */
export type ChangedFile = {
  path: string;
  status: string;
  added: number;
  removed: number;
};

/** The files the running answer changed so far, from its write and edit steps (their diffs). */
export function filesOfSteps(
  steps: { kind: string; path?: string; diff?: string }[],
): ChangedFile[] {
  const out = new Map<string, ChangedFile>();
  for (const s of steps) {
    if ((s.kind !== "write" && s.kind !== "edit") || !s.path) continue;
    const lines = (s.diff ?? "").split("\n");
    const added = lines.filter(
      (l) => l.startsWith("+") && !l.startsWith("+++"),
    ).length;
    const removed = lines.filter(
      (l) => l.startsWith("-") && !l.startsWith("---"),
    ).length;
    const was = out.get(s.path);
    out.set(s.path, {
      path: s.path,
      status:
        was?.status ??
        (s.kind === "write" && /^--- \/dev\/null/m.test(s.diff ?? "")
          ? "added"
          : "modified"),
      added: (was?.added ?? 0) + added,
      removed: (was?.removed ?? 0) + removed,
    });
  }
  return [...out.values()];
}

export type SidebarActs = { flow: () => void; waiting: () => void };

export function Sidebar({
  s,
  servers,
  files,
  height,
  on,
}: {
  s: Snapshot;
  servers: KeelbotServer[] | null;
  files: ChangedFile[];
  height: number;
  on?: SidebarActs;
}) {
  const { color, look, paint } = useTheme();
  const inner = SIDEBAR_WIDTH - 3;
  const fit = (x: string) => cutTo(x, inner);
  const head = (x: string) => <Text {...look("heading", true)}>{x}</Text>;
  const gap = <Text> </Text>;
  const session = s.chat.session;
  const t = s.flow?.thread ?? null;
  const used = session?.ctx_tokens ?? 0;
  const win = session?.ctx_window ?? 0;
  const pct = win ? Math.round((100 * used) / win) : null;
  return (
    <Box
      flexDirection="column"
      width={SIDEBAR_WIDTH}
      height={height}
      overflow="hidden"
      paddingLeft={1}
      borderStyle="single"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={color("border")}
      borderDimColor={!!look("border").dimColor}
    >
      {head("Context")}
      {session ? (
        <>
          <Text wrap="truncate-end">
            {fmt.short(used)}
            <Text {...look("meta")}>
              {win ? ` / ${fmt.short(win)} tokens` : " tokens"}
            </Text>
          </Text>
          {pct !== null && (
            <Text
              {...look(pct >= 85 ? "bad" : pct >= 70 ? "warn" : "meta")}
            >{`${pct}% used`}</Text>
          )}
          <Text>
            {fmt.usd(session.cost_usd)}
            <Text {...look("meta")}> spent</Text>
          </Text>
        </>
      ) : (
        <Text {...look("meta")}>no chat yet</Text>
      )}
      {gap}
      {head("Flow")}
      {t ? (
        <Clickable act={on?.flow ?? (() => undefined)}>
          <Text wrap="truncate-end">
            <Text {...look("accent")}>{t.workflow_id}</Text>
            {` "${t.title}"`}
          </Text>
          <Text wrap="truncate-end">
            {fmt.badge(t.status, paint)}
            <Text {...look("meta")}>{` · step ${t.current || "-"}`}</Text>
          </Text>
          {t.waiting ? null : (
            <Text
              {...look("meta")}
              wrap="truncate-end"
            >{`phase ${t.phase || "none"}`}</Text>
          )}
        </Clickable>
      ) : (
        <Text {...look("meta")}>no flow · /flow starts one</Text>
      )}
      {t?.waiting && (
        <Clickable act={on?.waiting ?? (() => undefined)}>
          <Text {...look("gate", true)} wrap="truncate-end">
            {fit(`◆ waits: ${t.waiting.title}`)}
          </Text>
        </Clickable>
      )}
      {gap}
      {head("MCP")}
      {servers === null ? (
        <>
          <Text {...look("meta")}>{fit("keel's tools for KeelBot:")}</Text>
          <Text wrap="wrap">{AGENT_TOOLS.join(", ")}</Text>
        </>
      ) : servers.length === 0 ? (
        <Text {...look("meta")}>{fit("none in this project")}</Text>
      ) : (
        servers.slice(0, 8).map((m) => {
          const role =
            m.status === "ok" ? "ok" : m.status === "error" ? "bad" : "meta";
          const word =
            m.status === "ok"
              ? "connected"
              : m.status === "error"
                ? "failed"
                : m.status;
          return (
            <Text key={m.name} wrap="truncate-end">
              <Text {...look(role)}>
                {m.status === "ok" ? "● " : m.status === "error" ? "✗ " : "○ "}
              </Text>
              {cutTo(m.label, inner - 14).padEnd(Math.min(16, inner - 14))}
              <Text {...look(role)}>{" " + word}</Text>
            </Text>
          );
        })
      )}
      {gap}
      {head("Files changed")}
      {files.length === 0 ? (
        <Text {...look("meta")}>none in this answer</Text>
      ) : (
        files.slice(0, 10).map((f) => (
          <Text key={f.path} wrap="truncate-end">
            <Text
              {...look(
                f.status === "added"
                  ? "ok"
                  : f.status === "deleted"
                    ? "bad"
                    : "warn",
              )}
            >
              {f.status === "added"
                ? "A "
                : f.status === "deleted"
                  ? "D "
                  : "M "}
            </Text>
            {cutTo(f.path, inner - 12)}
            <Text {...look("add")}>{` +${f.added}`}</Text>
            <Text {...look("del")}>{` -${f.removed}`}</Text>
          </Text>
        ))
      )}
      {files.length > 10 && (
        <Text {...look("meta")}>{`… ${files.length - 10} more`}</Text>
      )}
    </Box>
  );
}
