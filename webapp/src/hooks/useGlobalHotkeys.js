import { useEffect, useRef } from "react";

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;

  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function useGlobalHotkeys({
  enabled = true,
  onTogglePlay,
  onToggleMute,
  onNext,
  onPrevious,
  onToggleLike,
  onOpenPalette,
}) {
  const actionsRef = useRef({
    onTogglePlay,
    onToggleMute,
    onNext,
    onPrevious,
    onToggleLike,
    onOpenPalette,
  });

  useEffect(() => {
    actionsRef.current = {
      onTogglePlay,
      onToggleMute,
      onNext,
      onPrevious,
      onToggleLike,
      onOpenPalette,
    };
  }, [onNext, onOpenPalette, onPrevious, onToggleLike, onToggleMute, onTogglePlay]);

  useEffect(() => {
    if (!enabled) return undefined;

    function handleKeyDown(event) {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;

      const actions = actionsRef.current;
      const hasModifier = event.altKey || event.metaKey;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        actions.onOpenPalette?.();
        return;
      }

      if (event.code === "Space") {
        event.preventDefault();
        actions.onTogglePlay?.();
        return;
      }

      if (event.code === "KeyM") {
        event.preventDefault();
        actions.onToggleMute?.();
        return;
      }

      if (event.code === "KeyL") {
        event.preventDefault();
        actions.onToggleLike?.();
        return;
      }

      if (hasModifier && event.key === "ArrowRight") {
        event.preventDefault();
        actions.onNext?.();
      }

      if (hasModifier && event.key === "ArrowLeft") {
        event.preventDefault();
        actions.onPrevious?.();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled]);
}

export default useGlobalHotkeys;
