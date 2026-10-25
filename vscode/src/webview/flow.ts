// The flow panel's page: the flow (steps, criteria, the gate form), "Now" and the live activity feed.
import type {
  AgentVm,
  FlowVm,
  GateVm,
  LineVm,
  ToFlow,
} from "../views/protocol";
import { elapsed, h, html, vscode, wireFileRefs } from "./dom";

type Filter = "all" | "edits" | "commands" | "tests";
const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["edits", "Edits"],
  ["commands", "Commands"],
  ["tests", "Tests"],
];
const MARKS: Record<string, string> = {
  read: "·",
  edit: "✎",
  command: "›",
  test: "✓",
  guard: "⊘",
  gate: "◆",
  step: "▪",
  agent: "●",
  text: "“",
  error: "!",
};

const matches = (f: Filter, l: LineVm): boolean =>
  f === "all" ||
  (f === "edits"
    ? l.kind === "edit"
    : f === "commands"
      ? l.kind === "command" || l.kind === "test"
      : l.kind === "test");

let flow: FlowVm | undefined;
let now: { step: string; agents: AgentVm[] } = { step: "—", agents: [] };
let lines: LineVm[] = [];
let filter: Filter = "all";
let paused = false;
const opened = new Set<string>();
let note: { text: string; bad?: boolean } | undefined;
let busy = false;
// the gate form, kept while the same question is shown
let form: {
  id?: string;
  picked?: string;
  why: string;
  qPicked: Record<string, string[]>;
  qTyped: Record<string, string>;
  problem: string;
} = { why: "", qPicked: {}, qTyped: {}, problem: "" };

const app = document.getElementById("app")!;
const head = h("div");
const nowBox = h("div", { class: "now" });
const feedBar = h("div", { class: "row" });
const feed = h("div", { class: "feed", role: "log", "aria-live": "polite" });
const empty = h(
  "p",
  { class: "muted" },
  "Nothing yet: the agents' reads, edits, commands and tests show here as they happen.",
);
app.replaceChildren(
  head,
  h("h2", {}, "Now"),
  nowBox,
  h("h2", {}, "Activity"),
  feedBar,
  feed,
);
wireFileRefs(app);

function postAnswer(): void {
  if (!flow?.gate) return;
  const g = flow.gate;
  const b = g.buttons.find((x) => x.name === form.picked);
  if (g.buttons.length && !b) return setProblem("Choose one first.");
  if (b?.why === "required" && !form.why.trim())
    return setProblem(`Write why first: “${b.label}” needs a reason.`);
  setProblem("");
  vscode.postMessage({
    type: "answer",
    picked: form.picked,
    why: form.why,
    qPicked: form.qPicked,
    qTyped: form.qTyped,
  });
}

function setProblem(p: string): void {
  form.problem = p;
  const el = document.getElementById("gate-problem");
  if (el) el.textContent = p;
}

function gateCard(g: GateVm): HTMLElement {
  if (form.id !== g.id)
    form = {
      id: g.id,
      picked: g.picked,
      why: "",
      qPicked: {},
      qTyped: {},
      problem: "",
    };
  const card = h("div", { class: "card gate", id: "gate" });
  card.append(
    h(
      "div",
      { class: "row" },
      h("span", { class: "chip accent" }, "◆ Waits for you"),
      h("strong", {}, g.title),
    ),
  );
  if (g.detailHtml) card.append(html("md", g.detailHtml));
  const picked = g.buttons.find((b) => b.name === form.picked);
  if (g.buttons.length) {
    const row = h("div", { class: "choices", role: "radiogroup" });
    for (const b of g.buttons) {
      row.append(
        h(
          "button",
          {
            class: `toggle${b.name === form.picked ? " on" : ""}`,
            role: "radio",
            "aria-checked": b.name === form.picked ? "true" : "false",
            title: b.description || undefined,
            onclick: () => {
              form.picked = b.name;
              render();
            },
          },
          b.label,
        ),
      );
    }
    card.append(row);
    if (picked?.description)
      card.append(h("div", { class: "muted choice-desc" }, picked.description));
  }
  for (const q of g.questions) {
    const box = h("div", { class: "question" }, h("strong", {}, q.question));
    if (q.why) box.append(h("div", { class: "muted" }, q.why));
    const chosen =
      form.qPicked[q.id] ??
      q.options.filter((o) => o.picked).map((o) => o.label);
    for (const o of q.options) {
      const input = h("input", {
        type: q.multiple ? "checkbox" : "radio",
        name: `q-${q.id}`,
        checked: chosen.includes(o.label),
      });
      input.addEventListener("change", () => {
        const cur = form.qPicked[q.id] ?? chosen;
        form.qPicked[q.id] = q.multiple
          ? cur.includes(o.label)
            ? cur.filter((x) => x !== o.label)
            : [...cur, o.label]
          : [o.label];
      });
      box.append(
        h(
          "label",
          {},
          input,
          ` ${o.label}`,
          o.recommended
            ? h("span", { class: "muted" }, "  (keel suggests)")
            : null,
          o.description
            ? h("div", { class: "muted choice-desc" }, o.description)
            : null,
        ),
      );
    }
    const own = h("input", {
      type: "text",
      placeholder: "Or your own words",
      value: form.qTyped[q.id] ?? "",
    });
    own.addEventListener("input", () => (form.qTyped[q.id] = own.value));
    box.append(own);
    card.append(box);
  }
  if (picked?.reasonLabel) {
    const ta = h("textarea", {
      rows: "3",
      placeholder: picked.reasonLabel,
      "aria-label": picked.reasonLabel,
    });
    ta.value = form.why;
    ta.addEventListener("input", () => (form.why = ta.value));
    card.append(h("div", { class: "muted" }, picked.reasonLabel), ta);
  }
  if (g.buttons.length || g.questions.length) {
    const label = picked ? `Send: ${picked.label}` : "Send the answers";
    card.append(
      h(
        "div",
        { class: "row", style: "margin-top:8px" },
        h("button", { disabled: busy, onclick: postAnswer }, label),
        h("span", { class: "problem", id: "gate-problem" }, form.problem),
      ),
    );
  } else {
    card.append(
      h(
        "p",
        { class: "muted" },
        "This question has no answers to pick here. Open it in keel's dashboard.",
      ),
    );
  }
  return card;
}

function renderHead(): void {
  if (!flow) return;
  const f = flow;
  const status = f.waits
    ? h("span", { class: "chip accent" }, "◆ Waits for you")
    : h(
        "span",
        {
          class: `chip ${f.status === "done" ? "ok" : f.status === "failed" || f.status === "error" ? "bad" : ""}`,
        },
        f.status,
      );
  const parts: Node[] = [
    h(
      "div",
      { class: "row" },
      status,
      f.meta ? h("span", { class: "muted" }, f.meta) : null,
    ),
    h("h1", {}, f.title),
  ];
  if (note)
    parts.push(h("div", { class: `note${note.bad ? " bad" : ""}` }, note.text));
  if (f.gate) {
    // the same question while the person types: keep its elements (focus, caret) unless the form itself changed
    const keep = gateEl && !gateDirty && gateEl.dataset.id === (f.gate.id ?? "") && gateEl.contains(document.activeElement);
    if (!keep) {
      gateEl = gateCard(f.gate);
      gateEl.dataset.id = f.gate.id ?? "";
    }
    gateDirty = false;
    parts.push(gateEl!);
  } else gateEl = undefined;
  const steps = h("div", { class: "steps", "aria-label": "Steps" });
  f.steps.forEach((s, i) => {
    if (i) steps.append(h("span", { class: "arrow" }, "→"));
    steps.append(
      s.state === "done"
        ? h("span", { class: "chip ok" }, `✓ ${s.name}`)
        : s.state === "current"
          ? h("span", { class: "chip accent" }, `◆ ${s.name}`)
          : h("span", { class: "muted" }, s.name),
    );
  });
  parts.push(steps);
  if (f.current || f.phase)
    parts.push(
      h(
        "div",
        { class: "muted" },
        `Phase: ${f.phase || "—"}${f.current && f.current !== f.phase ? ` · step ${f.current}` : ""}`,
      ),
    );
  if (f.error) parts.push(h("div", { class: "note bad" }, f.error));
  if (f.acs.length) {
    parts.push(h("h2", {}, "Acceptance criteria"));
    const ul = h("ul", { class: "acs" });
    for (const a of f.acs) {
      const mark =
        a.state === "green"
          ? "✓"
          : a.state === "red"
            ? "✗"
            : a.state === "doing"
              ? "◆"
              : "○";
      ul.append(
        h(
          "li",
          {},
          h("span", { class: `dot ${a.state}`, title: a.state }, mark),
          h("strong", {}, a.id),
          a.layer ? h("span", { class: "muted" }, a.layer) : null,
          h("span", {}, a.title),
        ),
      );
    }
    parts.push(ul);
  }
  const actions = h("div", { class: "row", style: "margin-top:10px" });
  if (f.canStop)
    actions.append(
      h(
        "button",
        {
          class: "danger",
          onclick: () => vscode.postMessage({ type: "stop" }),
        },
        "Stop flow",
      ),
    );
  if (f.canResume)
    actions.append(
      h(
        "button",
        {
          class: "secondary",
          onclick: () => vscode.postMessage({ type: "resume" }),
        },
        "Resume",
      ),
    );
  if (f.spec)
    actions.append(
      h(
        "button",
        {
          class: "link",
          onclick: () => vscode.postMessage({ type: "openSpec" }),
        },
        "Open the spec",
      ),
    );
  if (f.branch)
    actions.append(h("span", { class: "muted" }, `branch ${f.branch}`));
  if (f.updated)
    actions.append(h("span", { class: "muted" }, `updated ${f.updated}`));
  actions.append(
    h(
      "button",
      { class: "link", onclick: () => vscode.postMessage({ type: "refresh" }) },
      "Refresh",
    ),
  );
  parts.push(actions);
  head.replaceChildren(...parts);
}

function renderNow(): void {
  const rows: Node[] = [
    h(
      "div",
      { class: "row" },
      h("strong", {}, "Step"),
      h("span", { class: "muted" }, now.step || "—"),
    ),
  ];
  if (!now.agents.length)
    rows.push(h("div", { class: "muted" }, "No agent runs right now."));
  for (const a of now.agents) {
    const bits = [
      a.agent,
      a.model,
      a.effort,
      a.since ? elapsed(Date.now() - a.since) : undefined,
      a.tokens || undefined,
      a.cost || undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    rows.push(
      h(
        "div",
        { class: "agent" },
        h("span", { class: "live", "aria-hidden": "true" }, "● "),
        bits,
      ),
    );
  }
  nowBox.replaceChildren(...rows);
}

function renderBar(): void {
  const chips = FILTERS.map(([id, label]) =>
    h(
      "button",
      {
        class: `toggle${filter === id ? " on" : ""}`,
        "aria-pressed": filter === id ? "true" : "false",
        onclick: () => {
          filter = id;
          renderBar();
          renderFeed();
        },
      },
      label,
    ),
  );
  const pause = h(
    "button",
    {
      class: `toggle${paused ? " on" : ""}`,
      onclick: () => {
        paused = !paused;
        renderBar();
        if (!paused) toBottom();
      },
    },
    paused ? "Resume auto-scroll" : "Pause auto-scroll",
  );
  const copy = h(
    "button",
    {
      class: "link",
      onclick: () =>
        vscode.postMessage({
          type: "copyLog",
          text: lines.map(plain).join("\n"),
        }),
    },
    "Copy log",
  );
  feedBar.replaceChildren(...chips, pause, copy);
}

function plain(l: LineVm): string {
  let s = `${l.clock}  ${l.agent ? l.agent + "  " : ""}${l.title}`;
  if (l.added || l.removed) s += `  +${l.added ?? 0} −${l.removed ?? 0}`;
  if (l.exit !== undefined) s += `  exit ${l.exit}`;
  return s;
}

function lineEl(l: LineVm): HTMLElement {
  const bad =
    l.ok === false ||
    l.kind === "error" ||
    l.kind === "guard" ||
    (l.failed ?? 0) > 0;
  const cls = [
    "line",
    bad ? "bad" : "",
    l.kind === "test" && !bad ? "test-ok" : "",
    l.kind === "gate" ? "gate" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const mark =
    l.kind === "test" && (l.failed ?? 0) > 0 ? "✗" : (MARKS[l.kind] ?? "·");
  const row = h(
    "div",
    { class: "head" },
    h("span", { class: "time" }, l.clock),
    h("span", { class: "mark", "aria-hidden": "true" }, mark),
    l.agent ? h("span", { class: "who" }, l.agent) : null,
  );
  if (l.path)
    row.append(
      h(
        "a",
        {
          href: "#",
          class: "title",
          title: `Open ${l.path}`,
          onclick: (e: Event) => (
            e.preventDefault(),
            vscode.postMessage({ type: "open", path: l.path })
          ),
        },
        l.title,
      ),
    );
  else row.append(h("span", { class: "title" }, l.title));
  if (l.added || l.removed)
    row.append(
      h("span", { class: "add" }, `+${l.added ?? 0}`),
      h("span", { class: "del" }, `−${l.removed ?? 0}`),
    );
  if (l.exit !== undefined)
    row.append(h("span", { class: "muted" }, `exit ${l.exit}`));
  const el = h("div", { class: cls, "data-key": l.key }, row);
  if (l.detail || l.detailHtml) {
    const open = opened.has(l.key);
    const what =
      l.kind === "edit" ? "diff" : l.detailHtml ? "answer" : "output";
    row.append(
      h(
        "button",
        {
          class: "link",
          "aria-expanded": open ? "true" : "false",
          onclick: () => {
            if (!opened.delete(l.key)) opened.add(l.key);
            el.replaceWith(lineEl(l));
          },
        },
        open ? "▾ hide" : `▸ ${what}`,
      ),
    );
    if (open)
      el.append(
        l.detailHtml
          ? html("md", l.detailHtml)
          : h("pre", { class: "detail" }, foldLong(l.detail ?? "")),
      );
  }
  return el;
}

function foldLong(t: string): string {
  const ls = t.split("\n");
  return ls.length > 80
    ? ls.slice(0, 80).join("\n") + `\n… (${ls.length - 80} more lines)`
    : t;
}

const atBottom = (): boolean =>
  feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 24;

function toBottom(): void {
  feed.scrollTop = feed.scrollHeight;
}

function renderFeed(): void {
  const shown = lines.filter((l) => matches(filter, l));
  feed.replaceChildren(...(shown.length ? shown.map(lineEl) : [empty]));
  if (!paused) toBottom();
}

function addLines(ls: LineVm[]): void {
  const follow = !paused && atBottom();
  lines.push(...ls);
  const shown = ls.filter((l) => matches(filter, l));
  if (!shown.length) return;
  if (empty.isConnected) empty.remove();
  for (const l of shown) feed.append(lineEl(l));
  // newest at the bottom: follow it, unless paused or the person scrolled up to read
  if (follow) toBottom();
}

let gateEl: HTMLElement | undefined;
let gateDirty = false;

/** The form changed (a choice picked, busy): the gate is drawn again. */
function render(): void {
  gateDirty = true;
  renderHead();
}

window.addEventListener("message", (e: MessageEvent<ToFlow>) => {
  const m = e.data;
  switch (m.type) {
    case "flow":
      flow = m.flow;
      renderHead();
      break;
    case "now":
      now = { step: m.step, agents: m.agents };
      renderNow();
      break;
    case "lines":
      if (m.reset) {
        lines = [...m.lines];
        renderFeed();
      } else addLines(m.lines);
      break;
    case "note":
      note = { text: m.text, bad: m.bad };
      if (flow) renderHead();
      else
        head.replaceChildren(
          h("div", { class: `note${m.bad ? " bad" : ""}` }, m.text),
        );
      break;
    case "busy":
      busy = m.busy;
      render();
      break;
    case "focusGate":
      setTimeout(
        () =>
          document
            .getElementById("gate")
            ?.scrollIntoView({ behavior: "smooth", block: "start" }),
        50,
      );
      break;
  }
});

renderBar();
renderNow();
renderFeed();
// the running agents' clocks
setInterval(() => {
  if (now.agents.length) renderNow();
}, 1000);
vscode.postMessage({ type: "ready" });
