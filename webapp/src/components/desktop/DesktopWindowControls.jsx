import {
  handleDesktopTitlebarDoubleClick,
  handleDesktopTitlebarMouseDown,
  isDesktopRuntime,
  performDesktopWindowAction,
} from "../../services/desktop/desktopRuntime";

function DesktopWindowControls({ floating = false }) {
  if (!isDesktopRuntime()) return null;

  const controls = (
    <div
      className={`desktop-window-controls${floating ? " desktop-window-controls--floating" : ""}`}
      data-no-drag="true"
      role="group"
      aria-label="Window controls"
    >
      <button
        type="button"
        className="desktop-window-btn"
        aria-label="Minimize window"
        title="Minimize"
        onClick={() => void performDesktopWindowAction("minimize")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        className="desktop-window-btn"
        aria-label="Maximize window"
        title="Maximize"
        onClick={() => void performDesktopWindowAction("toggle-maximize")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect
            x="2.25"
            y="2.25"
            width="7.5"
            height="7.5"
            rx="1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
          />
        </svg>
      </button>
      <button
        type="button"
        className="desktop-window-btn desktop-window-btn--close"
        aria-label="Close window"
        title="Close"
        onClick={() => void performDesktopWindowAction("close")}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M2.5 2.5l7 7M9.5 2.5l-7 7"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );

  if (!floating) {
    return controls;
  }

  return (
    <div
      className="desktop-floating-titlebar"
      onMouseDownCapture={handleDesktopTitlebarMouseDown}
      onDoubleClickCapture={handleDesktopTitlebarDoubleClick}
    >
      {controls}
    </div>
  );
}

export default DesktopWindowControls;
