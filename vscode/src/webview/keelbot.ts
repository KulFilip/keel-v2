// KeelBot's page: modes, model, the messages (markdown), the answer as it streams, changed files and the composer.
import type { ChatVm, ToChat } from "../views/protocol";
import { h, html, vscode, wireFileRefs } from "./dom";

document.body.classList.add("sidebar");
const app = document.getElementById("app")!;
let chat: ChatVm | undefined;
const openLogs = new Set<number>();

const top = h("div", { class: "top" });
const messages = h("div", { class: "messages", role: "log", "aria-live": "polite" });
const changes = h("div");
const note = h("div", { class: "muted note" });
const input = h("textarea", { rows: "3", placeholder: "Message KeelBot (Ctrl+Enter sends)", "aria-label": "Message KeelBot" });
const sendBtn = h("button", { title: "Send (Ctrl+Enter)" }, "Send");
const at = h("button", { class: "secondary", title: "Add the open file" }, "@");
const bottom = h("div", { class: "bottom" }, changes, h("div", { class: "composer" }, input, h("div", { class: "row" }, sendBtn, at)), note);
app.replaceChildren(h("div", { class: "chat" }, top, messages, bottom));
wireFileRefs(app);

function send(): void {
  if (chat?.busy) {
    vscode.postMessage({ type: "stop" });
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  vscode.postMessage({ type: "send", text });
}

sendBtn.addEventListener("click", send);
at.addEventListener("click", () => vscode.postMessage({ type: "mention" }));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    send();
  }
});

function renderTop(c: ChatVm): void {
  const modes = (["ask", "fix", "edit"] as const).map((m) =>
    h("button", { class: `toggle${c.mode === m ? " on" : ""}`, "aria-pressed": c.mode === m ? "true" : "false", onclick: () => vscode.postMessage({ type: "mode", mode: m }) }, m.charAt(0).toUpperCase() + m.slice(1)),
  );
  top.replaceChildren(
    h(
      "div",
      { class: "row" },
      ...modes,
      h("button", { class: "toggle", title: "KeelBot's model", onclick: () => vscode.postMessage({ type: "pickModel" }) }, `${c.model || "model"} ▾`),
      c.usage ? h("span", { class: "muted" }, c.usage) : null,
    ),
    h("div", { class: "row" }, h("button", { class: "link", onclick: () => vscode.postMessage({ type: "new" }) }, "New chat"), h("button", { class: "link", onclick: () => vscode.postMessage({ type: "pickChat" }) }, "Chats")),
  );
}

function renderMessages(c: ChatVm): void {
  const follow = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 30;
  const out: Node[] = [];
  if (c.noProject) out.push(h("p", { class: "muted" }, c.noProject));
  else if (!c.messages.length && !c.busy) {
    out.push(h("p", {}, h("strong", {}, "KeelBot")), h("p", { class: "muted" }, "Ask about the code, have it fix something, or edit files. Select code in the editor and press Ctrl+Alt+K (Cmd+Alt+K on a Mac) to ask about it."));
  }
  for (const m of c.messages) {
    if (m.role === "user") {
      out.push(h("div", { class: "msg user" }, h("div", { class: "bubble" }, m.text ?? "")));
      continue;
    }
    const box = h("div", { class: "msg" }, h("div", { class: "who" }, m.role === "note" ? "note" : "KeelBot"));
    if (m.tools) {
      const open = openLogs.has(m.n);
      box.append(
        h(
          "button",
          {
            class: "link",
            "aria-expanded": open ? "true" : "false",
            onclick: () => {
              if (!openLogs.delete(m.n)) openLogs.add(m.n);
              if (chat) renderMessages(chat);
            },
          },
          `✓ ${m.tools} ${open ? "▾" : "▸"}`,
        ),
      );
      if (open && m.toolLines) box.append(h("pre", { class: "detail" }, m.toolLines));
    }
    if (m.html) box.append(html("md", m.html));
    if (m.files?.length) box.append(h("div", { class: "muted" }, `changed: ${m.files.join(", ")}`));
    out.push(box);
  }
  if (c.busy) {
    if (c.liveHtml) out.push(h("div", { class: "msg" }, h("div", { class: "who" }, "KeelBot"), html("md", c.liveHtml)));
    out.push(h("p", { class: "muted" }, "KeelBot works…"));
  }
  messages.replaceChildren(...out);
  if (follow || c.busy) messages.scrollTop = messages.scrollHeight;
}

function renderChanges(c: ChatVm): void {
  if (!c.changes.length) {
    changes.replaceChildren();
    return;
  }
  const ul = h("ul", { class: "changes" });
  for (const f of c.changes) {
    ul.append(h("li", {}, h("a", { href: "#", onclick: (e: Event) => (e.preventDefault(), vscode.postMessage({ type: "open", path: f.path, line: 1 })) }, f.path), " ", h("span", { class: "add" }, `+${f.added}`), " ", h("span", { class: "del" }, `−${f.removed}`)));
  }
  changes.replaceChildren(
    h("div", { class: "muted" }, "CHANGED FILES"),
    ul,
    h("div", { class: "row" }, h("button", { onclick: () => vscode.postMessage({ type: "keep" }) }, "Done: run the checks and commit"), h("button", { class: "link", onclick: () => vscode.postMessage({ type: "undoAll" }) }, "Undo all")),
  );
}

window.addEventListener("message", (e: MessageEvent<ToChat>) => {
  const m = e.data;
  if (m.type === "chat") {
    chat = m.chat;
    renderTop(chat);
    renderMessages(chat);
    renderChanges(chat);
    note.textContent = chat.note ?? "";
    sendBtn.textContent = chat.busy ? "Stop" : "Send";
    sendBtn.title = chat.busy ? "Stop KeelBot" : "Send (Ctrl+Enter)";
    input.disabled = !!chat.noProject;
  } else if (m.type === "prefill") {
    if (m.text === "") input.value = "";
    else if (m.text.startsWith("@") && m.text.length < 300 && !m.text.includes("\n")) input.value += (input.value && !input.value.endsWith(" ") ? " " : "") + m.text;
    else input.value = m.text;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  } else if (m.type === "note") {
    note.textContent = m.text;
  }
});

vscode.postMessage({ type: "ready" });
