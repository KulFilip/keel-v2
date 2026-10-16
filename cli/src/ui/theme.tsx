// keel's colours for the Ink parts: the theme (palette, paint, colour level, ASCII or not) as a React context.
import React, { createContext, useContext } from "react";
import { makeTheme, type Theme } from "../core/theme";

const Ctx = createContext<Theme>(makeTheme());

export const ThemeProvider = ({ theme, children }: { theme: Theme; children: React.ReactNode }) => <Ctx.Provider value={theme}>{children}</Ctx.Provider>;

/** The theme; `color(role)` is the hex for Ink's color props, or undefined without colour (NO_COLOR). */
export function useTheme() {
  const t = useContext(Ctx);
  const color = (role: keyof Theme["palette"]) => (t.level ? t.palette[role] : undefined);
  return { ...t, color };
}
