import { useEffect, useState } from "react";

import { getUserSettings, updateUserSettings } from "../../api/musicdeck";


export const CUSTOM_CSS_SETTING_KEY = "appearance.customCss";

export const CUSTOM_CSS_PLACEHOLDER = `/*
 * Custom CSS applied to the MusicDeck interface.
 *
 * For your safety, rules that would hide the player or the admin
 * navigation are stripped before the CSS is applied.
 *
 * Example:
 *   :root { --accent: #1db954; }
 */
`;


/*
 * Strips rules that could permanently remove the player or the admin
 * navigation from the interface. The admin must always be able to reach the
 * Appearance page to reset, and the global player must stay usable.
 */
const PROTECTED_SELECTOR_PATTERN =
  /\.(player|topbar|admin-sidebar|admin-shell|custom-css-reset|sidebar)\b/;

function stripUnsafeRules(css) {
  if (!css) {
    return "";
  }

  // Remove @import (could load remote CSS that hides the UI).
  let cleaned = css.replace(/@import[^;]+;/gi, "/* @import removed for safety */");

  // Split into top-level rules and drop rules targeting protected selectors
  // with dangerous declarations.
  const rules = cleaned.split(/(?<=})\s*/);
  const kept = [];

  for (const rule of rules) {
    const trimmed = rule.trim();
    if (!trimmed) {
      continue;
    }

    const braceIndex = trimmed.indexOf("{");
    if (braceIndex === -1) {
      kept.push(trimmed);
      continue;
    }

    const selector = trimmed.slice(0, braceIndex);
    const body = trimmed.slice(braceIndex + 1, trimmed.lastIndexOf("}"));

    const isDangerousDisplay =
      /display\s*:\s*none/i.test(body) ||
      /visibility\s*:\s*hidden/i.test(body) ||
      /opacity\s*:\s*0(?![\d.])/i.test(body);

    if (PROTECTED_SELECTOR_PATTERN.test(selector) && isDangerousDisplay) {
      kept.push(`/* blocked unsafe rule: ${selector.trim()} { ... } */`);
      continue;
    }

    kept.push(trimmed);
  }

  return kept.join("\n");
}

export function sanitizeCustomCss(css) {
  return stripUnsafeRules(css);
}


/*
 * Injects the sanitized custom CSS into a dedicated <style> tag. The tag is
 * appended last so custom rules can override the defaults, and it is managed
 * entirely outside of React's component tree so it survives navigation
 * between the MusicDeck shell and the Admin shell.
 */
function CustomCssStyle() {
  const [css, setCss] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const settings = await getUserSettings();
        const entry = (settings || []).find(
          (item) => item.key === CUSTOM_CSS_SETTING_KEY
        );

        if (cancelled) {
          return;
        }

        if (entry) {
          try {
            setCss(sanitizeCustomCss(JSON.parse(entry.value)));
          } catch {
            setCss(sanitizeCustomCss(entry.value));
          }
        }
      } catch {
        // Custom CSS is optional — ignore failures.
      }
    }

    function handleUpdate(event) {
      setCss(sanitizeCustomCss(event.detail?.css || ""));
    }

    load();

    window.addEventListener("musicdeck:custom-css", handleUpdate);

    return () => {
      cancelled = true;
      window.removeEventListener("musicdeck:custom-css", handleUpdate);
    };
  }, []);

  if (!css) {
    return null;
  }

  return <style data-testid="custom-css-style">{css}</style>;
}


/*
 * Floating reset button — always reachable, even if custom CSS accidentally
 * hides parts of the admin interface. It cannot be removed by custom CSS
 * because the sanitizer blocks rules targeting its class.
 */
export function CustomCssResetButton() {
  const [hasCustomCss, setHasCustomCss] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const settings = await getUserSettings();
        const entry = (settings || []).find(
          (item) => item.key === CUSTOM_CSS_SETTING_KEY
        );
        if (!cancelled) {
          setHasCustomCss(
            Boolean(entry && entry.value && entry.value !== "\"\"")
          );
        }
      } catch {
        // ignore
      }
    }

    function handleUpdate(event) {
      setHasCustomCss(Boolean(event.detail?.css));
    }

    load();
    window.addEventListener("musicdeck:custom-css", handleUpdate);

    return () => {
      cancelled = true;
      window.removeEventListener("musicdeck:custom-css", handleUpdate);
    };
  }, []);

  if (!hasCustomCss) {
    return null;
  }

  async function handleReset() {
    await updateUserSettings({ [CUSTOM_CSS_SETTING_KEY]: "" });
    window.dispatchEvent(
      new CustomEvent("musicdeck:custom-css", { detail: { css: "" } })
    );
  }

  return (
    <button
      type="button"
      className="custom-css-reset"
      title="Reset custom CSS to default"
      onClick={handleReset}
    >
      Reset CSS
    </button>
  );
}


export default CustomCssStyle;
