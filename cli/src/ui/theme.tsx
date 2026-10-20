// keel's colours for the Ink parts: the theme (palette, paint, colour level, ASCII or not) as a React context, and a
// way to change the palette while keel TUI runs (/theme).
import React, { createContext, useContext } from "react";
import { BOLD, inkColor, makeTheme, UNDERLINE, type Role, type Theme, type ThemeName } from "../core/theme";

type Ctx = { theme: Theme; setPalette: (name: ThemeName) => void };
const Ctx = createContext<Ctx>({ theme: makeTheme(), setPalette: () => undefined });

export const ThemeProvider = ({ theme, setPalette, children }: { theme: Theme; setPalette?: (name: ThemeName) => void; children: React.ReactNode }) =>
  <Ctx.Provider value={{ theme, setPalette: setPalette ?? (() => undefined) }}>{children}</Ctx.Provider>;

/** Ink's props for a role: its colour, dimmed for the quiet "dim:" look; `strong` adds the role's bold or underline. */
export type RoleProps = { color?: string; dimColor?: boolean; bold?: boolean; underline?: boolean; italic?: boolean };

/** The theme; `color(role)` is the colour for Ink's color props, or undefined without colour (NO_COLOR); `look(role)`
 *  is all of a role's props (colour, dim, and with `strong` its bold or underline). */
export function useTheme() {
  const { theme: t, setPalette } = useContext(Ctx);
  const color = (role: Role) => (t.level ? inkColor(t.palette[role]) : undefined);
  const look = (role: Role, strong = false, bold = false): RoleProps => {
    const p: RoleProps = {};
    if (t.level) {
      const c = inkColor(t.palette[role]);
      if (c) p.color = c;
      if (t.palette[role] === "dim:") p.dimColor = true;
    }
    // the role's own flags (KEEL_TUI_COLORS +bold ...) reach every place that draws the role; +nobold drops its default bold
    const st = t.styles[role];
    if ((bold || (strong && BOLD.has(role)) || (t.level && st?.bold)) && st?.bold !== false) p.bold = true;
    if (strong && UNDERLINE.has(role) && t.level) p.underline = true;
    if (t.level && st) {
      if (st.underline) p.underline = true;
      if (st.italic) p.italic = true;
      if (st.dim) p.dimColor = true;
    }
    return p;
  };
  return { ...t, color, look, setPalette };
}
