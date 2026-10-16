// keel 0.18.9 "Ask KeelBot to fix it": when a button KeelBot gave fails (a git switch, a flow's stop, a query …), the
// card offers to hand the error to KeelBot, which finds the cause in the project and proposes a fix as buttons the person
// presses. KeelBot's chat provides the way to ask (AskKeelBot); a card outside a chat shows no such button.
import { createContext, useContext } from "react";

export const AskKeelBot = createContext<((text: string) => void) | null>(null);

/** What KeelBot gets: what was tried, keel's error and hint, and what to do with them. */
export function fixRequest(what: string, error: { message: string; hint?: string }): string {
  return `This failed: ${what}.\nkeel said: ${error.message}${error.hint ? `\nkeel's hint: ${error.hint}` : ""}\n`
    + "Find the cause in this project (look at its state: git status, the files, the flow), explain it in one or two plain "
    + "sentences, and propose how to fix it, with the buttons that do it. Change nothing yourself.";
}

export function AskFixButton({ what, error }: { what: string; error: { message: string; hint?: string } | null }) {
  const ask = useContext(AskKeelBot);
  if (!ask || !error) return null;
  return (
    <button type="button" className="btn sm" onClick={() => ask(fixRequest(what, error))}
      title="KeelBot reads the error and the project, says why it failed and proposes a fix you press">
      Ask KeelBot to fix it
    </button>
  );
}
