// keel TUI, the Ink app: the start screen, then the transcript (KeelBot's answers, commands' answers, keel's live
// notices) above a live area: KeelBot's streaming answer, a panel, the picker or the prompt, and the status line.
// The state is here; what commands do is in ../core (UI-free).

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout } from "ink";
import { complete, follow, run, type Ask, type Block, type Completion, type Ctx, type PanelName, type Pick, type Reply } from "../core/commands";
import type { KeelCore, Snapshot } from "../core/keel";
import { renderMarkdown } from "../core/markdown";
import { applyLevel, makeTheme, type Theme } from "../core/theme";
import { ThemeProvider, useTheme } from "./theme";
import { pickVerb, Thinking } from "./thinking";
import * as fmt from "../core/format";
import { BlockView, Completions, Panel, Picker, StartScreen, StatusLine } from "./parts";

type Item = { id: number; kind: "start"; s: Snapshot } | { id: number; kind: "block"; b: Block };

/** What a driver (keel-tui --script, tests) can see of the app's state. */
export type Probe = { started: boolean; busy: boolean; pick: boolean; ask: boolean; chatBusy: boolean; answers: number };

type Pending = { cmd: string; pick?: Pick; ask?: Ask };

const CTRL_PANEL: Record<string, PanelName> = { f: "flow", a: "agents", b: "inbox" };

/** keel TUI in keel's colours (the theme: the dashboard's palette, NO_COLOR, KEEL_TUI_THEME). */
export function App({ theme, ...props }: { core: KeelCore; probe?: Probe; width?: number; theme?: Theme }) {
  const th = useMemo(() => theme ?? makeTheme(), [theme]);
  applyLevel(th);
  return <ThemeProvider theme={th}><Main {...props} /></ThemeProvider>;
}

function Main({ core, probe, width: fixedWidth }: { core: KeelCore; probe?: Probe; width?: number }) {
  const t = useTheme();
  const { exit } = useApp();
  const { stdout } = useStdout();
  // a terminal may say 0 columns at first (docker exec -it sets the size a moment after the start): count it as 100
  const cols = () => Math.max(40, stdout?.columns || 100);
  const [termWidth, setTermWidth] = useState(cols);
  useEffect(() => {
    if (!stdout || fixedWidth) return;
    const on = () => setTermWidth(cols());
    stdout.on("resize", on);
    return () => void stdout.off("resize", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout, fixedWidth]);
  const width = fixedWidth ?? termWidth;
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
  const [panels, setPanels] = useState<PanelName[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [comps, setComps] = useState<Completion[]>([]);
  const [compIdx, setCompIdx] = useState(0);
  const [botCmds, setBotCmds] = useState<{ name: string; description: string }[]>([]);
  const [answers, setAnswers] = useState(0);
  const ctrlC = useRef(0);
  const nextId = useRef(1);

  const ctx: Ctx = useMemo(() => ({ core, width, paint: t.paint }), [core, width, t.paint]);
  // for the answer event's handler (it is set up once): the colours, the width and when the turn started
  const look = useRef({ paint: t.paint, width });
  look.current = { paint: t.paint, width };
  const turnStart = useRef<number | null>(null);
  if (snap.chat.startedAt) turnStart.current = snap.chat.startedAt;

  const push = useCallback((...bs: Block[]) => {
    if (!bs.length) return;
    setItems((xs) => [...xs, ...bs.map((b) => ({ id: nextId.current++, kind: "block" as const, b }))]);
  }, []);

  useEffect(() => {
    const offs = [
      core.on("change", (s) => setSnap(s)),
      core.on("notice", (t) => push({ kind: "notice", text: t })),
      core.on("answer", (a) => {
        const d = a.message?.data;
        const { paint, width: w } = look.current;
        const used = d ? [d.provider && d.model ? `${d.provider}/${d.model}` : "", d.tokens_in || d.tokens_out ? `${fmt.short((d.tokens_in ?? 0) + (d.tokens_out ?? 0))} tokens` : "",
          d.cost_usd ? `$${d.cost_usd.toFixed(2)}` : ""].filter(Boolean).join(" · ") : "";
        // what it did (its tools, settled: xal's way), the answer, then how the turn ended and what it used
        const tools = fmt.toolLines(core.snapshot.chat.steps, w, paint);
        const ms = d?.ms ?? (turnStart.current ? Date.now() - turnStart.current : 0);
        const outcome = a.ok ? "done" : d?.status === "stopped" ? "stopped" : "failed";
        push(...(tools.length ? [{ kind: "text" as const, text: tools.join("\n") }] : []), { kind: a.ok ? "markdown" : "error", text: a.text },
          { kind: "text", text: fmt.turnFooter(outcome, ms, used ? `KeelBot · ${used}` : "KeelBot", paint) });
        turnStart.current = null;
        setAnswers((n) => n + 1);
      }),
    ];
    let alive = true;
    void core.start().then((s) => {
      if (!alive) return;
      setItems([{ id: nextId.current++, kind: "start", s }]);
      setStarted(true);
      void core.keelbotCommands().then((c) => alive && setBotCmds(c));
    });
    return () => {
      alive = false;
      offs.forEach((o) => o());
      core.stop();
    };
  }, [core, push]);

  if (probe) Object.assign(probe, { started, busy: running !== null, pick: !!pending?.pick, ask: !!pending?.ask, chatBusy: snap.chat.busy, answers });

  const handle = useCallback(async (reply: Reply, cmd: string) => {
    push(...reply.blocks);
    if (reply.panel) setPanels((ps) => (reply.panel === "off" ? [] : ps.includes(reply.panel as PanelName) ? ps : [...ps, reply.panel as PanelName]));
    if (reply.clear) {
      stdout?.write("\x1b[2J\x1b[3J\x1b[H");
      setItems([]);
      setEpoch((e) => e + 1);
    }
    if (reply.pick) {
      setPending({ cmd, pick: reply.pick });
      setPickIdx(0);
      setPickFilter("");
    } else if (reply.ask) setPending({ cmd, ask: reply.ask });
    else setPending(null);
    if (reply.chat) {
      try {
        await core.send(reply.chat);
      } catch (e) {
        push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    }
    if (reply.quit) exit();
  }, [core, exit, push, stdout]);

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

  useInput((input, key) => {
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
      }
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
        void submit(c && c.value.trim() !== line.trim() && !line.includes(" ") ? c.value : line);
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
    const add = input.replace(/\r\n?|\n/g, " ");
    setText(line.slice(0, cursor) + add + line.slice(cursor), cursor + add.length);
  });

  const chat = snap.chat;
  const steps = chat.steps;
  const lastText = [...steps].reverse().find((s) => s.kind === "text" || s.kind === "answer");
  const tools = steps.filter((s) => s.kind !== "text" && s.kind !== "answer" && s.kind !== "thinking").slice(-4);
  // what KeelBot is writing now (helper.delta), else its last whole message of this turn
  const writing = chat.stream || lastText?.text || "";
  const verb = useMemo(() => pickVerb(), [chat.callId]);
  const flowWaits = snap.flow?.thread?.status === "waiting";
  const border = pending?.ask || line ? t.color("accent") : flowWaits ? t.color("gate") : t.color("border");
  const agentsHere = panels.includes("agents") ? [] : snap.running.slice(0, 3);

  return (
    <>
      <Static key={epoch} items={items}>
        {(it) => (it.kind === "start" ? <StartScreen key={it.id} s={it.s} width={width} /> : <BlockView key={it.id} b={it.b} width={width} />)}
      </Static>
      <Box flexDirection="column">
        {!started && <Text color={t.color("dim")}>connecting to keel at {snap.url} …</Text>}
        {chat.busy && (
          <Box flexDirection="column" marginTop={1}>
            {tools.length > 0 && <Text>{fmt.toolLines(steps, width, t.paint, 4).join("\n")}</Text>}
            {writing && <Box marginLeft={2}><Text>{renderMarkdown(writing.slice(-3000), t.paint)}</Text></Box>}
            <Thinking verb={verb} since={chat.startedAt} tokens={Math.round(chat.wrote / 4) || undefined} hint="esc to interrupt" />
          </Box>
        )}
        {!chat.busy && agentsHere.map((j) => (
          <Thinking key={j.id} who={j.agent} verb={pickVerb(j.id)} since={Date.parse(j.started_at) || null}
            tokens={fmt.tokensOf(j) || undefined} hint={[j.step, j.ac].filter(Boolean).join(" ")} />
        ))}
        {running && <Text color={t.color("dim")}>{`… ${running}`}</Text>}
        {panels.map((p) => <Panel key={p} name={p} s={snap} width={width} />)}
        {pending?.pick ? (
          <Picker title={pending.pick.title} choices={filtered} index={pickIdx} filter={pickFilter} />
        ) : (
          <Box flexDirection="column">
            {pending?.ask && <Text color={t.color("accent")} bold>{pending.ask.prompt}<Text color={t.color("dim")} bold={false}> (Esc cancels)</Text></Text>}
            <Box borderStyle="round" borderColor={border} paddingX={1}>
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
        <StatusLine s={snap} />
      </Box>
    </>
  );

  /** The prompt's text: a command's name in the accent colour while it is typed. */
  function inputText(x: string) {
    const m = /^(\/\S*)(.*)$/s.exec(x);
    if (!m || x !== line.slice(0, x.length) || !line.startsWith("/")) return <Text>{x}</Text>;
    return <><Text color={t.color("accent")} bold>{m[1]}</Text><Text>{m[2]}</Text></>;
  }
}
