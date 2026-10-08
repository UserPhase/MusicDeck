import Player from "../../Player";
import { usePlayer } from "../../../context/PlayerContext";

/**
 * YouTube Music-style floating player bar. Expanding it opens the Now
 * Playing panel, which this shell presents as a bottom sheet over the page.
 */
function DrawerPlayerBar() {
  const { activeSidebar, setActiveSidebar } = usePlayer();
  const isExpanded = activeSidebar === "now-playing";

  return (
    <Player
      variant="drawer"
      isQueueSidebarOpen={activeSidebar === "queue"}
      onToggleQueueSidebar={() => setActiveSidebar((current) => current === "queue" ? "none" : "queue")}
      actions={(
        <button
          type="button"
          className={`player-expand-button${isExpanded ? " active" : ""}`}
          onClick={() => setActiveSidebar(isExpanded ? "none" : "now-playing")}
          aria-label={isExpanded ? "Collapse player" : "Expand player"}
          aria-expanded={isExpanded}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 15 6-6 6 6" />
          </svg>
        </button>
      )}
    />
  );
}

export default DrawerPlayerBar;
