// keel's colours for the Ink parts: the theme (palette, paint, colour level, ASCII or not) as a React context.
import React, { createContext, useContext } from "react";
import { inkColor, makeTheme, userTint, type Theme } from "../core/theme";

const Ctx = createContext<Theme>(makeTheme());

export const ThemeProvider = ({ theme, children }: { theme: Theme; children: React.ReactNode }) => <Ctx.Provider value={theme}>{children}</Ctx.Provider>;

/** The theme; `color(role)` is the hex for Ink's color props, or undefined without colour (NO_COLOR). */
export function useTheme() {
  const t = useContext(Ctx);
  const color = (role: keyof Theme["palette"]) => (t.level ? inkColor(t.palette[role]) : undefined);
  /** the background of the person's own messages (none without colour, or with the terminal's own palette) */
  const tint = t.level >= 2 ? userTint(t.palette) : undefined;
  return { ...t, color, tint };
}
