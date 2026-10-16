// A plugin's mode on screen (core/modes.ts has its state, keys and lines): the lines it gives, a click on a row of its
// body opens that item (the list) or moves to that line (a file). The app gives it the keys.
import React from "react";
import { Box, Text } from "ink";
import type { ModeSession } from "../core/modes";
import { Clickable } from "./click";

/** Ink's key as a mode's key name ("up", "enter", …), or the text typed. */
export function keyName(input: string, key: { upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; return?: boolean;
  escape?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean; pageUp?: boolean; pageDown?: boolean; ctrl?: boolean; meta?: boolean }): string | null {
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.pageUp) return "pgup";
  if (key.pageDown) return "pgdn";
  if (key.return) return "enter";
  if (key.escape) return "esc";
  if (key.tab) return "tab";
  if (key.backspace || key.delete) return "backspace";
  if (key.ctrl || key.meta || !input) return null;
  return input;
}

export function ModeView({ session, width, height }: { session: ModeSession; width: number; height: number }) {
  const lines = session.lines(width, Math.max(6, height));
  const body = lines.length - 4;
  return (
    <Box flexDirection="column" width={width}>
      {lines.map((l, i) => {
        const text = <Text wrap="truncate-end">{l || " "}</Text>;
        return i >= 1 && i <= body ? <Clickable key={i} act={() => void session.click(i - 1)}>{text}</Clickable> : <Box key={i}>{text}</Box>;
      })}
    </Box>
  );
}
