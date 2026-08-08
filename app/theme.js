"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Theme is stamped on <html data-theme> so CSS owns every colour decision and no
 * component needs to know which mode is active.
 *
 * Three states, not two: "system" follows the OS and is the default, so a user who
 * never touches the toggle gets dark at night without being asked.
 */
const KEY = "tickloop-theme";
const MODES = ["system", "light", "dark"];

function apply(mode) {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function useTheme() {
  const [mode, setMode] = useState("system");

  // Read the stored choice after mount: localStorage does not exist on the server,
  // and reading it during render would desync hydration.
  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
    const next = MODES.includes(stored) ? stored : "system";
    setMode(next);
    apply(next);
  }, []);

  const change = useCallback((next) => {
    setMode(next);
    apply(next);
    try { window.localStorage.setItem(KEY, next); } catch { /* private mode */ }
  }, []);

  /** Cycles system → light → dark → system, for a single-button toggle. */
  const cycle = useCallback(() => {
    change(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  }, [mode, change]);

  return { mode, setMode: change, cycle };
}

export const THEME_LABEL = { system: "System", light: "Light", dark: "Dark" };
