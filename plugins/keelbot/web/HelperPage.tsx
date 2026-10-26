// KeelBot on a page of its own (#/helper): the same chats, modes and models as the panel in the Code page, in one
// wide chat column. A file:line link opens the Code page at that line (0.18.57: as the branch or ref the answer was made
// from has it, `?ref=`); "Back to the code" goes to the Code page.

import { useLayoutEffect, useRef } from "react";
import { codeHref, go } from "@keel/web-sdk";
import { HelperPanel } from "./HelperPanel";

export function HelperPage({ pid }: { pid: string }) {
  const root = useRef<HTMLDivElement>(null);
  // the page fills the window below the app's head, like the Code page's IDE
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const set = () => el.style.setProperty("--hp-top", `${Math.max(0, el.getBoundingClientRect().top + window.scrollY)}px`);
    set();
    window.addEventListener("resize", set);
    return () => window.removeEventListener("resize", set);
  }, []);
  return (
    <div ref={root} className="helper-page">
      <HelperPanel pid={pid} layout="page"
        onOpenFile={(path, line, ref) => {
          if (ref) location.hash = codeHref(path, line, ref);
          else go("repo", line ? `${path}:${line}` : path);
        }}
        onOpenDiff={(path) => go("repo", path)}
        onClose={() => go("repo")} />
    </div>
  );
}
