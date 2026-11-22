import { useLayoutEffect } from "react";

export function getVisualViewportBounds() {
  const viewport = window.visualViewport;
  return {
    left: viewport?.offsetLeft ?? 0,
    top: viewport?.offsetTop ?? 0,
    width: viewport?.width ?? window.innerWidth,
    height: viewport?.height ?? window.innerHeight,
  };
}

export function observeVisualViewport(update) {
  const viewport = window.visualViewport;
  update();
  window.addEventListener("resize", update);
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  return () => {
    window.removeEventListener("resize", update);
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
  };
}

export function useVisualViewportBounds(ref, enabled = true) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    return observeVisualViewport(() => {
      for (const [key, value] of Object.entries(getVisualViewportBounds())) {
        element.style.setProperty(`--visible-viewport-${key}`, `${value}px`);
      }
    });
  }, [enabled, ref]);
}
