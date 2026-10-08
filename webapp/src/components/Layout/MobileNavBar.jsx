import { Link, useLocation } from "react-router-dom";

const MOBILE_NAV_ITEMS = [
  { to: "/", label: "Home", icon: "⌂", exact: true },
  { to: "/explore", label: "Explore", icon: "◇" },
  { to: "/search", label: "Search", icon: "⌕" },
  { to: "/library/playlists", label: "Library", icon: "♫", match: "/library" },
  { to: "/liked", label: "Liked", icon: "♡" },
];

function isActive(item, pathname) {
  if (item.exact) return pathname === item.to;
  return pathname.startsWith(item.match || item.to);
}

/** Unified bottom tab bar used by every layout preset below 768px. */
function MobileNavBar() {
  const { pathname } = useLocation();
  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {MOBILE_NAV_ITEMS.map((item) => {
        const active = isActive(item, pathname);
        return (
          <Link
            key={item.to}
            to={item.to}
            className={`mobile-nav-item${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="mobile-nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="mobile-nav-label">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default MobileNavBar;
