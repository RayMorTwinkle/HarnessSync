import React, { useEffect, useRef, useState } from "react";
import { Monitor, Moon, Sun, SunMoon } from "lucide-react";

type Theme = "system" | "light" | "dark";
type TextSize = "normal" | "large" | "xlarge";

const themes: { id: Theme; label: string; icon: React.ReactNode }[] = [
  { id: "system", label: "跟随系统", icon: <Monitor size={14} /> },
  { id: "light", label: "浅色", icon: <Sun size={14} /> },
  { id: "dark", label: "深色", icon: <Moon size={14} /> },
];
const sizes: { id: TextSize; label: string }[] = [
  { id: "normal", label: "标准" },
  { id: "large", label: "较大" },
  { id: "xlarge", label: "特大" },
];

// Appearance is a per-browser preference, so it lives in localStorage rather
// than the synced source config. Storage can be unavailable (private windows),
// which must never break rendering.
function read<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function applyAppearance(theme: Theme, size: TextSize) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (size === "normal") delete root.dataset.textSize;
  else root.dataset.textSize = size;
}

// Run before the first render so a dark-mode user never sees a light flash.
applyAppearance(
  read<Theme>("hsync.theme", ["system", "light", "dark"], "system"),
  read<TextSize>("hsync.textSize", ["normal", "large", "xlarge"], "normal"),
);

export function AppearanceMenu() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(() =>
    read("hsync.theme", ["system", "light", "dark"], "system"),
  );
  const [size, setSize] = useState<TextSize>(() =>
    read("hsync.textSize", ["normal", "large", "xlarge"], "normal"),
  );
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    applyAppearance(theme, size);
    write("hsync.theme", theme);
    write("hsync.textSize", size);
  }, [theme, size]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !ref.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="appearance" ref={ref}>
      <button
        className="icon-button"
        title="外观"
        aria-label="外观"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <SunMoon size={16} />
      </button>
      {open && (
        <div className="appearance-menu" role="dialog" aria-label="外观">
          <span className="appearance-label">主题</span>
          <div className="appearance-options">
            {themes.map((t) => (
              <button
                key={t.id}
                className={theme === t.id ? "active" : ""}
                aria-pressed={theme === t.id}
                onClick={() => setTheme(t.id)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
          <span className="appearance-label">字号</span>
          <div className="appearance-options sizes">
            {sizes.map((s) => (
              <button
                key={s.id}
                className={size === s.id ? "active" : ""}
                aria-pressed={size === s.id}
                onClick={() => setSize(s.id)}
              >
                <span className={`size-sample ${s.id}`}>文</span>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
