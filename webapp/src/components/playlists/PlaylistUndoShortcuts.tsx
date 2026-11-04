import { useEffect } from "react";
import { usePlaylistUndo } from "../../hooks/usePlaylistUndo";

export default function PlaylistUndoShortcuts() {
  const { busy, canUndo, canRedo, undo, redo } = usePlaylistUndo();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || busy ||
        (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"],[role="dialog"]'))) return;
      const backwards = event.key.toLowerCase() === "z" && !event.shiftKey;
      const forwards = event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey);
      if ((backwards && canUndo) || (forwards && canRedo)) {
        event.preventDefault(); void (backwards ? undo() : redo()).catch(() => undefined);
      }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [busy, canUndo, canRedo, undo, redo]);
  return null;
}
