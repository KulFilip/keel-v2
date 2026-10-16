// keel TUI, the Ink app: the start screen, then the transcript (KeelBot's answers, commands' answers, keel's live
// notices) above a live area: KeelBot's streaming answer, a panel, the picker or the prompt, and the status line.
// The state is here; what commands do is in ../core (UI-free).
//
// Two ways to show it: the full screen (`rows`: keel's name stays at the top, the prompt at the bottom, the transcript
// between them scrolls with PgUp / PgDn, Shift+↑↓ and the wheel) and inline (no `rows`: the transcript goes into the
// terminal's own scrollback, for tests, --script and `keel2 tui --inline`).

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, measureElement, Static, Text, useApp, useInput, useStdin, useStdout, type DOMElement } from "ink";
import { complete, follow, run, type Ask, type Block, type Completion, type Ctx, type PanelName, type Pick, type Reply } from "../core/commands";
import type { KeelCore, Snapshot } from "../core/keel";
import { renderMarkdown } from "../core/markdown";
import { applyLevel, makeTheme, type Theme } from "../core/theme";
import { ThemeProvider, useTheme } from "./theme";
import { pickVerb, Thinking } from "./thinking";
import * as fmt from "../core/format";
import { BlockView, Completions, JobPanel, Panel, Picker, PluginPanel, StartScreen, StatusLine } from "./parts";
import { isPaste, Pastes, typingMention } from "../core/mentions";
import { pluginCommands } from "../core/plugins";
import { COMMANDS, setChanged, setPluginCommands } from "../core/commands";
import { renderDiff } from "../core/diff";
import { inboxApi } from "../../../web/src/inboxApi";
import type { Profiler } from "../core/profile";
import type { HelperMode } from "../core/sdk";
import { Clickable, ClicksProvider, leftClicks, makeClicks } from "./click";
import { elsewhere, prepare, pressButton, splitButtons, type Button } from "../core/buttons";
import { api } from "../core/sdk";
import { blockLines, headerLine, isMouse, MOUSE, startLines, view, wheel, wrap } from "../core/lines";
import type { ModeSession } from "../core/modes";
import { keyName, ModeView } from "./ModeView";

/** `gap`: an empty line above it (the first block of each answer, so answers stand apart; notices in a row stay together) */
type Item = { id: number; kind: "start"; s: Snapshot } | { id: number; kind: "block"; b: Block; gap?: boolean };

/** What a driver (keel-tui --script, tests) can see of the app's state. */
export type Probe = { started: boolean; busy: boolean; pick: boolean; ask: boolean; chatBusy: boolean; answers: number };

type Pending = { cmd: string; pick?: Pick; ask?: Ask };

const CTRL_PANEL: Record<string, PanelName> = { f: "flow", a: "agents", b: "inbox" };
/** a plugin's mode without the full screen (--inline, tests): this many rows */
const INLINE_MODE_ROWS = 20;
/** keel's panels, and a plugin's ("plugin:git") */
type PanelId = PanelName | `plugin:${string}` | `job:${string}`;
type Question = { id: string; command: string; title: string; path?: string | null };

/** keel TUI in keel's colours (the theme: the dashboard's palette, NO_COLOR, KEEL_TUI_THEME). */
export function App({ theme, ...props }: { core: KeelCore; probe?: Probe; width?: number; theme?: Theme; profiler?: Profiler; rows?: number; mouse?: boolean }) {
  const th = useMemo(() => theme ?? makeTheme(), [theme]);
  applyLevel(th);
  return <ThemeProvider theme={th}><Main {...props} /></ThemeProvider>;
}

function Main({ core, probe, width: fixedWidth, profiler, rows: fixedRows, mouse: mouseAtStart = false }: { core: KeelCore; probe?: Probe; width?: number;
  profiler?: Profiler; rows?: number; mouse?: boolean }) {
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
  const cols = () => Math.max(40, stdout?.columns || 100);
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
  const width = fixedWidth ?? termWidth;
  // the full screen: its height (one row less than the terminal's, so Ink never scrolls it), else inline
  const screen = termRows > 0;
  const height = Math.max(11, termRows - 1);
  const [snap, setSnap] = useState<Snapshot>(core.snapshot);
  const [items, setItems] = useState<Item[]>([]);
  const [epoch, setEpoch] = useState(0);
  const [started, setStarted] = useState(false);
  const [line, setLine] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [hIdx, setHIdx] = useState(-1);
  const [pending, setPending] = useState<Pending | null>(null);
  const [pickIdx, setPickIdx] = useState(0);
  const [pickFilter, setPickFilter] = useState("");
  const [panels, setPanels] = useState<PanelId[]>([]);
  const pastes = useRef(new Pastes());
  const questions = useRef<Question[]>([]);
  // KeelBot's buttons (start a flow, decide a gate, stop flows, a run mode): a yes / no each, after its answer
  const buttonAsks = useRef<Pick[]>([]);
  const [qTick, setQTick] = useState(0);
  const [running, setRunning] = useState<string | null>(null);
  const [comps, setComps] = useState<Completion[]>([]);
  const [compIdx, setCompIdx] = useState(0);
  const [botCmds, setBotCmds] = useState<{ name: string; description: string }[]>([]);
  const [answers, setAnswers] = useState(0);
  const ctrlC = useRef(0);
  // the full screen's scroll: lines up from the newest, the transcript area's height, and the wheel on or off
  const [offset, setOffset] = useState(0);
  const [viewH, setViewH] = useState(Math.max(3, height - 8));
  const viewRef = useRef<DOMElement>(null);
  const [mouse, setMouse] = useState(mouseAtStart);
  const nextId = useRef(1);
  // 0.18.6 a plugin's mode (core/modes.ts): it takes the screen between keel's header and the status line until Esc
  const [mode, setMode] = useState<ModeSession | null>(null);
  const [, setModeTick] = useState(0);
  const [modeH, setModeH] = useState(Math.max(6, height - 3));
  const modeRef = useRef<DOMElement>(null);

  const ctx: Ctx = useMemo(() => ({ core, width, paint: t.paint }), [core, width, t.paint]);
  // for the answer event's handler (it is set up once): the colours, the width and when the turn started
  const look = useRef({ paint: t.paint, width });
  look.current = { paint: t.paint, width };
  const turnStart = useRef<number | null>(null);
  if (snap.chat.startedAt) turnStart.current = snap.chat.startedAt;

  const push = useCallback((...bs: Block[]) => {
    if (!bs.length) return;
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
        (s.messages ?? []).slice(-4).forEach((m) => blocks.push(m.role === "user" ? { kind: "user", text: m.text }
          : { kind: m.role === "note" ? "dim" : "markdown", text: m.text }));
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
      core.on("answer", (a) => {
        const d = a.message?.data;
        const { paint, width: w } = look.current;
        const used = d ? [d.provider && d.model ? `${d.provider}/${d.model}` : "", d.tokens_in || d.tokens_out ? `${fmt.short((d.tokens_in ?? 0) + (d.tokens_out ?? 0))} tokens` : "",
          d.cost_usd ? `$${d.cost_usd.toFixed(2)}` : ""].filter(Boolean).join(" · ") : "";
        // what it did (its tools, settled: xal's way), the answer, then how the turn ended and what it used
        const tools = fmt.toolLines(core.snapshot.chat.steps, w, paint);
        const ms = d?.ms ?? (turnStart.current ? Date.now() - turnStart.current : 0);
        const outcome = a.ok ? "done" : d?.status === "stopped" ? "stopped" : "failed";
        const { text: said, buttons } = a.ok ? splitButtons(a.text) : { text: a.text, buttons: [] };
        push(...(tools.length ? [{ kind: "text" as const, text: tools.join("\n") }] : []), { kind: a.ok ? "markdown" : "error", text: said || "(KeelBot gave buttons only)" },
          // two empty lines after "✓ Finished …", so the answer stands apart from what comes next
          { kind: "text", text: fmt.turnFooter(outcome, ms, used ? `KeelBot · ${used}` : "KeelBot", paint) + "\n\n" });
        turnStart.current = null;
        if (buttons.length) void askButtons(buttons);
        setAnswers((n) => n + 1);
        // Fix and Side: the files KeelBot changed, with their diffs, and how to keep or undo them
        const mode = core.snapshot.chat.session?.mode ?? core.snapshot.chat.mode;
        if (mode === "fix" || mode === "side" || mode === "edit") {
          void core.changes().then((ch) => {
            setChanged(core.snapshot.chat.session?.id ?? "", ch.map((c) => c.path));
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
    });
    return () => {
      alive = false;
      offs.forEach((o) => o());
      core.stop();
    };
  }, [core, push]);

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
      buttonAsks.current.push({ title, choices: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
        then: async (v) => {
          if (v !== "yes") return { blocks: [{ kind: "dim", text: "  not done" }] };
          try {
            const said = await pressButton(b, pid, name);
            await core.refresh().catch(() => undefined);
            return { blocks: [{ kind: "ok", text: said }] };
          } catch (e) {
            return { blocks: [{ kind: "error", text: e instanceof Error ? e.message : String(e) }] };
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
    setPending({ cmd: "KeelBot", pick: { title: `KeelBot asks to run: ${q.command}${q.path ? ` (${q.path})` : ""}?`,
      choices: [{ label: "Allow once", value: "once" }, { label: "Allow in this chat", value: "always", hint: "this command, for the rest of the chat" },
        { label: "Deny", value: "deny" }],
      then: async (v) => {
        await inboxApi.decide(q.id, v);
        return { blocks: [{ kind: v === "deny" ? "dim" : "ok", text: v === "deny" ? `  refused: ${q.command}` : `allowed ${v === "always" ? "in this chat" : "once"}: ${q.command}` }] };
      } } });
    setPickIdx(0);
    setPickFilter("");
  }, [pending, qTick]);

  // what keel's plugins add: their commands
  useEffect(() => {
    const taken = new Set(COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    setPluginCommands(pluginCommands(snap.plugins.plugins, taken));
  }, [snap.plugins]);

  // @mentions: the project's files, the code graph's symbols and the flow's criteria, as the person types
  useEffect(() => {
    const tm = line.startsWith("/") ? null : typingMention(line.slice(0, cursor));
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
  }, [core, line, cursor]);

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
      setEpoch((e) => e + 1);
    }
    if (reply.mouse !== undefined) {
      const on = reply.mouse === "toggle" ? !mouse : reply.mouse;
      if (!screen) push({ kind: "dim", text: "  The wheel scrolls in the full screen only (keel2 tui without --inline)." });
      else {
        stdout?.write(on ? MOUSE.on : MOUSE.off);
        setMouse(on);
        push({ kind: "ok", text: on ? "the wheel scrolls keel TUI (hold Option or Fn to select text, or /mouse off)" : "the wheel is the terminal's again: select text as usual; PgUp / PgDn scroll" });
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
        const { text: full, images } = pastes.current.expand(reply.chat);
        const mentions = core.mentions.mentionsIn(reply.chat);
        if (images.length) push({ kind: "dim", text: `  KeelBot takes no images yet: it gets the path of ${images.map((i) => i.name).join(", ")}` });
        if (mentions.length) push({ kind: "dim", text: `  with ${mentions.map((m) => `@${m.value}`).join(" ")}` });
        pastes.current.clear();
        await core.send(full, mentions);
      } catch (e) {
        push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    }
    if (reply.mode) setMode(reply.mode);
    if (reply.quit) exit();
  }, [core, exit, push, stdout, screen, mouse]);

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
    setHistory((h) => (h[h.length - 1] === text ? h : [...h, text].slice(-200)));
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
    const c = p.pick!.choices.find((x) => x.value === value);
    push({ kind: "dim", text: `  ${p.pick!.title} → ${c?.label ?? value}` });
    setPending(null);
    setRunning(p.cmd);
    const r = await follow(p.cmd, () => p.pick!.then(value));
    setRunning(null);
    await handle(r, p.cmd);
  }, [handle, pending, push]);

  const filtered = pending?.pick ? pending.pick.choices.filter((c) => !pickFilter || c.label.toLowerCase().includes(pickFilter.toLowerCase())) : [];

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
    const choices = [
      ...(w.kind !== "clarify" && opts.includes("approve") ? [{ label: "Approve", value: "approve", hint: `/approve${at}` }] : []),
      ...(opts.includes("reject") ? [{ label: "Send back…", value: "reject", hint: "you say why; the agent gets your words" }] : []),
      ...(!n || w.kind === "clarify" ? [{ label: "Answer… (its questions or choices)", value: "answer", hint: "/answer" }] : []),
      { label: "Stop the flow", value: "stop", hint: "agents stop; every finished step stays saved" },
      { label: "Read it first", value: "status", hint: n ? "/inbox" : "/status" },
    ];
    return { title: `${flow} · ${w.title}: what do you do?`, choices, then: (v) => {
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
    setPickIdx(0);
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
  const cache = useRef(new Map<number, { w: number; lines: string[] }>());
  const lines = useMemo(() => {
    if (!screen) return [];
    const out: string[] = [];
    for (const it of items) {
      let c = cache.current.get(it.id);
      if (!c || c.w !== width) {
        c = { w: width, lines: it.kind === "start" ? startLines(it.s, width, t.paint) : [...(it.gap ? [""] : []), ...blockLines(it.b, width, t.paint, t.tint, t.level)] };
        cache.current.set(it.id, c);
      }
      out.push(...c.lines);
    }
    return out;
  }, [items, width, screen, t.paint, t.tint, t.level]);
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
  // the wheel, Home and End: read from the raw input (Ink gives no key for them)
  const { internal_eventEmitter: rawInput } = useStdin() as unknown as { internal_eventEmitter?: NodeJS.EventEmitter };
  useEffect(() => {
    if (!screen || !rawInput) return;
    const on = (chunk: string | Buffer) => {
      const s = String(chunk);
      const n = wheel(s);
      if (n && mode) return mode.wheel(n * 3);
      if (n) return scroll(n * 3);
      for (const c of leftClicks(s)) clicks.hit(c.col, c.row)?.act();
      const end = /^\x1b(\[(F|4~|8~)|OF)$/.test(s);
      const home = /^\x1b(\[(H|1~|7~)|OH)$/.test(s);
      if (mode && (end || home)) void mode.press(end ? "end" : "home");
      else if (end) setOffset(0);
      else if (home) setOffset(Number.MAX_SAFE_INTEGER);
    };
    rawInput.on("input", on);
    return () => void rawInput.off("input", on);
  }, [rawInput, screen, scroll, clicks, mode]);

  useInput((input, key) => {
    // the mouse's reports are read below, from the raw input; never typed into the prompt
    if (isMouse(input) || isMouse("\x1b" + input)) return;
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
        push({ kind: "dim", text: "  cancelled" });
        setPending(null);
      } else if (key.upArrow) setPickIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setPickIdx((i) => Math.min(filtered.length - 1, i + 1));
      else if (key.return) {
        const c = filtered[pickIdx];
        if (c) void choose(c.value);
      } else if (key.backspace || key.delete) {
        setPickFilter((f) => f.slice(0, -1));
        setPickIdx(0);
      } else if (input && !key.ctrl && !key.meta && /^\d$/.test(input) && !pickFilter && Number(input) >= 1 && Number(input) <= Math.min(9, filtered.length)) {
        void choose(filtered[Number(input) - 1].value);
      } else if (input && !key.ctrl && !key.meta) {
        setPickFilter((f) => f + input);
        setPickIdx(0);
      }
      return;
    }
    const pluginPanel = key.ctrl ? snap.plugins.plugins.find((x) => x.panel?.key === input) : undefined;
    if (pluginPanel) {
      const id = `plugin:${pluginPanel.name}` as PanelId;
      setPanels((ps) => (ps.includes(id) ? ps.filter((x) => x !== id) : [...ps, id]));
      return;
    }
    if (key.ctrl && input === "o") {
      const j = snap.running[0];
      if (j) followAgent(j.id);
      else push({ kind: "dim", text: "  No agent at work. /agent lists yours." });
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
      core.setChatMode(next);          // the status line's first word changes; nothing goes into the transcript
      return;
    }
    if (key.tab) {
      const cs = comps.length ? comps : complete(ctx, line, botCmds);
      if (cs.length) setText(cs[comps.length ? compIdx : 0].value);
      return;
    }
    if (key.upArrow || key.downArrow) {
      if (comps.length) {
        setCompIdx((i) => (key.upArrow ? Math.max(0, i - 1) : Math.min(Math.min(comps.length, 8) - 1, i + 1)));
        return;
      }
      if (!history.length) return;
      const i = key.upArrow ? (hIdx < 0 ? history.length - 1 : Math.max(0, hIdx - 1)) : hIdx < 0 ? -1 : hIdx + 1;
      if (i < 0 || i >= history.length) {
        setHIdx(-1);
        setText("");
      } else {
        setHIdx(i);
        setText(history[i]);
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
      if (cursor > 0) setText(line.slice(0, cursor - 1) + line.slice(cursor), cursor - 1);
      return;
    }
    if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor((c) => Math.min(line.length, c + 1));
    if (key.ctrl && input === "u") return setText("");
    if (key.ctrl || key.meta || !input) return;
    // a paste: many lines or a long text behind "[pasted N lines #1]", an image path as "[image x.png #2]"
    const add = isPaste(input) ? pastes.current.add(input).insert : input.replace(/\r\n?|\n/g, " ");
    setText(line.slice(0, cursor) + add + line.slice(cursor), cursor + add.length);
  });

  const chat = snap.chat;
  const steps = chat.steps;
  const lastText = [...steps].reverse().find((s) => s.kind === "text" || s.kind === "answer");
  const tools = steps.filter((s) => s.kind !== "text" && s.kind !== "answer" && s.kind !== "thinking").slice(-4);
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
      <Box flexDirection="column" height={height} width={width}>
        <Text wrap="truncate-end">{headerLine(snap, width, t.paint)}</Text>
        <Text color={t.color("border")} wrap="truncate-end">{"─".repeat(width)}</Text>
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
    const liveRows = Math.max(3, Math.floor(height / 3));
    const writingLines = writing ? wrap(renderMarkdown(writing.slice(-3000), t.paint, width - 2), width - 2).slice(-liveRows) : [];
    return (
      <ClicksProvider clicks={clicks}>
      <Box flexDirection="column" height={height} width={width}>
        <Text wrap="truncate-end">{headerLine(snap, width, t.paint)}</Text>
        <Text color={t.color("border")} wrap="truncate-end">{"─".repeat(width)}</Text>
        <Box ref={viewRef} flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden" justifyContent="flex-end">
          {!started && <Text color={t.color("dim")}>connecting to keel at {snap.url} …</Text>}
          {v.shown.map((l, i) => <Text key={v.above + i} wrap="truncate-end">{l || " "}</Text>)}
        </Box>
        {v.below > 0 && (
          <Text color={t.color("accent")} wrap="truncate-end">
            {`── ↓ ${v.below} newer line${v.below === 1 ? "" : "s"} · PgDn, End${mouse ? " or the wheel" : ""} ` + "─".repeat(Math.max(0, width - 40))}
          </Text>
        )}
        {live(writingLines)}
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
        {!started && <Text color={t.color("dim")}>connecting to keel at {snap.url} …</Text>}
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
            {tools.length > 0 && <Text>{fmt.toolLines(steps, width, t.paint, 4).join("\n")}</Text>}
            {edits.map((e) => (
              <Box key={e.n} flexDirection="column" marginLeft={4}>
                {diffLines(e.diff ?? "").map((l, i) => <Text key={i} wrap="truncate-end">{l}</Text>)}
              </Box>
            ))}
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
              {now ? <Text wrap="truncate-end" color={t.color("dim")}>{"   " + now}</Text> : null}
            </Clickable>
          );
        })}
        {running && <Text color={t.color("dim")}>{`… ${running}`}</Text>}
        {panels.map((p) => {
          if (p.startsWith("job:")) return <JobPanel key={p} id={p.slice(4)} s={snap} width={width} />;
          if (!p.startsWith("plugin:")) return <Panel key={p} name={p as PanelName} s={snap} width={width}
            on={{ agent: followAgent, waiting: () => answerGate(), flow: () => runNow("/status"), inbox: (n) => answerGate(n) }} />;
          const v = snap.plugins.plugins.find((x) => `plugin:${x.name}` === p);
          return v?.panel && snap.project ? <PluginPanel key={p} plugin={v.title} panel={v.panel} pid={snap.project.id} width={width} /> : null;
        })}
        {pending?.pick ? (
          <Picker title={pending.pick.title} choices={filtered} index={pickIdx} filter={pickFilter} />
        ) : (
          <Box flexDirection="column">
            {pending?.ask && <Text color={t.color("accent")} bold>{pending.ask.prompt}<Text color={t.color("dim")} bold={false}> (Esc cancels)</Text></Text>}
            <Box borderStyle="round" borderColor={border} paddingX={1} marginTop={1}>
              <Text>
                <Text color={t.color("accent")} bold>{"› "}</Text>
                {line ? <>{inputText(line.slice(0, cursor))}<Text inverse>{line[cursor] ?? " "}</Text>{inputText(line.slice(cursor + 1))}</>
                  : <><Text inverse> </Text><Text color={t.color("dim")}>{pending?.ask ? "type the answer, Enter sends"
                    : flowWaits ? "A gate waits for you: /approve, /reject <why>, /next … or ask KeelBot" : "Ask KeelBot, or / for commands"}</Text></>}
              </Text>
            </Box>
            {comps.length > 0 && <Completions items={comps} index={compIdx} />}
          </Box>
        )}
        <Clickable act={answerWaiting}><StatusLine s={snap} /></Clickable>
      </>
    );
  }

  /** The prompt's text: a command's name in the accent colour while it is typed. */
  function inputText(x: string) {
    const m = /^(\/\S*)(.*)$/s.exec(x);
    if (!m || x !== line.slice(0, x.length) || !line.startsWith("/")) return <Text>{x}</Text>;
    return <><Text color={t.color("accent")} bold>{m[1]}</Text><Text>{m[2]}</Text></>;
  }
}
