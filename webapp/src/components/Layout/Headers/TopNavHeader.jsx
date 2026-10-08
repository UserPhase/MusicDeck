import Topbar from "../../Topbar";

export const NAV_DRAWER_ID = "app-navigation";

/**
 * Full-width top navigation header shared by the YouTube Music and
 * SoundCloud shells. Pass `drawer` to add the hamburger that toggles the
 * library sidebar as an off-canvas drawer.
 */
function TopNavHeader({ drawer = null }) {
  const leading = drawer ? (
    <button
      type="button"
      className={`topbar-drawer-toggle${drawer.isOpen ? " active" : ""}`}
      onClick={drawer.onToggle}
      aria-label={drawer.isOpen ? "Close menu" : "Open menu"}
      aria-expanded={drawer.isOpen}
      aria-controls={NAV_DRAWER_ID}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    </button>
  ) : null;

  return <Topbar leading={leading} showPrimaryNav />;
}

export default TopNavHeader;
