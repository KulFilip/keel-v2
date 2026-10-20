// ink-testing-library's render on a terminal of any width: its own stdout is always 100 columns, and Ink lays its frame
// out on the terminal's width, so a screen wider than that (keel TUI's sidebar shows from 120 columns) needs a wider one.
import { EventEmitter } from "node:events";
import type { ReactElement } from "react";
import { render as inkRender } from "ink";

class Stdout extends EventEmitter {
  constructor(readonly columns: number) {
    super();
  }
  frames: string[] = [];
  private last: string | undefined;
  write = (frame: string) => {
    this.frames.push(frame);
    this.last = frame;
  };
  lastFrame = () => this.last;
}

class Stdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
  read = () => {
    const d = this.data;
    this.data = null;
    return d;
  };
}

/** As ink-testing-library's render, on a terminal `columns` wide. */
export function renderAt(tree: ReactElement, columns: number) {
  const stdout = new Stdout(columns);
  const stderr = new Stdout(columns);
  const stdin = new Stdin();
  const instance = inkRender(tree, { stdout: stdout as never, stderr: stderr as never, stdin: stdin as never, debug: true, exitOnCtrlC: false,
    patchConsole: false });
  return { rerender: instance.rerender, unmount: instance.unmount, stdout, stdin, lastFrame: stdout.lastFrame };
}
