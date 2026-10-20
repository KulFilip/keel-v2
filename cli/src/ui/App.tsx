// keel TUI, the Ink app: the start screen, then the transcript (KeelBot's answers, commands' answers, keel's live
// notices) above a live area: KeelBot's streaming answer, a panel, the picker or the prompt, and the status line.
// The state is here; what commands do is in ../core (UI-free).
//
// Two ways to show it: the full screen (`rows`: keel's name stays at the top, the prompt at the bottom, the transcript
// between them scrolls with PgUp / PgDn, Shift+↑↓ and the wheel) and inline (no `rows`: the transcript goes into the
// terminal's own scrollback, for tests, --script and `keel2 tui --inline`).

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, measureElement, Static, Text, useApp, useInput, useStdin, useStdout, type DOMElement } from "ink";
import { complete, follow, pickMatches, questionChain, run, type Ask, type Block, type Completion, type Ctx, type PanelName, type Pick, type Reply } from "../core/commands";
import type { KeelCore, PermissionQuestion, Snapshot } from "../core/keel";
import { renderMarkdown } from "../core/markdown";
import { applyLevel, describeOverrides, makeTheme, withPalette, type Theme, type ThemeName } from "../core/theme";
import { ThemeProvider, useTheme } from "./theme";
import { pickVerb, Thinking } from "./thinking";
import * as fmt from "../core/format";
import { modelName, modelText } from "../core/effort";
import { answeredBy, thinkingLines, thoughtLine, THINKING_HEAD } from "../core/thinking";
import { BlockView, Completions, JobPanel, Panel, Picker, PluginPanel, StartScreen, StatusLine } from "./parts";
import { imagesIn, isPaste, Pastes, typingMention } from "../core/mentions";
import { pluginCommands } from "../core/plugins";
import { COMMANDS, THEME_HELP, messageBlock, setChanged, setPluginCommands } from "../core/commands";
import { renderDiff } from "../core/diff";
import { inboxApi } from "../../../web/src/inboxApi";
import type { Profiler } from "../core/profile";
import type { HelperMode } from "../core/sdk";
import { modelCatalog } from "../core/effort";
import { Clickable, ClicksProvider, makeClicks, placeOf } from "./click";
import { answersMessage, blockedByChanges, buttonWords, elsewhere, NOT_SENT_NEW_MESSAGE, prepare, pressButton, splitButtons, type Button } from "../core/buttons";
import { fixRequest } from "../../../web/src/askFix";
import { errorParts } from "../core/sdk";
import { api } from "../core/sdk";
import { blockLines, headerLine, isMouse, MOUSE, SCREEN, startLines, view, wheel, wrap } from "../core/lines";
import { isNewline, moveRow, promptRows } from "../core/prompt";
import { editText, findEditor } from "../core/editor";
import { osc52, pickCopy } from "../core/clipboard";
import { colsOn, highlight, mouseEvents, plain, selectedText, wordAt, type MouseEv, type Point } from "../core/select";
import type { ModeSession } from "../core/modes";
import { keyName, ModeView } from "./ModeView";
import { canOpen, toolBody, toolLines, type ToolCall } from "../core/tools";
import { memorySettings, type SettingsStore } from "../core/settings";
import { filesOfSteps, Sidebar, SIDEBAR_MIN, SIDEBAR_WIDTH, type ChangedFile } from "./sidebar";
import type { KeelbotServer } from "../core/keel";

/** `gap`: an empty line above it (the first block of each answer, so answers stand apart; notices in a row stay together) */
type Item = { id: number; kind: "start"; s: Snapshot } | { id: number; kind: "block"; b: Block; gap?: boolean };

/** What a driver (keel-tui --script, tests) can see of the app's state. */
export type Probe = { started: boolean; busy: boolean; pick: boolean; ask: boolean; chatBusy: boolean; answers: number };

/** `qid`: the KeelBot permission question this pick shows (it goes when the question ends elsewhere) */
type Pending = { cmd: string; pick?: Pick; ask?: Ask; qid?: string };

const CTRL_PANEL: Record<string, PanelName> = { f: "flow", a: "agents", n: "inbox" };
/** An open tool call in the live area shows at most this many of its last lines. */
const LIVE_TOOL_ROWS = 12;
/** a plugin's mode without the full screen (--inline, tests): this many rows */
const INLINE_MODE_ROWS = 20;
/** keel's panels, and a plugin's ("plugin:git") */
type PanelId = PanelName | `plugin:${string}` | `job:${string}`;
type Question = PermissionQuestion;
/** A selection with the mouse: in the transcript (`line` is the transcript's line) or in the prompt (line 0); `moved`
 *  once it covers more than the pressed cell (a plain click selects nothing). */
type Sel = { area: "view" | "prompt"; a: Point; b: Point; moved: boolean };
/** 0.18.18 the prompt history keeps this many (as opencode's, MIT: the last 50) */
const HISTORY_MAX = 50;
/** What /theme says after it changed the palette. */
const THEME_WORDS: Record<ThemeName, string> = { dark: "colours for a dark background", light: "colours for a light background",
  auto: "colours that read on any background" };
/** two presses on the same cell within this many ms: a double-click (the word under it) */
const DOUBLE_MS = 400;

/** keel TUI in keel's colours (the theme: core/theme.ts, NO_COLOR, KEEL_TUI_THEME; /theme changes the palette). */
export function App({ theme, ...props }: { core: KeelCore; probe?: Probe; width?: number; theme?: Theme; profiler?: Profiler; rows?: number; mouse?: boolean;
  /** keel TUI's settings (the sidebar on or off): the person's file from main.tsx; in memory without it */
  settings?: SettingsStore }) {
  const base = useMemo(() => theme ?? makeTheme(), [theme]);
  const [palette, setPalette] = useState<ThemeName | null>(null);
  const th = useMemo(() => (palette && palette !== base.name ? withPalette(base, palette) : base), [base, palette]);
  applyLevel(th);
  return <ThemeProvider theme={th} setPalette={setPalette}><Main {...props} /></ThemeProvider>;
}

function Main({ core, probe, width: fixedWidth, profiler, rows: fixedRows, mouse: mouseAtStart = false, settings: store }: { core: KeelCore; probe?: Probe; width?: number;
  profiler?: Profiler; rows?: number; mouse?: boolean; settings?: SettingsStore }) {
  const t = useTheme();
  // --profile: this frame's render and commit time (from here to the layout effect below)
  const frameStart = useRef(0);
  frameStart.current = performance.now();
  useLayoutEffect(() => {
    profiler?.frame(performance.now() - frameStart.current);
  });
  const { exit } = useApp();
  const { stdout } = useStdout();
  // a terminal may say 0 columns at first (docker exec -it sets the size a moment after the start): count it as 100
  // two columns free on the right: some terminals hide their last columns (a scrollbar, the Claude app's panel edge)
  // and a line that fills the last column wraps in others (0.18.8)
  const cols = () => Math.max(40, (stdout?.columns || 102) - 2);
  const [termWidth, setTermWidth] = useState(cols);
  const [termRows, setTermRows] = useState(fixedRows ?? 0);
  useEffect(() => {
    if (!stdout || fixedWidth) return;
    const on = () => {
      setTermWidth(cols());
      if (fixedRows) setTermRows(Math.max(12, stdout.rows || fixedRows));
    };
    stdout.on("resize", on);
    return () => void stdout.off("resize", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout, fixedWidth]);
  // the whole screen's width; `width` (below) is the transcript's: the whole width less the sidebar's, when it shows
  const fullWidth = fixedWidth ?? termWidth;
  const termCols = fixedWidth ?? termWidth + 2;
  // the full screen: its height (one row less than the terminal's, so Ink never scrolls it), else inline
  const screen = termRows > 0;
  const height = Math.max(11, termRows - 1);
  const [snap, setSnap] = useState<Snapshot>(core.snapshot);
  const [items, setItems] = useState<Item[]>([]);
  const [epoch, setEpoch] = useState(0);
  const [started, setStarted] = useState(false);
  const [line, setLine] = useState("");
  const [cursor, setCursor] = useState(0);
  // 0.18.18 the person's earlier prompts, newest first: keel's (the project's KeelBot chats), with what was sent here
  // since on top; hIdx: the one shown while ↑ / ↓ walk them (-1: not walking)
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;
  const [pickIdx, setPickIdx] = useState(0);
  const [pickFilter, setPickFilter] = useState("");
  // keel 0.18.9 a pick of several: what is ticked (Space), sent with Enter
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [panels, setPanels] = useState<PanelId[]>([]);
  const pastes = useRef(new Pastes());
  const questions = useRef<Question[]>([]);
  // KeelBot's buttons (start a flow, decide a gate, stop flows, a run mode): a yes / no each, after its answer
  const buttonAsks = useRef<Pick[]>([]);
  const [qTick, setQTick] = useState(0);
  const [running, setRunningState] = useState<string | null>(null);
  const runningSince = useRef<number | null>(null);
  const setRunning = (v: string | null) => {
    runningSince.current = v ? Date.now() : null;
    setRunningState(v);
  };
  const [comps, setComps] = useState<Completion[]>([]);
  const [compIdx, setCompIdx] = useState(0);
  const [botCmds, setBotCmds] = useState<{ name: string; description: string }[]>([]);
  const [answers, setAnswers] = useState(0);
  const [footer, setFooter] = useState<string | null>(null);
  const ctrlC = useRef(0);
  // 0.18.18 Ctrl+X, then E (or Ctrl+E): the prompt in the person's editor; when Ctrl+X came
  const ctrlX = useRef(0);
  const { stdin: inkStdin } = useStdin();
  // the full screen's scroll: lines up from the newest, the transcript area's height, and the wheel on or off
  const [offset, setOffset] = useState(0);
  const [viewH, setViewH] = useState(Math.max(3, height - 8));
  const viewRef = useRef<DOMElement>(null);
  const [mouse, setMouse] = useState(mouseAtStart);
  // select with the mouse and it is copied: the selection, and "copied N characters" for a few seconds
  const [sel, setSelState] = useState<Sel | null>(null);
  const selRef = useRef<Sel | null>(null);
  const setSel = (x: Sel | null) => {
    selRef.current = x;
    setSelState(x);
  };
  const [flash, setFlashState] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setFlash = (x: string | null) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = x ? setTimeout(() => setFlashState(null), 4000) : null;
    setFlashState(x);
  };
  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);
  const promptRef = useRef<DOMElement>(null);
  const lastPress = useRef({ t: 0, col: -1, row: -1 });
  const nextId = useRef(1);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  /** the inline screen: the tool call whose output Ctrl+O printed last */
  const shownTool = useRef<number | null>(null);
  // 0.18.6 a plugin's mode (core/modes.ts): it takes the screen between keel's header and the status line until Esc
  const [mode, setMode] = useState<ModeSession | null>(null);
  const [, setModeTick] = useState(0);
  const [modeH, setModeH] = useState(Math.max(6, height - 3));
  const modeRef = useRef<DOMElement>(null);
  // the sidebar (Ctrl+B, /sidebar): the person's choice, kept in keel TUI's settings; it shows on the full screen of a
  // terminal SIDEBAR_MIN columns wide or more
  const settings = useMemo(() => store ?? memorySettings(), [store]);
  const [sideOn, setSideOn] = useState(() => settings.get().sidebar !== false);
  const side = screen && !mode && sideOn && termCols >= SIDEBAR_MIN;
  const width = side ? fullWidth - SIDEBAR_WIDTH : fullWidth;
  const [servers, setServers] = useState<KeelbotServer[] | null>(null);
  // the files the last answer changed (its turn's changes), for the sidebar
  const [turnFiles, setTurnFiles] = useState<ChangedFile[]>([]);
  // the running turn's tool call opened in the live area (Ctrl+O, a click), by its step's n
  const [liveOpen, setLiveOpen] = useState<number | null>(null);

  const ctx: Ctx = useMemo(() => ({ core, width, paint: t.paint }), [core, width, t.paint]);
  // for the answer event's handler (it is set up once): the colours, the width and when the turn started
  const look = useRef({ paint: t.paint, width });
  look.current = { paint: t.paint, width };
  const turnStart = useRef<number | null>(null);
  // 0.18.23 KeelBot's thinking: the live block open (Ctrl+T, /thinking) or folded, and the last answer's thinking
  const [showThink, setShowThink] = useState(false);
  const lastThought = useRef<{ text: string; ms: number } | null>(null);
  if (snap.chat.startedAt) turnStart.current = snap.chat.startedAt;

  const push = useCallback((...bs: Block[]) => {
    if (!bs.length) return;
    const lastErr = [...bs].reverse().find((b) => b.kind === "error");
    if (lastErr) core.lastError = lastErr.text;               // /fix hands it to KeelBot (0.18.9)
    setItems((xs) => {
      const last = xs[xs.length - 1];
      const prev = last?.kind === "block" ? last.b.kind : last ? "start" : null;
      const gap = !!prev && prev !== "start" && bs[0].kind !== "user" && !(prev === "notice" && bs[0].kind === "notice");
      return [...xs, ...bs.map((b, i) => ({ id: nextId.current++, kind: "block" as const, b, gap: i === 0 && gap }))];
    });
  }, []);

  useEffect(() => {
    const offs = [
      core.on("change", (s) => setSnap(s)),
      core.on("notice", (t) => push({ kind: "notice", text: t })),
      // 0.18.6 the chat the dashboard has open (at the start, or when it opens another): its last messages
      core.on("chat", (s, why) => {
        const blocks: Block[] = [{ kind: "dim", text: `  ${why}: KeelBot chat "${s.title || s.id}" · ${s.mode}` }];
        (s.messages ?? []).slice(-4).forEach((m) => blocks.push(messageBlock(m)));
        push(...blocks);
      }),
      // 0.18.6 a question asked in this chat from the dashboard: shown as the person's own, then KeelBot answers here too
      core.on("remote", (text, by) => push({ kind: "user", text }, { kind: "dim", text: `  asked in ${by}` })),
      // KeelBot asks the person's OK for a command: an amber yes/no, one after the other
      core.on("question", (q) => {
        if (questions.current.some((x) => x.id === q.id)) return;
        questions.current.push(q);
        setQTick((n) => n + 1);
      }),
      // keel 0.18.18 answered in the dashboard, or KeelBot's turn ended: its card goes (an answer here does nothing more)
      core.on("questionGone", (id) => {
        questions.current = questions.current.filter((x) => x.id !== id);
        if (pendingRef.current?.qid === id) {
          setPending(null);
          push({ kind: "dim", text: "  KeelBot's question ended (answered elsewhere, or its answer ended)" });
        }
      }),
      core.on("answer", (a) => {
        const d = a.message?.data;
        const { paint, width: w } = look.current;
        const used = d ? [d.provider && d.model ? modelText(d) : "", d.tokens_in || d.tokens_out ? `${fmt.short((d.tokens_in ?? 0) + (d.tokens_out ?? 0))} tokens` : "",
          d.cost_usd ? `$${d.cost_usd.toFixed(2)}` : ""].filter(Boolean).join(" · ") : "";
        // what it did (one line per tool call, its output folded), the answer, then how the turn ended and what it used
        const calls = core.snapshot.chat.tools;
        const lastOpenable = calls.map(canOpen).lastIndexOf(true);
        const toolBlocks: Block[] = calls.map((c, i) => ({ kind: "tool", text: c.output, tool: c, ...(i === lastOpenable ? { hint: "Ctrl+O to show" } : {}) }));
        const ms = d?.ms ?? (turnStart.current ? Date.now() - turnStart.current : 0);
        const outcome = a.ok ? "done" : d?.status === "stopped" ? "stopped" : "failed";
        const { text: said, buttons } = a.ok ? splitButtons(a.text) : { text: a.text, buttons: [] };
        // 0.18.23 its thinking, folded to one line (Ctrl+T or /thinking shows it), then the answer and who answered
        const thought = typeof d?.thinking === "string" && d.thinking.trim() ? d.thinking : core.snapshot.chat.thinking || "";
        const thoughtMs = typeof d?.thinking_ms === "number" ? d.thinking_ms : 0;
        lastThought.current = thought ? { text: thought, ms: thoughtMs } : null;
        setShowThink(false);
        push(...(thought ? [{ kind: "dim" as const, text: thoughtLine(thoughtMs) }] : []),
          ...toolBlocks, { kind: a.ok ? "markdown" : "error", text: said || "(KeelBot gave buttons only)" },
          ...(d?.model ? [{ kind: "dim" as const, text: answeredBy(d.mode ?? core.snapshot.chat.mode, modelName(d), ms) }] : []));
        setLiveOpen(null);
        // keel 0.18.8 "✓ Finished …" sits on the prompt (the last turn's), with room between it and the answer above
        setFooter(fmt.turnFooter(outcome, ms, used ? `KeelBot · ${used}` : "KeelBot", paint));
        turnStart.current = null;
        if (buttons.length) void askButtons(buttons);
        setAnswers((n) => n + 1);
        // Edit, Fix and Side: the files THIS answer changed, with their diffs, and how to keep or undo them. Never the
        // folder's other uncommitted files (the person's, what keel init left): the answer's data names its own files
        // (0.18.20), and an answer that changed none (or an engine that does not say) shows no block at all.
        const mode = core.snapshot.chat.session?.mode ?? core.snapshot.chat.mode;
        const files = Array.isArray(d?.files) ? d.files : [];
        setTurnFiles([]);
        if ((mode === "fix" || mode === "side" || mode === "edit") && typeof d?.turn === "number" && files.length) {
          const sid = core.snapshot.chat.session?.id ?? "";
          void core.changes().then((all) => setChanged(sid, all.map((c) => c.path))).catch(() => undefined);   // /keep's Tab
          void core.changes(d.turn).then((ch) => {
            setTurnFiles(ch.map((c) => ({ path: c.path, status: c.status, added: c.added, removed: c.removed })));
            if (!ch.length) return;
            const p = look.current.paint;
            push({ kind: "text", text: `${p.bold(p.warn(`${ch.length} file(s) changed`))} ${p.dim("· not kept yet")}\n${fmt.changesText(ch, p, 16)}\n`
              + `${p.accent("/keep")} [path|all] ${p.dim("runs the checks and commits")} · ${p.accent("/undo")} [path|all] · ${p.accent("/changes")}` });
          }).catch(() => undefined);
        }
      }),
    ];
    let alive = true;
    void core.start().then((s) => {
      if (!alive) return;
      setItems([{ id: nextId.current++, kind: "start", s }]);
      setStarted(true);
      profiler?.ready();
      void core.keelbotCommands().then((c) => alive && setBotCmds(c));
      void modelCatalog().catch(() => undefined);          // read early: /model opens at once (0.18.9)
    });
    return () => {
      alive = false;
      offs.forEach((o) => o());
      core.stop();
    };
  }, [core, push]);

  /** After a failed button: stash and switch (a git switch the folder's changes block), ask KeelBot to find the fix, or
   *  leave it. */
  const fixPick = (b: Button, err: { message: string; hint?: string }, pid: string, name: (tid: string) => string): Pick => ({
    title: "It did not work. Find a fix?",
    choices: [
      ...(blockedByChanges(b, err.message) ? [{ label: "Stash my changes and switch", value: "stash", hint: "git stash pop on your branch brings them back" }] : []),
      { label: "Ask KeelBot to find a fix", value: "ask", hint: "it reads the error and the project, and proposes a fix you press" },
      { label: "No", value: "no" },
    ],
    then: async (v) => {
      if (v === "ask") return { blocks: [], chat: fixRequest(buttonWords(b), err) };
      if (v === "stash" && b.kind === "git") {
        try {
          const said = await pressButton({ ...b, stash: true }, pid, name);
          await core.refresh().catch(() => undefined);
          return { blocks: [{ kind: "ok", text: said }] };
        } catch (e) {
          const again = errorParts(e);
          return { blocks: [{ kind: "error", text: again.message }], pick: fixPick({ ...b, stash: true }, again, pid, name) };
        }
      }
      return { blocks: [{ kind: "dim", text: "  left as it is" }] };
    },
  });

  /** Each of KeelBot's buttons as a yes / no; one only the dashboard has says where to press it. */
  const askButtons = useCallback(async (buttons: Button[]) => {
    const pid = core.snapshot.project?.id;
    if (!pid) return;
    const rows = await api.runs(pid, undefined, 30).catch(() => []);
    const name = (tid: string) => {
      const r = rows.find((x) => x.thread_id === tid);
      return r ? `"${r.title}"` : `flow ${tid.slice(0, 8)}`;
    };
    for (const b of buttons) {
      // keel 0.18.9 KeelBot asks the person to choose: the questions one after the other, the answers back to it
      if (b.kind === "questions") {
        const first = await questionChain(b.questions, (a) => ({ blocks: [], chat: answersMessage(b.questions, a) }));
        if (first.blocks.length) push(...first.blocks);
        if (first.pick) buttonAsks.current.push(first.pick);
        continue;
      }
      // a new workflow or rule pack: keel's check first (it saves nothing), so the question says what it would be
      const prep = await prepare(b, pid, name).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
      if (!prep) {
        push({ kind: "dim", text: "  " + elsewhere(b) });
        continue;
      }
      if ("error" in prep) {
        push({ kind: "error", text: prep.error });
        continue;
      }
      if (prep.detail) push({ kind: "dim", text: prep.detail.split("\n").map((l) => "  " + l).join("\n") });
      const title = prep.title;
      buttonAsks.current.push({ title, choices: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], newMessage: NOT_SENT_NEW_MESSAGE,
        then: async (v) => {
          if (v !== "yes") return { blocks: [{ kind: "dim", text: "  Suggestion not sent: you chose No." }] };
          try {
            const said = await pressButton(b, pid, name);
            await core.refresh().catch(() => undefined);
            return { blocks: [{ kind: "ok", text: said }] };
          } catch (e) {
            // keel 0.18.9 a button that failed: a way out (stash and switch, when that is it) or KeelBot finds the fix
            const err = errorParts(e);
            return { blocks: [{ kind: "error", text: err.hint ? `${err.message} ${err.hint}` : err.message }], pick: fixPick(b, err, pid, name) };
          }
        } });
    }
    setQTick((n) => n + 1);
  }, [core, push]);

  // the next question KeelBot asks, when nothing else is being asked; then KeelBot's buttons
  useEffect(() => {
    if (!pending && !questions.current.length && buttonAsks.current.length) {
      setPending({ cmd: "KeelBot", pick: buttonAsks.current.shift()! });
      setPickIdx(0);
      setPickFilter("");
      return;
    }
    if (pending || !questions.current.length) return;
    const q = questions.current.shift()!;
    const deny = async (why: string) => {
      await inboxApi.decide(q.id, "deny", why);
      return { blocks: [{ kind: "dim" as const, text: `  refused: ${q.command}${why ? ` (${why})` : ""}` }] };
    };
    // keel 0.18.18 the warning (it throws work away, a flow works in this folder), what "in this chat" keeps (its
    // family: git checkout *), a deny with the person's reason (KeelBot reads it), and Esc says no
    setPending({ cmd: "KeelBot", qid: q.id, pick: { title: `KeelBot asks to run: ${q.command}${q.path ? ` (${q.path})` : ""}?${q.warning ? ` ⚠ ${q.warning}` : ""}`,
      choices: [{ label: "Allow once", value: "once" },
        ...(q.always !== "" ? [{ label: q.always && q.always !== q.command ? `Allow ${q.always} in this chat` : "Allow in this chat", value: "always",
          hint: q.always && q.always !== q.command ? "this command and its kind, for the rest of the chat" : "this command, for the rest of the chat" }] : []),
        { label: "Deny", value: "deny" },
        { label: "Deny, and say why", value: "why", hint: "KeelBot reads your reason and goes on from it" }],
      then: async (v) => {
        if (v === "why") return { blocks: [], ask: { prompt: `Why not ${q.command}? (KeelBot reads it)`, then: (why: string) => deny(why.trim()) } };
        if (v === "deny") return deny("");
        await inboxApi.decide(q.id, v);
        const kept = v === "always" && q.always && q.always !== q.command ? ` (${q.always})` : "";
        return { blocks: [{ kind: "ok", text: `allowed ${v === "always" ? "in this chat" : "once"}: ${q.command}${kept}` }] };
      },
      onCancel: () => deny("The person closed the question without an answer.") } });
    setPickIdx(0);
    setPickFilter("");
  }, [pending, qTick]);

  // 0.18.18 the prompt history comes from keel (it survives a restart, it is the same on another computer)
  const pidNow = snap.project?.id ?? null;
  useEffect(() => {
    if (!started || !pidNow) return;
    let alive = true;
    void core.prompts().then((ps) => {
      if (!alive) return;
      setHistory((h) => [...new Set([...h.filter((x) => !ps.includes(x)), ...ps])].slice(0, HISTORY_MAX));
      setHIdx(-1);
    }).catch(() => undefined);
    return () => void (alive = false);
  }, [core, started, pidNow]);

  // the sidebar's MCP servers: read when it shows, and again for another project
  useEffect(() => {
    if (!side || !started) return;
    let alive = true;
    void core.keelbotServers().then((x) => alive && setServers(x));
    return () => void (alive = false);
  }, [core, side, started, pidNow]);

  // what keel's plugins add: their commands
  useEffect(() => {
    const taken = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    setPluginCommands(pluginCommands(snap.plugins.plugins, taken));
  }, [snap.plugins]);

  // @mentions: the project's files, the code graph's symbols and the flow's criteria, as the person types
  useEffect(() => {
    const tm = line.startsWith("/") || hIdx >= 0 ? null : typingMention(line.slice(0, cursor));
    if (!tm) return;
    let alive = true;
    const timer = setTimeout(() => {
      void core.mentions.complete(tm.query).then((items) => {
        if (!alive) return;
        const before = line.slice(0, tm.start);
        const after = line.slice(cursor);
        setComps(items.map((i) => ({ value: `${before}@${i.value} ${after}`.replace(/ +$/, " "), label: i.label, hint: i.hint })));
        setCompIdx(0);
      });
    }, 60);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [core, line, cursor, hIdx]);

  useEffect(() => {
    if (!mode) return;
    mode.setPaint(t.paint);
    return mode.onChange(() => setModeTick((n) => n + 1));
  }, [mode, t.paint]);
  const leaveMode = useCallback(() => {
    if (!mode) return;
    push({ kind: "dim", text: `  left ${mode.mode.title}` });
    setMode(null);
  }, [mode, push]);

  if (probe) Object.assign(probe, { started, busy: running !== null, pick: !!pending?.pick, ask: !!pending?.ask, chatBusy: snap.chat.busy, answers });

  const handle = useCallback(async (reply: Reply, cmd: string) => {
    push(...reply.blocks);
    if (reply.follow) setPanels((ps) => [...ps.filter((x) => !x.startsWith("job:")), `job:${reply.follow}` as PanelId]);
    if (reply.panel) setPanels((ps) => (reply.panel === "off" ? [] : ps.includes(reply.panel as PanelId) ? ps : [...ps, reply.panel as PanelId]));
    if (reply.clear) {
      // a clean screen that still starts with keel's name, the project and what waits
      if (!screen) stdout?.write("\x1b[2J\x1b[3J\x1b[H");
      setItems([{ id: nextId.current++, kind: "start", s: core.snapshot }]);
      setOffset(0);
      setSel(null);
      setEpoch((e) => e + 1);
    }
    if (reply.theme) {
      t.setPalette(reply.theme);
      const kept = describeOverrides(t.overrides, t.styles);
      push({ kind: "ok", text: `theme ${reply.theme}: ${THEME_WORDS[reply.theme]}${kept.length ? `; your colours stay: ${kept.join(", ")}` : ""}` });
    }
    if (reply.themeInfo) {
      const kept = describeOverrides(t.overrides, t.styles);
      push({ kind: "ok", text: `theme ${t.name}${t.level ? "" : " (NO_COLOR: no colour)"}; ${kept.length ? `active colour overrides: ${kept.join(", ")}` : "no colour overrides"}` });
      for (const l of THEME_HELP) push({ kind: "dim", text: "  " + l });
    }
    if (reply.mouse !== undefined) {
      const on = reply.mouse === "toggle" ? !mouse : reply.mouse;
      if (!screen) push({ kind: "dim", text: "  The wheel scrolls in the full screen only (keel2 tui without --inline)." });
      else {
        stdout?.write(on ? MOUSE.on : MOUSE.off);
        setMouse(on);
        push({ kind: "ok", text: on ? "the wheel scrolls keel TUI; select text with the mouse and it is copied (Shift, or Option on a Mac, gives the terminal's own selection; or /copy, or /mouse off)" : "the wheel is the terminal's again: select text as usual; PgUp / PgDn scroll" });
      }
    }
    if (reply.copy !== undefined) {
      // 0.18.15 /copy: the n-th block from the end to the clipboard (OSC 52), also through docker exec and ssh
      const blocks = items.flatMap((it) => (it.kind === "block" ? [it.b] : []));
      const b = pickCopy(blocks, reply.copy);
      if (!b) push({ kind: "error", text: reply.copy === 1 ? "Nothing to copy yet." : `There are not ${reply.copy} blocks to copy.` });
      else {
        stdout?.write(osc52(b.text));
        const lines = b.text.split("\n").length;
        push({ kind: "ok", text: `copied ${lines} line${lines === 1 ? "" : "s"} to your clipboard` });
        push({ kind: "dim", text: "  Nothing arrived? Your terminal ignores clipboard requests (macOS Terminal does): /mouse off, then select the text." });
      }
    }
    if (reply.start) setItems((xs) => [...xs, { id: nextId.current++, kind: "start", s: core.snapshot }]);
    if (reply.pick) {
      setPending({ cmd, pick: reply.pick });
      setPickIdx(Math.min(reply.pick.index ?? 0, Math.max(0, reply.pick.choices.length - 1)));
      setPickFilter("");
    } else if (reply.ask) setPending({ cmd, ask: reply.ask });
    else setPending(null);
    if (reply.chat) {
      try {
        // the pastes behind their placeholders go whole; what the person pointed at with @ goes as mentions
        const { text: full, images: pasted } = pastes.current.expand(reply.chat);
        const mentions = core.mentions.mentionsIn(reply.chat);
        // 0.18.18 the images: pasted ones and the image files the prompt names go with the turn (the engine says which)
        const images = [...new Set([...pasted.map((i) => i.text), ...imagesIn(reply.chat.replace(/\[(pasted \d+ lines|image [^\]#]+) #\d+\]/g, " "))])];
        if (mentions.length) push({ kind: "dim", text: `  with ${mentions.map((m) => `@${m.value}`).join(" ")}` });
        if (core.shell) push({ kind: "dim", text: `  with the output of !${core.shell.command}` });
        pastes.current.clear();
        await core.send(full, mentions, images);
        const ti = core.turnImages;
        const name = (p: string) => p.split("/").pop() || p;
        if (ti.images.length) push({ kind: "dim", text: `  with the image${ti.images.length === 1 ? "" : "s"} ${ti.images.map(name).join(", ")}` });
        for (const x of ti.skipped) push({ kind: "dim", text: `  not sent: ${x.path}: ${x.why}` });
      } catch (e) {
        push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    }
    if (reply.thinking) toggleThinking();
    if (reply.sidebar !== undefined) toggleSidebar(reply.sidebar === "toggle" ? undefined : reply.sidebar, true);
    if (reply.mode) setMode(reply.mode);
    if (reply.editor !== undefined) openEditor(reply.editor);
    if (reply.revert) markReverted(reply.revert);
    if (reply.prompt !== undefined) {
      // 0.18.19 /undo: the undone question, in the prompt to change and send (as opencode puts it back)
      setHIdx(-1);
      setText(reply.prompt);
    }
    if (reply.quit) exit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core, exit, push, stdout, screen, mouse, items]);

  /** 0.18.19 /undo and /redo of a whole answer: the turn of that question on screen (the person's message and what
   *  came after it, up to their next message) is drawn dim, or not any more. Undo takes the last such turn that is not
   *  undone, redo the first that is. Lines the inline mode printed already stay as they were. */
  function markReverted(rv: { undo: boolean; text: string }) {
    setItems((xs) => {
      const want = rv.text.trim();
      const isQ = (it: Item) => it.kind === "block" && it.b.kind === "user" && it.b.text.trim() === want && !!it.b.reverted !== rv.undo;
      let at = -1;
      if (rv.undo) {
        for (let i = xs.length - 1; i >= 0 && at < 0; i--) if (isQ(xs[i])) at = i;
      } else at = xs.findIndex(isQ);
      if (at < 0) return xs;
      const out = xs.slice();
      for (let i = at; i < out.length; i++) {
        const it = out[i];
        if (it.kind !== "block") continue;
        if (i > at && it.b.kind === "user") break;
        cache.current.delete(it.id);
        const { reverted: _was, ...b } = it.b;
        out[i] = { ...it, b: rv.undo ? { ...b, reverted: true } : b };
      }
      return out;
    });
  }

  /** The sidebar on or off (`on`; the other way without it), kept in keel TUI's settings. Where it cannot show (an
   *  inline screen, a narrow terminal) the person reads why; `say`: /sidebar says what it did in any case. */
  function toggleSidebar(on?: boolean, say = false) {
    const next = on ?? !sideOn;
    setSideOn(next);
    settings.set({ sidebar: next });
    const why = !next ? "" : !screen ? " (it shows on the full screen: keel2 tui without --inline)"
      : termCols < SIDEBAR_MIN ? ` (it shows on a terminal ${SIDEBAR_MIN} columns wide or more; this one has ${termCols})` : "";
    // where it cannot show, Ctrl+B says what it did (nothing changes on the screen)
    if (say || why || !screen || termCols < SIDEBAR_MIN) push({ kind: next && !why ? "ok" : "dim", text: `${say && !why ? "" : "  "}sidebar ${next ? "on" : "off"}${why}` });
  }

  /** A tool call in the transcript opens (its whole output under it) or folds again. The full screen redraws it in its
   *  place; the inline screen printed it already, so its output comes as a new block. */
  function toggleTool(id: number) {
    const it = itemsRef.current.find((x) => x.id === id);
    if (!it || it.kind !== "block" || it.b.kind !== "tool" || !it.b.tool || !canOpen(it.b.tool)) return false;
    if (!screen) {
      if (shownTool.current === id) push({ kind: "dim", text: "  (its output is above)" });
      else push({ kind: "tool", text: it.b.text, tool: it.b.tool, open: true });
      shownTool.current = id;
      return true;
    }
    cache.current.delete(id);
    setItems((xs) => xs.map((x) => (x.id === id && x.kind === "block" ? { ...x, b: { ...x.b, open: !x.b.open } } : x)));
    return true;
  }

  const toggleToolRef = useRef(toggleTool);
  toggleToolRef.current = toggleTool;

  /** Ctrl+O: the last tool call of the running turn (in the live area), else of the last answer, opens or folds; false
   *  when there is none to open (Ctrl+O then follows the agent at work, as before). */
  function toggleLastTool(): boolean {
    if (core.snapshot.chat.busy) {
      const last = [...core.snapshot.chat.tools].reverse().find(canOpen);
      if (!last) return false;
      setLiveOpen((n) => (n === last.n ? null : last.n));
      return true;
    }
    const xs = itemsRef.current;
    for (let i = xs.length - 1; i >= 0; i--) {
      const it = xs[i];
      if (it.kind !== "block") return false;
      if (it.b.kind === "user") return false;          // only the last answer's tool calls
      if (it.b.kind === "tool" && it.b.tool && canOpen(it.b.tool)) return toggleTool(it.id);
    }
    return false;
  }

  /** 0.18.23 While KeelBot works: its thinking block opens or folds. After: the last answer's thinking, shown once. */
  function toggleThinking() {
    if (core.snapshot.chat.busy) {
      setShowThink((x) => !x);
      return;
    }
    const lt = lastThought.current;
    if (!lt) {
      push({ kind: "dim", text: "  KeelBot's last answer has no thinking to show (its model did not send any)." });
      return;
    }
    push({ kind: "dim", text: `${THINKING_HEAD} (${Math.max(1, Math.round(lt.ms / 1000))}s)\n${lt.text.split("\n").map((l) => "  " + l).join("\n")}` });
  }

  /** 0.18.18 The text in the person's editor ($VISUAL / $EDITOR): the terminal is the editor's until it ends (no raw
   *  keys, no mouse reports, keel TUI's screen given back after it), then what it saved is the prompt, not sent. */
  function openEditor(text: string) {
    const found = findEditor(process.env);
    if ("why" in found) {
      push({ kind: "error", text: found.why });
      return;
    }
    const tty = !!(inkStdin as NodeJS.ReadStream).isTTY;
    if (screen && mouse) stdout?.write(MOUSE.off);
    if (tty) (inkStdin as NodeJS.ReadStream).setRawMode(false);
    let r: ReturnType<typeof editText>;
    try {
      r = editText(text, found.editor);
    } finally {
      if (tty) (inkStdin as NodeJS.ReadStream).setRawMode(true);
      // an editor leaves the terminal's other screen when it ends: keel TUI's full screen comes back, drawn anew
      if (screen) stdout?.write(SCREEN.on + (mouse ? MOUSE.on : ""));
    }
    if ("error" in r) {
      push({ kind: "error", text: r.error });
      return;
    }
    setHIdx(-1);
    setText(r.text);
    push({ kind: "dim", text: `  written in ${found.editor.name}: the prompt has it, Enter sends it` });
  }

  const submit = useCallback(async (raw: string) => {
    const text = raw.replace(/\s+$/, "");
    setLine("");
    setCursor(0);
    setComps([]);
    if (pending?.ask) {
      const p = pending;
      push({ kind: "user", text: text || "(nothing)" });
      setPending(null);
      setRunning(p.cmd);
      const r = await follow(p.cmd, () => p.ask!.then(text));
      setRunning(null);
      await handle(r, p.cmd);
      return;
    }
    if (!text.trim()) return;
    setOffset(0);
    push({ kind: "user", text });
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, HISTORY_MAX));
    setHIdx(-1);
    const name = text.startsWith("/") ? text.split(/\s+/)[0] : "";
    if (name) setRunning(name);
    const r = await run(ctx, text, botCmds);
    setRunning(null);
    await handle(r, name);
  }, [botCmds, ctx, handle, pending, push]);

  const choose = useCallback(async (value: string) => {
    if (!pending?.pick) return;
    const p = pending;
    const label = (v: string) => p.pick!.choices.find((x) => x.value === v)?.label ?? v;
    const said = p.pick!.multi ? (JSON.parse(value) as string[]).map(label).join(", ") : label(value);
    push({ kind: "dim", text: `  ${p.pick!.title} → ${said}` });
    setTicked(new Set());
    setPending(null);
    setRunning(p.cmd);
    const r = await follow(p.cmd, () => p.pick!.then(value));
    setRunning(null);
    await handle(r, p.cmd);
  }, [handle, pending, push]);

  const filtered = pending?.pick ? pickMatches(pending.pick.choices, pickFilter) : [];

  /** A prompt from the history, as it is: no completions open (they would take ↑ / ↓). */
  const showPrompt = (t: string, c = t.length) => {
    setLine(t);
    setCursor(c);
    setComps([]);
  };

  const setText = (t: string, c = t.length) => {
    setLine(t);
    setCursor(c);
    const cs = t.startsWith("/") && !/\s$/.test(t) || /^\/\w+\s/.test(t) ? complete(ctx, t, botCmds) : [];
    setComps(cs.length === 1 && cs[0].value.trim() === t.trim() ? [] : cs);
    setCompIdx(0);
  };

  // what a click does (the full screen with the wheel on): follow an agent, answer what waits, the flow's status
  const clicks = useMemo(() => makeClicks(), []);
  const followAgent = (id: string) => setPanels((ps) => [...ps.filter((x) => !x.startsWith("job:")), `job:${id}` as PanelId]);
  const runNow = (cmd: string) => {
    if (pending || running) return;
    void submit(cmd);
  };
  /** A gate (this flow's, or inbox item n): a choice first, never a decision on one click. */
  const gatePick = (n?: number): Pick | null => {
    const item = n ? snap.inbox[n - 1] : null;
    const thread = snap.flow?.thread;
    const w = item ? { title: item.title, options: item.options, kind: item.kind } : thread?.waiting;
    if (!w) return null;
    const at = n ? ` ${n}` : "";
    const tid = item ? item.thread_id : thread!.thread_id;
    const flow = item ? `${item.project_name || item.project_id} · ${item.flow || item.thread_id.slice(0, 8)}` : `"${thread!.title}"`;
    const opts = w.options ?? ["approve", "reject"];
    // keel 0.18.13 this flow's named choices with the engine's words: one row each, the default marked
    const named = !n && thread?.waiting?.choice_info?.length ? thread.waiting.choice_info : null;
    const choices = named ? [
      ...named.map((x) => ({ label: `${x.label || x.name}${x.default ? " (default)" : ""}${x.why === "required" ? " · needs a reason" : ""}`,
        value: `choice:${x.name}`, hint: x.description || `/answer ${x.name}` })),
    ] : [
      ...(w.kind !== "clarify" && opts.includes("approve") ? [{ label: "Approve", value: "approve", hint: `/approve${at}` }] : []),
      ...(opts.includes("reject") ? [{ label: "Send back…", value: "reject", hint: "you say why; the agent gets your words" }] : []),
      ...(!n || w.kind === "clarify" ? [{ label: "Answer… (its questions or choices)", value: "answer", hint: "/answer" }] : []),
      { label: "Stop the flow", value: "stop", hint: "agents stop; every finished step stays saved" },
      { label: "Read it first", value: "status", hint: n ? "/inbox" : "/status" },
    ];
    return { title: `${flow} · ${w.title}: what do you do?`, choices, index: named ? Math.max(0, named.findIndex((x) => x.default)) : 0, then: (v) => {
      const c = v.startsWith("choice:") ? named?.find((x) => `choice:${x.name}` === v) : undefined;
      if (c) return c.why === "none" ? run(ctx, `/answer ${c.name}`, botCmds) : { blocks: [], ask: {
        prompt: c.why === "required" ? `Why ${c.label || c.name}? (needed)` : `Why ${c.label || c.name}? (optional: Enter sends without)`,
        then: (why) => run(ctx, `/answer ${c.name} ${why}`.trim(), botCmds) } };
      if (v === "approve") return run(ctx, `/approve${at}`, botCmds);
      if (v === "answer") return item && item.project_id !== snap.project?.id
        ? { blocks: [{ kind: "dim", text: `  It is on ${item.project_id}: /project ${item.project_id}, then /answer.` }] } : run(ctx, "/answer", botCmds);
      if (v === "status") return run(ctx, n ? "/inbox" : "/status", botCmds);
      if (v === "stop") return { blocks: [], pick: { title: `Stop ${flow}?`, choices: [{ label: "Yes, stop it", value: "yes" }, { label: "No", value: "no" }],
        then: async (y) => {
          if (y !== "yes") return { blocks: [{ kind: "dim", text: "  not stopped" }] };
          const said = await pressButton({ kind: "stop", flows: [tid] }, snap.project?.id ?? "", () => flow);
          await core.refresh().catch(() => undefined);
          return { blocks: [{ kind: "ok", text: said }] };
        } } };
      return { blocks: [], ask: { prompt: "Why send it back? (the agent gets your words)", then: (why) => run(ctx, `/reject${at} ${why}`, botCmds) } };
    } };
  };
  const ask = (pick: Pick | null) => {
    if (!pick || pending || running) return;
    setPending({ cmd: "gate", pick });
    setPickIdx(Math.min(pick.index ?? 0, Math.max(0, pick.choices.length - 1)));
    setPickFilter("");
  };
  const answerGate = (n?: number) => ask(gatePick(n));
  /** The status line's "waiting": one item answers at once; more are listed (every project) to pick from. */
  const answerWaiting = () => {
    const items = snap.inbox;
    if (!items.length) return runNow("/status");
    if (items.length === 1) return answerGate(1);
    ask({ title: `${items.length} wait for you: which one?`, choices: items.map((i, k) => ({ label: `${i.project_name || i.project_id} · ${i.kind}: ${i.title}`,
      value: String(k + 1), hint: i.flow || "" })), then: (v) => {
      const p = gatePick(Number(v));
      return p ? { blocks: [], pick: p } : { blocks: [{ kind: "dim", text: "  It does not wait any more." }] };
    } });
  };

  // the full screen's transcript as lines (each block's lines kept until the width changes)
  const cache = useRef(new Map<number, { w: number; paint: unknown; lines: string[] }>());
  // each line's item (a click on a tool call's line opens it)
  const owners = useRef<number[]>([]);
  const lines = useMemo(() => {
    if (!screen) return [];
    const out: string[] = [];
    const own: number[] = [];
    for (const it of items) {
      let c = cache.current.get(it.id);
      if (!c || c.w !== width || c.paint !== t.paint) {
        c = { w: width, paint: t.paint, lines: it.kind === "start" ? startLines(it.s, width, t.paint) : [...(it.gap ? [""] : []), ...blockLines(it.b, width, t.paint)] };
        cache.current.set(it.id, c);
      }
      out.push(...c.lines);
      for (let k = 0; k < c.lines.length; k++) own.push(it.id);
    }
    owners.current = own;
    return out;
  }, [items, width, screen, t.paint]);
  // scrolled up while new lines come: the view stays where the person is reading
  const seen = useRef(0);
  useEffect(() => {
    const grew = lines.length - seen.current;
    seen.current = lines.length;
    if (grew > 0) setOffset((o) => (o > 0 ? o + grew : 0));
  }, [lines.length]);
  const scroll = useCallback((by: number) => setOffset((o) => Math.max(0, Math.min(o + by, Math.max(0, lines.length - viewH)))), [lines.length, viewH]);
  // the transcript area's height, after Ink laid the screen out
  useEffect(() => {
    if (!screen || !viewRef.current) return;
    const h = measureElement(viewRef.current).height;
    if (h > 0 && h !== viewH) setViewH(h);
  });
  // the mode's area, after Ink laid the screen out (a question KeelBot asks meanwhile shows under it)
  useEffect(() => {
    if (!screen || !modeRef.current) return;
    const h = measureElement(modeRef.current).height;
    if (h > 0 && h !== modeH) setModeH(h);
  });
  // select with the mouse: where a cell of the screen is in the transcript shown (after scrolling) or in the prompt
  const shownRef = useRef({ above: 0, count: 0 });
  const linesRef = useRef<string[]>([]);
  linesRef.current = lines;
  const lineRef = useRef("");
  lineRef.current = line;
  /** The transcript's or the prompt's cell at a column and row of the screen; with `keep`, a cell outside it is moved
   *  to its nearest edge (a drag past the transcript's top or bottom, or off the prompt's line). */
  const cellAt = (col: number, row: number, keep?: Sel["area"]): { area: Sel["area"]; at: Point } | null => {
    const vp = viewRef.current && placeOf(viewRef.current);
    const { above, count } = shownRef.current;
    if (vp && count && keep !== "prompt") {
      const i = row - (vp.top + vp.height - count);      // the lines sit at the bottom of the transcript's area
      const c = Math.max(0, col - vp.left);
      if (i >= 0 && i < count && col >= vp.left && col < vp.left + vp.width) return { area: "view", at: { line: above + i, col: c } };
      if (keep === "view") return { area: "view", at: i < 0 ? { line: above, col: 0 } : i >= count ? { line: above + count - 1, col: 1e6 } : { line: above + i, col: c } };
    }
    const pp = promptRef.current && placeOf(promptRef.current);
    // the prompt's text starts after its border, its padding and "› "
    if (pp && lineRef.current && (keep === "prompt" || row === pp.top + 1)) return { area: "prompt", at: { line: 0, col: Math.max(0, col - pp.left - 4) } };
    return null;
  };
  const onMouse = useCallback((e: MouseEv) => {
    if (e.kind === "press") {
      const hit = cellAt(e.col, e.row);
      if (!hit) {
        setSel(null);
        clicks.hit(e.col, e.row)?.act();
        return;
      }
      const lp = lastPress.current;
      const now = Date.now();
      lastPress.current = { t: now, col: e.col, row: e.row };
      if (now - lp.t < DOUBLE_MS && lp.col === e.col && lp.row === e.row) {
        // a double-click: the word under it
        const text = hit.area === "view" ? linesRef.current[hit.at.line] ?? "" : lineRef.current;
        const w = wordAt(plain(text), hit.at.col);
        if (w) return setSel({ area: hit.area, a: { line: hit.at.line, col: w[0] }, b: { line: hit.at.line, col: w[1] }, moved: true });
      }
      setSel({ area: hit.area, a: hit.at, b: hit.at, moved: false });
      return;
    }
    const cur = selRef.current;
    if (!cur) return;
    if (e.kind === "drag") {
      const hit = cellAt(e.col, e.row, cur.area);
      if (!hit) return;
      const moved = cur.moved || hit.at.line !== cur.a.line || hit.at.col !== cur.a.col;
      if (moved !== cur.moved || hit.at.line !== cur.b.line || hit.at.col !== cur.b.col) setSel({ ...cur, b: hit.at, moved });
      return;
    }
    // the release: what is selected goes to the clipboard at once; a plain click selects nothing (on a tool call's
    // line it opens or folds its output)
    if (!cur.moved) {
      setSel(null);
      const id = cur.area === "view" ? owners.current[cur.a.line] : undefined;
      if (id !== undefined) toggleToolRef.current(id);
      return;
    }
    const text = selectedText(cur.area === "view" ? linesRef.current : [lineRef.current], cur.a, cur.b);
    if (!text.trim()) return setSel(null);
    stdout?.write(osc52(text));
    const n = [...text].length;
    setFlash(`copied ${n} character${n === 1 ? "" : "s"}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clicks, stdout]);
  // the wheel, Home and End: read from the raw input (Ink gives no key for them)
  const { internal_eventEmitter: rawInput } = useStdin() as unknown as { internal_eventEmitter?: NodeJS.EventEmitter };
  useEffect(() => {
    if (!screen || !rawInput) return;
    const on = (chunk: string | Buffer) => {
      const s = String(chunk);
      const n = wheel(s);
      if (n && mode) return mode.wheel(n * 3);
      if (n) return scroll(n * 3);
      for (const e of mouseEvents(s)) onMouse(e);
      const end = /^\x1b(\[(F|4~|8~)|OF)$/.test(s);
      const home = /^\x1b(\[(H|1~|7~)|OH)$/.test(s);
      if (mode && (end || home)) void mode.press(end ? "end" : "home");
      else if (end) setOffset(0);
      else if (home) setOffset(Number.MAX_SAFE_INTEGER);
    };
    rawInput.on("input", on);
    return () => void rawInput.off("input", on);
  }, [rawInput, screen, scroll, clicks, mode, onMouse]);

  useInput((input, key) => {
    // the mouse's reports are read below, from the raw input; never typed into the prompt
    if (isMouse(input) || isMouse("\x1b" + input)) return;
    // a key ends what the mouse selected, and the "copied" notice
    if (selRef.current) setSel(null);
    if (flash) setFlash(null);
    // a plugin's mode has the keys (Ctrl+C still quits; a question KeelBot asks meanwhile is answered first)
    if (mode && !pending?.pick && !(key.ctrl && input === "c")) {
      const name = keyName(input, key);
      if (name) void mode.press(name).then((r) => r === "leave" && leaveMode());
      return;
    }
    if (screen && (key.pageUp || key.pageDown || (key.shift && (key.upArrow || key.downArrow)))) {
      const step = key.pageUp || key.pageDown ? Math.max(1, viewH - 2) : 3;
      scroll(key.pageUp || key.upArrow ? step : -step);
      return;
    }
    if (key.ctrl && input === "c") {
      const now = Date.now();
      if (now - ctrlC.current < 1500) exit();
      ctrlC.current = now;
      if (line) setText("");
      push({ kind: "dim", text: "  Ctrl+C again quits (keel keeps running)." });
      return;
    }
    if (pending?.pick) {
      if (key.escape) {
        push({ kind: "dim", text: pending.pick.newMessage ? "  Suggestion not sent: you closed it." : "  cancelled" });
        setPending(null);
        const cancel = pending.pick.onCancel;
        if (cancel) void Promise.resolve(cancel()).then((r) => handle(r, pending.cmd)).catch((e) => push({ kind: "error", text: e instanceof Error ? e.message : String(e) }));
      } else if (key.upArrow) setPickIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setPickIdx((i) => Math.min(filtered.length - 1, i + 1));
      else if (pending.pick.multi && input === " ") {
        // a pick of several: Space ticks or unticks the one under the cursor
        const c = filtered[pickIdx];
        if (c) setTicked((s) => {
          const n = new Set(s);
          if (n.has(c.value)) n.delete(c.value);
          else n.add(c.value);
          return n;
        });
      } else if (key.return) {
        const c = filtered[pickIdx];
        if (pending.pick.multi) {
          const list = ticked.size ? [...ticked] : c ? [c.value] : [];
          if (list.length) void choose(JSON.stringify(list));
        } else if (c) void choose(c.value);
      } else if (key.backspace || key.delete) {
        setPickFilter((f) => f.slice(0, -1));
        setPickIdx(0);
      } else if (input && !key.ctrl && !key.meta && /^\d$/.test(input) && !pickFilter && Number(input) >= 1 && Number(input) <= Math.min(9, filtered.length)) {
        if (pending.pick.multi) setPickIdx(Number(input) - 1);
        else void choose(filtered[Number(input) - 1].value);
      } else if (input && !key.ctrl && !key.meta) {
        // 0.18.23 a KeelBot suggestion: once what the person types matches no choice, it is a new message (in the
        // prompt, Enter sends it), and the suggestion is dropped saying why; KeelBot's next answer updates it
        const typed = pickFilter + input;
        if (pending.pick.newMessage && !pickMatches(pending.pick.choices, typed).length) {
          push({ kind: "dim", text: `  ${pending.pick.newMessage}` });
          buttonAsks.current = [];
          setPending(null);
          setPickFilter("");
          setHIdx(-1);
          const add = typed.replace(/\r\n?|\n/g, " ");
          setText(line.slice(0, cursor) + add + line.slice(cursor), cursor + add.length);
          return;
        }
        setPickFilter(typed);
        setPickIdx(0);
      }
      return;
    }
    // 0.18.18 Ctrl+X, then E or Ctrl+E (as opencode and readline): the prompt as it is, in the person's editor
    if (key.ctrl && input === "x") {
      ctrlX.current = Date.now();
      return;
    }
    if (ctrlX.current) {
      const chord = Date.now() - ctrlX.current < 2000 && input === "e";
      ctrlX.current = 0;
      if (chord) {
        const text = line;
        setLine("");
        setCursor(0);
        setComps([]);
        openEditor(text);
        return;
      }
    }
    const pluginPanel = key.ctrl ? snap.plugins.plugins.find((x) => x.panel?.key === input) : undefined;
    if (pluginPanel) {
      const id = `plugin:${pluginPanel.name}` as PanelId;
      setPanels((ps) => (ps.includes(id) ? ps.filter((x) => x !== id) : [...ps, id]));
      return;
    }
    // 0.18.23 Ctrl+T: KeelBot's thinking, open or folded (while it works), or the last answer's thinking
    if (key.ctrl && input === "t") {
      toggleThinking();
      return;
    }
    // Ctrl+B: the sidebar, on or off (kept in keel TUI's settings)
    if (key.ctrl && input === "b") {
      toggleSidebar();
      return;
    }
    if (key.ctrl && input === "o") {
      // the last tool call's output, open or folded; with none, the agent at work
      if (toggleLastTool()) return;
      const j = snap.running[0];
      if (j) followAgent(j.id);
      else push({ kind: "dim", text: "  No agent at work. /agent lists yours." });
      return;
    }
    // keel 0.18.9 Ctrl+A: the agents, as /agent shows them: pick one to follow it, or start your own
    if (key.ctrl && input === "a") {
      void submit("/agent");
      return;
    }
    if (key.ctrl && CTRL_PANEL[input]) {
      const p = CTRL_PANEL[input];
      setPanels((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]));
      if (p === "agents" || p === "inbox") void core.refresh().catch(() => undefined);
      return;
    }
    if (key.escape) {
      if (comps.length) setComps([]);
      else if (hIdx >= 0) {
        // 0.18.18 Esc leaves the history: the prompt is empty again
        setHIdx(-1);
        setText("");
      }
      else if (pending?.ask) {
        push({ kind: "dim", text: "  cancelled" });
        setPending(null);
      } else if (snap.chat.busy) {
        push({ kind: "dim", text: "  stopping KeelBot's answer…" });
        void core.stopChat();
      } else if (panels.some((x) => x.startsWith("job:"))) setPanels((ps) => ps.filter((x) => !x.startsWith("job:")));
      return;
    }
    // keel 0.18.8 Alt+Tab (the terminal sends Escape, Tab) or Shift+Tab: KeelBot's next mode, for the next message
    if ((input === "\t" && !key.tab) || (key.tab && key.shift)) {
      const now = core.snapshot.chat.mode;
      const waits = core.snapshot.flow?.thread?.status === "waiting";
      const order: HelperMode[] = ["ask", "edit", ...(waits ? (["fix"] as HelperMode[]) : []), "side"];
      const next = order[(order.indexOf(now) + 1) % order.length] ?? "ask";
      void core.setChatMode(next);     // the status line's first word changes; nothing goes into the transcript
      return;
    }
    if (key.tab) {
      const cs = comps.length ? comps : complete(ctx, line, botCmds);
      if (cs.length) setText(cs[comps.length ? compIdx : 0].value);
      return;
    }
    // 0.18.18 Alt / Option+Enter (and Shift+Enter where the terminal reports it): a new line, not sent
    if (isNewline(input, key)) {
      setHIdx(-1);
      setText(line.slice(0, cursor) + "\n" + line.slice(cursor), cursor + 1);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (comps.length) {
        setCompIdx((i) => (key.upArrow ? Math.max(0, i - 1) : Math.min(Math.min(comps.length, 8) - 1, i + 1)));
        return;
      }
      // 0.18.18 ↑ / ↓ move between a prompt's rows first; on the first row ↑ goes to its start, on the last ↓ to its
      // end (as opencode, MIT; a prompt of one row skips that). Only from there, and only in an empty prompt or an earlier prompt shown as it is, they
      // walk the history: ↑ older (the cursor at its start), ↓ newer (at its end), down to an empty prompt.
      const up = key.upArrow;
      const walking = hIdx >= 0 && line === history[hIdx];
      const to = moveRow(line, cursor, up ? -1 : 1);
      if (to !== null) return setCursor(to);
      const edge = up ? 0 : line.length;
      if (line.includes("\n") && cursor !== edge) return setCursor(edge);
      if (!walking && line) return;
      const i = up ? Math.min(history.length - 1, hIdx + 1) : hIdx - 1;
      if (i < 0) {
        setHIdx(-1);
        if (walking) showPrompt("");
      } else if (history[i] !== undefined) {
        setHIdx(i);
        showPrompt(history[i], up ? 0 : undefined);
      }
      return;
    }
    if (key.return) {
      if (comps.length) {
        const c = comps[compIdx];
        // a command that takes arguments: complete it and let the person go on typing
        if (c && c.value.endsWith(" ") && c.value.trim() !== line.trim()) {
          setText(c.value);
          return;
        }
        // what was typed is a command as it is (/mode, though /model starts the same): run that, not the suggestion
        const exact = comps.some((x) => x.value.trim() === line.trim());
        void submit(c && !exact && c.value.trim() !== line.trim() && !line.includes(" ") ? c.value : line);
        return;
      }
      void submit(line);
      return;
    }
    if (key.backspace || key.delete) {
      setHIdx(-1);
      if (cursor > 0) setText(line.slice(0, cursor - 1) + line.slice(cursor), cursor - 1);
      return;
    }
    if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor((c) => Math.min(line.length, c + 1));
    if (key.ctrl && input === "u") {
      setHIdx(-1);
      return setText("");
    }
    if (key.ctrl || key.meta || !input) return;
    setHIdx(-1);                      // 0.18.18 typing leaves the history: the prompt is the person's own now
    // a paste: many lines or a long text behind "[pasted N lines #1]", an image path as "[image x.png #2]"
    const add = isPaste(input) ? pastes.current.add(input).insert : input.replace(/\r\n?|\n/g, " ");
    setText(line.slice(0, cursor) + add + line.slice(cursor), cursor + add.length);
  });

  const chat = snap.chat;
  const steps = chat.steps;
  const lastText = [...steps].reverse().find((s) => s.kind === "text" || s.kind === "answer");
  // the running turn's tool calls: the last four, one line each (one of them open: Ctrl+O, a click)
  const toolCalls = chat.tools;
  const liveTools = toolCalls.slice(-4);
  // the sidebar's files: the running answer's so far, else the last answer's
  const sideFiles = chat.busy ? filesOfSteps(steps) : turnFiles;
  // what KeelBot is writing now (helper.delta), else its last whole message of this turn
  const writing = chat.stream || lastText?.text || "";
  const verb = useMemo(() => pickVerb(), [chat.callId]);
  // Fix and Side: each change as KeelBot makes it (the last two), as a diff with line numbers
  const edits = steps.filter((x) => (x.kind === "write" || x.kind === "edit") && x.diff).slice(-2);
  const diffLines = (d: string) => {
    const all = renderDiff(d.replace(/\n$/, ""), t.paint).filter((l) => !/(---|\+\+\+) /.test(l.replace(/\x1b\[[0-9;]*m/g, "").trimStart()));
    return all.length > 12 ? [...all.slice(0, 12), t.paint.faint(`… ${all.length - 12} more lines`)] : all;
  };
  const flowWaits = snap.flow?.thread?.status === "waiting";
  const border = pending?.ask || line ? t.color("accent") : flowWaits ? t.color("gate") : t.color("border");
  const agentsHere = panels.includes("agents") ? [] : snap.running.slice(0, 3);

  // the full screen: keel's name, the transcript that scrolls, the live area, the prompt and the status line
  if (screen && mode) {
    return (
      <ClicksProvider clicks={clicks}>
      <Box flexDirection="column" height={height} width={fullWidth}>
        <Text wrap="truncate-end">{headerLine(snap, fullWidth, t.paint)}</Text>
        <Text {...t.look("border")} wrap="truncate-end">{"─".repeat(fullWidth)}</Text>
        <Box ref={modeRef} flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
          <ModeView session={mode} width={width} height={modeH} />
        </Box>
        {pending?.pick && <Picker title={pending.pick.title} choices={filtered} index={pickIdx} filter={pickFilter} />}
        <Clickable act={answerWaiting}><StatusLine s={snap} /></Clickable>
      </Box>
      </ClicksProvider>
    );
  }

  if (screen) {
    const v = view(lines, viewH, offset);
    shownRef.current = { above: v.above, count: v.shown.length };
    const marked = (k: number) => (sel?.moved && sel.area === "view" ? colsOn(k, sel.a, sel.b) : null);
    const liveRows = Math.max(3, Math.floor(height / 3));
    const writingLines = writing ? wrap(renderMarkdown(writing.slice(-3000), t.paint, width - 2), width - 2).slice(-liveRows) : [];
    return (
      <ClicksProvider clicks={clicks}>
      <Box flexDirection="column" height={height} width={fullWidth}>
        <Text wrap="truncate-end">{headerLine(snap, fullWidth, t.paint)}</Text>
        <Text {...t.look("border")} wrap="truncate-end">{"─".repeat(fullWidth)}</Text>
        <Box flexDirection="row" flexGrow={1} flexBasis={0}>
        <Box flexDirection="column" width={width} flexShrink={0}>
        <Box ref={viewRef} flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden" justifyContent="flex-end">
          {!started && <Text {...t.look("dim")}>connecting to keel at {snap.url} …</Text>}
          {v.shown.map((l, i) => {
            const m = marked(v.above + i);
            return <Text key={v.above + i} wrap="truncate-end">{(m ? highlight(l, m[0], m[1]) : l) || " "}</Text>;
          })}
        </Box>
        {v.below > 0 && (
          <Text {...t.look("accent")} wrap="truncate-end">
            {`── ↓ ${v.below} newer line${v.below === 1 ? "" : "s"} · PgDn, End${mouse ? " or the wheel" : ""} ` + "─".repeat(Math.max(0, width - 40))}
          </Text>
        )}
        {live(writingLines)}
        </Box>
        {side && <Sidebar s={snap} servers={servers} files={sideFiles} height={height - 2}
          on={{ flow: () => runNow("/status"), waiting: () => answerGate() }} />}
        </Box>
      </Box>
      </ClicksProvider>
    );
  }

  return (
    <>
      <Static key={epoch} items={items}>
        {(it) => (it.kind === "start" ? <StartScreen key={it.id} s={it.s} width={width} /> : <BlockView key={it.id} b={it.b} width={width} gap={it.gap} />)}
      </Static>
      <Box flexDirection="column">
        {!started && <Text {...t.look("dim")}>connecting to keel at {snap.url} …</Text>}
        {mode ? <>
          <ModeView session={mode} width={width} height={INLINE_MODE_ROWS} />
          {pending?.pick && <Picker title={pending.pick.title} choices={filtered} index={pickIdx} filter={pickFilter} />}
          <StatusLine s={snap} />
        </> : live()}
      </Box>
    </>
  );

  /** What is happening now, the panels, the picker or the prompt, and the status line; in the full screen KeelBot's
   *  answer as it is written comes as its last lines (`writingLines`), so the prompt never leaves the screen. */
  function live(writingLines?: string[]) {
    return (
      <>
        {chat.busy && (
          <Box flexDirection="column" marginTop={1}>
            {toolCalls.length > liveTools.length && <Text {...t.look("meta")}>{`  … ${toolCalls.length - liveTools.length} earlier tool calls`}</Text>}
            {liveTools.map((c, i) => {
              const open = liveOpen === c.n && canOpen(c);
              const hint = i === liveTools.map(canOpen).lastIndexOf(true) && !open ? "Ctrl+O to show" : "";
              const body = open ? toolBody(c, width, t.paint) : [];
              return (
                <Clickable key={c.n} act={() => canOpen(c) && setLiveOpen((n) => (n === c.n ? null : c.n))}>
                  <Text>{[...toolLines(c, width, t.paint, open, hint).slice(0, 2),
                    ...(body.length > LIVE_TOOL_ROWS ? [t.paint.meta(`      … ${body.length - LIVE_TOOL_ROWS} lines above`), ...body.slice(-LIVE_TOOL_ROWS)] : body)].join("\n")}</Text>
                </Clickable>
              );
            })}
            {edits.map((e) => (
              <Box key={e.n} flexDirection="column" marginLeft={4}>
                {diffLines(e.diff ?? "").map((l, i) => <Text key={i} wrap="truncate-end">{l}</Text>)}
              </Box>
            ))}
            {chat.thinking ? (
              // 0.18.23 thinking: open while KeelBot thinks (or Ctrl+T), one folded line once the answer starts
              writing && !showThink
                ? <Text {...t.look("meta")}>{"  " + thoughtLine((chat.thoughtAt ?? Date.now()) - (chat.startedAt ?? Date.now()))}</Text>
                : <Text {...t.look("meta")}>{thinkingLines(chat.thinking, width, showThink ? 40 : undefined).map((l) => "  " + l).join("\n")}</Text>
            ) : null}
            {writingLines ? writingLines.map((l, i) => <Text key={i} wrap="truncate-end">{"  " + l}</Text>)
              : writing && <Box marginLeft={2}><Text>{renderMarkdown(writing.slice(-3000), t.paint)}</Text></Box>}
            <Thinking verb={verb} since={chat.startedAt} tokens={Math.round(chat.wrote / 4) || undefined} hint="esc to interrupt" />
          </Box>
        )}
        {!chat.busy && agentsHere.map((j) => {
          // what it does now: the text it writes, else its last step; a click (or Ctrl+O) follows it
          const now = snap.liveText[j.id] ? `✎ ${snap.liveText[j.id].replace(/\s+/g, " ").slice(-(width - 10))}`
            : snap.lastStep[j.id] ? fmt.stepLine(snap.lastStep[j.id]!, width - 6, t.paint) : "";
          return (
            <Clickable key={j.id} act={() => followAgent(j.id)}>
              <Thinking who={j.agent} verb={pickVerb(j.id)} since={Date.parse(j.started_at) || null}
                tokens={fmt.tokensOf(j) || undefined} hint={[fmt.flowOf(snap.flowTitles, j.thread_id), [j.step, j.ac].filter(Boolean).join(" "),
                  screen && mouse ? "click to follow" : "Ctrl+O follows"].filter(Boolean).join(" · ")} />
              {now ? <Text wrap="truncate-end" {...t.look("dim")}>{"   " + now}</Text> : null}
            </Clickable>
          );
        })}
        {/* keel 0.18.9 a command at work (/model reads keel's catalog): a turning spinner and the seconds, not a still line */}
        {running && <Thinking verb={running === "KeelBot" || running === "gate" ? "Working" : `Running ${running}`} since={runningSince.current} />}
        {panels.map((p) => {
          if (p.startsWith("job:")) return <JobPanel key={p} id={p.slice(4)} s={snap} width={width} />;
          if (!p.startsWith("plugin:")) return <Panel key={p} name={p as PanelName} s={snap} width={width}
            on={{ agent: followAgent, waiting: () => answerGate(), flow: () => runNow("/status"), inbox: (n) => answerGate(n) }} />;
          const v = snap.plugins.plugins.find((x) => `plugin:${x.name}` === p);
          return v?.panel && snap.project ? <PluginPanel key={p} plugin={v.title} panel={v.panel} pid={snap.project.id} width={width} /> : null;
        })}
        {pending?.pick ? (
          <Picker title={pending.pick.title} choices={filtered} index={pickIdx} filter={pickFilter} ticked={pending.pick.multi ? ticked : undefined} />
        ) : (
          <Box flexDirection="column">
            {pending?.ask && <Text {...t.look("accent")} bold>{pending.ask.prompt}<Text {...t.look("dim")} bold={false}> (Esc cancels)</Text></Text>}
            {/* "copied N characters" takes the row the footer (or the prompt's air above it) had: nothing moves */}
            {flash ? <Box marginTop={footer && !chat.busy ? 1 : 0}><Text wrap="truncate-end" {...t.look("dim")}>{" " + flash}</Text></Box>
              : footer && !chat.busy ? <Box marginTop={1}><Text wrap="truncate-end">{" " + footer}</Text></Box> : null}
            <Box ref={promptRef} borderStyle="round" borderColor={border} paddingX={1} marginTop={flash || (footer && !chat.busy) ? 0 : 1}
              flexDirection="column">
              {line ? promptText() : (
                <Text>
                  <Text {...t.look("person")} bold>{"› "}</Text>
                  <Text inverse> </Text><Text {...t.look("dim")}>{pending?.ask ? "type the answer, Enter sends"
                    : flowWaits ? "A gate waits for you: /approve, /reject <why>, /next … or ask KeelBot" : "Ask KeelBot, / for commands, ! for a shell command"}</Text>
                </Text>
              )}
            </Box>
            {comps.length > 0 && <Completions items={comps} index={compIdx} />}
          </Box>
        )}
        <Clickable act={answerWaiting}><StatusLine s={snap} meter={!side} /></Clickable>
      </>
    );
  }

  /** 0.18.18 The prompt's rows (it grows with Alt+Enter up to PROMPT_ROWS rows, then shows the cursor's), the cursor
   *  inverse, and how many rows are hidden above or below. */
  function promptText() {
    const pv = promptRows(line, cursor);
    // 0.18.18 `!` at the start: a shell command keel runs in the project folder (as opencode's shell mode, MIT)
    const shellLine = line.startsWith("!");
    const more = (n: number, where: string) => (
      <Text {...t.look("dim")} wrap="truncate-end">{`  ${n} more line${n === 1 ? "" : "s"} ${where}`}</Text>
    );
    return (
      <>
        {pv.above > 0 && more(pv.above, "above")}
        {pv.rows.map((r, i) => (
          <Text key={pv.above + i}>
            <Text {...t.look(shellLine ? "warn" : "person")} bold>{pv.above + i === 0 ? (shellLine ? "shell › " : "› ") : shellLine ? "        " : "  "}</Text>
            {r.cursor === null ? inputText(r.text || " ")
              : <>{inputText(r.text.slice(0, r.cursor))}<Text inverse>{r.text[r.cursor] ?? " "}</Text>{inputText(r.text.slice(r.cursor + 1))}</>}
          </Text>
        ))}
        {pv.below > 0 && more(pv.below, "below")}
      </>
    );
  }

  /** The prompt's text: a command's name in the accent colour while it is typed. */
  function inputText(x: string) {
    const m = /^(\/\S*)(.*)$/s.exec(x);
    if (!m || x !== line.slice(0, x.length) || !line.startsWith("/")) return <Text>{x}</Text>;
    return <><Text {...t.look("accent")} bold>{m[1]}</Text><Text>{m[2]}</Text></>;
  }
}
