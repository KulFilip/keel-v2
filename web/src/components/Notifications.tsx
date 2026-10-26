// Bell drawer (Inbox + Settings) and the in-app pop-ups (top right, with an action button).

import { useState } from "react";
import "./inbox.css";
import type { Notification as Note, NotificationSettings } from "../api";
import { clock } from "../format";
import { noticeView } from "../noticeText";
import { askPermission, EVTYPES, NTONE, permission, playSound } from "../notify";
import { useSlot } from "../sdk/registry";
import { SLOTS, type NotesSettingItem } from "../sdk/slots";
import { useApp } from "../state";
import { Seg, SwitchRow } from "./settingsUi";
import { Drawer, Tabs, Ticks } from "./ui";

/** The bell's settings (keel 0.18.57: the same block in Settings › General › Notifications and in the bell's drawer):
 *  what to tell you about and from where, the sound, the KeelBot sound (slot notes.setting), pop-ups, desktop
 *  notifications, do not disturb and a test. Saved on the keel for you; `mascot` adds "Show keel" (the drawer). */
export function BellSettings({ mascot = false }: { mascot?: boolean }) {
  const { nset, saveNset, project, notifyLocal, toast, showMascot, setShowMascot } = useApp();
  const [perm, setPerm] = useState(permission());
  // v0.15.2 the parts' fields after the sound (slot notes.setting: KeelBot's own sound)
  const parts = useSlot<NotesSettingItem>(SLOTS.notesSetting);
  const set = (patch: Partial<NotificationSettings>) => saveNset({ ...nset, ...patch });
  return (
    <div className="ss-cols ss-bell" data-testid="bell-settings">
      <div>
        <span className="ss-meta" style={{ display: "block", paddingTop: 10 }}>Tell me about</span>
        {EVTYPES.map(([k, l, d]) => (
          <SwitchRow key={k} on={!!nset.kinds[k]} title={l} help={d} onChange={(on) => set({ kinds: { ...nset.kinds, [k]: on } })} />
        ))}
        <span className="ss-meta" style={{ display: "block", paddingTop: 10 }}>From</span>
        <div style={{ padding: "8px 0" }}>
          <Seg label="From" value={nset.scope} onChange={(scope) => set({ scope })}
            options={[["all", "All projects"], ["project", `Only ${project?.name ?? "this project"}`]]} />
        </div>
      </div>
      <div>
        <SwitchRow on={nset.sound} title="Play a sound" help="Chime, soft or silent, and how loud." onChange={(sound) => set({ sound })} />
        <div className="ss-inline" style={{ paddingBottom: 8 }}>
          <Seg label="Sound" value={nset.tone} onChange={(tone) => {
            set({ tone });
            playSound("review", { ...nset, tone });
          }} options={[["chime", "Chime (two notes)"], ["soft", "Soft (one note)"], ["off", "Silent"]]} />
          <label className="ss-inline ss-meta" htmlFor="n-vol" style={{ gap: 6 }}>
            Volume
            <input type="range" id="n-vol" min={0} max={1} step={0.1} value={nset.volume} style={{ width: 100 }}
              onChange={(e) => {
                const volume = Number(e.target.value);
                set({ volume });
                playSound("review", { ...nset, volume });
              }} />
          </label>
          <button className="ss-btn sm" type="button" onClick={() => {
            playSound("review", nset);
            window.setTimeout(() => playSound("failed", nset), 700);
            toast("Needs-you chime, then the failure tone.");
          }}>Test sound</button>
        </div>
        <span className="ss-meta" style={{ display: "block", paddingBottom: 6 }}>Failures use a lower tone, so you can tell them apart without looking.</span>
        {parts.map((p) => <p.component key={p.id} />)}
        <SwitchRow on={nset.popup} title="Show a pop-up in keel" help="Top right, with a button to act." onChange={(popup) => set({ popup })} />
        <SwitchRow on={nset.desktop} title="Desktop notification" help="Also when keel is in the background." onChange={(desktop) => set({ desktop })} />
        <div className="ss-inline" style={{ paddingBottom: 8, fontSize: 13 }}>
          <span className="ss-meta">Browser permission: <b style={{ color: "var(--fg)", fontWeight: 600 }}>{perm}</b></span>
          {perm !== "granted" && perm !== "unsupported" && (
            <button className="ss-btn sm" type="button" onClick={async () => {
              const p = await askPermission();
              setPerm(p);
              if (p === "granted") set({ desktop: true });
              else toast("The browser did not allow desktop notifications. Change it in the site settings.");
            }}>Allow</button>
          )}
        </div>
        <SwitchRow on={nset.quiet} title="Do not disturb" help="Keep them in the list, no sound or pop-up." onChange={(quiet) => set({ quiet })} />
        {mascot && (
          <SwitchRow on={showMascot} title="Show keel" help="The little hull by the bell jumps when something arrives and says what it is. Saved in this browser."
            onChange={setShowMascot} />
        )}
        <button className="ss-btn sm" type="button" style={{ marginTop: 8 }} onClick={() => notifyLocal({
          id: `test-${Date.now()}`, type: "review", project_id: project?.id ?? "", title: "Test notification",
          body: "This is how a gate that waits for you looks", link: "#/flow", at: new Date().toISOString(), read: false,
          summary: ["◆ This is how a gate that waits for you looks"],
        })}>Send a test notification</button>
      </div>
    </div>
  );
}

export function NotificationDrawer({ onClose }: { onClose: () => void }) {
  const { notes, unread, markAllRead, markRead, deleteNote, clearNotes, openNote, projects } = useApp();
  const [tab, setTab] = useState<"inbox" | "settings">("inbox");
  const [confirmClear, setConfirmClear] = useState(false);
  const pname = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  return (
    <Drawer title="Notifications" onClose={onClose} id="notedrawer">
      <Tabs value={tab} onChange={setTab} label="Notifications" options={[["inbox", `Inbox${unread ? ` (${unread})` : ""}`], ["settings", "Settings"]]} />
      {tab === "settings" ? <BellSettings mascot /> : notes.length ? (
        <>
          <ul className="note-list" aria-label="Notifications" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {notes.map((n) => (
              <li key={n.id} className="note-row">
                <button type="button" className={`note ${n.read ? "" : "unread"} ${n.done ? "done" : ""} t-${NTONE[n.type] ?? "run"}`}
                  onClick={() => { openNote(n); onClose(); }}>
                  <NoteHead note={n} />
                  <NoteLines note={n} />
                  <span className="note-meta hint">{where(n, pname(n.project_id))}{clock(n.at, false)}{n.done && <> · <span className="note-done">✓ decided</span></>}</span>
                </button>
                <span className="note-acts">
                  {!n.read && <button type="button" className="btn sm ghost" aria-label={`Mark read: ${n.title}`} title="Mark read" onClick={() => markRead(n.id)}>✓</button>}
                  <button type="button" className="btn sm ghost" aria-label={`Delete: ${n.title}`} title="Delete" onClick={() => deleteNote(n.id)}>×</button>
                </span>
              </li>
            ))}
          </ul>
          <div className="note-foot">
            {unread > 0 && <button className="btn sm ghost" type="button" onClick={markAllRead}>Mark all as read</button>}
            {confirmClear ? (
              <>
                <span className="sub">Delete all {notes.length}?</span>
                <button className="btn sm warn" type="button" onClick={() => { clearNotes(); setConfirmClear(false); }}>Yes, clear all</button>
                <button className="btn sm ghost" type="button" onClick={() => setConfirmClear(false)}>Keep them</button>
              </>
            ) : <button className="btn sm ghost" type="button" onClick={() => setConfirmClear(true)}>Clear all</button>}
          </div>
        </>
      ) : <div className="empty">Nothing yet.</div>}
    </Drawer>
  );
}

/** The title: one bold line with its mark (an ellipsis when it is too long; the whole title is its tooltip). */
function NoteHead({ note }: { note: Note }) {
  const v = noticeView(note);
  return (
    <b className="note-title" title={`${v.mark} ${v.title}`}>
      <span className="note-mark" aria-hidden="true">{v.mark}</span> <Ticks text={v.title} />
    </b>
  );
}

/** At most three short lines (the api's summary, or lines made from the body). The full text is in the Inbox. */
function NoteLines({ note }: { note: Note }) {
  const { lines } = noticeView(note);
  if (!lines.length) return null;
  return (
    // spans, not ul/li: a bell row is a button, and a button holds only phrasing content
    <span className="note-lines" role="list" data-testid="note-lines">
      {lines.map((l, i) => <span key={i} role="listitem"><Ticks text={l} /></span>)}
    </span>
  );
}

/** "shop · " before the time, unless the title already starts with the project ("◆ shop: approve the spec?"). */
function where(note: Note, project: string): string {
  return project && !noticeView(note).title.startsWith(project) ? `${project} · ` : "";
}

function PopupCard({ note, onClose }: { note: Note; onClose: () => void }) {
  const { openNote, projects } = useApp();
  const pname = projects.find((p) => p.id === note.project_id)?.name ?? note.project_id;
  return (
    <div className={`pop t-${NTONE[note.type] ?? "run"}`} role="status">
      <div className="pop-h">
        <NoteHead note={note} />
        <button type="button" className="btn sm ghost" aria-label="Dismiss" onClick={onClose}>×</button>
      </div>
      <NoteLines note={note} />
      <div className="pop-foot">
        <button className={`btn sm ${note.type === "review" ? "warn" : ""}`} type="button" onClick={() => { openNote(note); onClose(); }}>
          {note.type === "review" ? "Review now" : "Open"}
        </button>
        <span className="hint">{where(note, pname)}{clock(note.at, false)}</span>
      </div>
    </div>
  );
}

export function Popups() {
  const { popups, dismissPopup } = useApp();
  if (!popups.length) return null;
  return (
    <div className="popstack" aria-live="polite" data-testid="popups">
      {popups.map((p) => <PopupCard key={p.key} note={p.note} onClose={() => dismissPopup(p.key)} />)}
    </div>
  );
}
