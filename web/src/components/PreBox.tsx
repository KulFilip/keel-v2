// keel 0.18.56 a long monospace text (a prompt, a system prompt, an agent's output) in a box: its lines wrap, long paths
// and URLs too, so it never makes the panel around it wider; a tall text scrolls down inside the box; Copy copies it all.

import { useState } from "react";
import { copyText } from "../clipboard";

export function PreBox({
  text,
  label,
  testId,
  className,
}: {
  text: string;
  /** what the text is, for the box and its Copy button (e.g. "The prompt keel sends") */
  label: string;
  testId?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState("");
  const copy = () =>
    void copyText(text).then((ok) =>
      setCopied(ok ? "Copied." : "The browser did not allow copying."),
    );
  return (
    <div className={className ? `prebox ${className}` : "prebox"}>
      <div className="prebox-bar">
        {copied && (
          <span className="hint" role="status">
            {copied}
          </span>
        )}
        <button
          type="button"
          className="btn sm ghost"
          onClick={copy}
          aria-label={`Copy ${label.charAt(0).toLowerCase()}${label.slice(1)}`}
        >
          Copy
        </button>
      </div>
      <pre
        className="head prebox-pre"
        role="group"
        aria-label={label}
        data-testid={testId}
        tabIndex={0}
      >
        {text}
      </pre>
    </div>
  );
}
