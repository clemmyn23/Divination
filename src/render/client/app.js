// Runs in the page. Inlined into <head> by src/render/page.ts; never loaded from a URL.
// It runs before the body exists, so anything that needs a button waits for the page.

(() => {
  const THEMES = ["auto", "light", "dark"];
  const LABELS = { auto: "◐ Auto", light: "☀ Light", dark: "☾ Dark" };
  const THEME_KEY = "divination-theme";
  const root = document.documentElement;

  function savedTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      return THEMES.includes(saved) ? saved : "auto";
    } catch {
      return "auto";
    }
  }

  // "auto" leaves the choice to the system; "light" and "dark" force it.
  function applyTheme(theme) {
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    const toggle = document.getElementById("theme-toggle");
    if (toggle) toggle.textContent = LABELS[theme];
  }

  let theme = savedTheme();
  applyTheme(theme); // sets the theme before anything is drawn
  document.addEventListener("DOMContentLoaded", () => applyTheme(theme)); // labels the button once it exists

  document.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.closest("#theme-toggle")) {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        // Storage can be blocked; the choice then lasts until the page reloads.
      }
      applyTheme(theme);
      return;
    }

    const copy = target.closest("button[data-copy]");
    if (copy) {
      const label = copy.textContent;
      try {
        await navigator.clipboard.writeText(copy.dataset.copy ?? "");
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Copy failed";
      }
      setTimeout(() => {
        copy.textContent = label;
      }, 1500);
    }
  });
})();
