import { Link, useLocation } from "react-router-dom";

const MOBILE_NAV_ITEMS = [
  { to: "/", label: "Home", paths: ["/"], icon: "m3 10 9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { to: "/explore", label: "Discover", paths: ["/explore", "/new-releases", "/saved-discoveries"], icon: "M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20Zm4 6-2 6-6 2 2-6z" },
  { to: "/search", label: "Search", paths: ["/search"], icon: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13Zm5 11.5 4.5 4.5" },
  { to: "/library/playlists", label: "Library", paths: ["/library", "/liked", "/downloads", "/playlist", "/smart-playlist"], icon: "M4 5v14m5-14v14m5-14 5 14" },
];

function MobileNavBar() {
  const { pathname, search } = useLocation();

  return (
    <nav className="mobile-nav" aria-label="Mobile navigation">
      {MOBILE_NAV_ITEMS.map(({ to, label, paths, icon }) => {
        const active = paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
        const isSearch = to === "/search";
        return (
          <Link
            key={to}
            to={isSearch && active ? `${pathname}${search}` : to}
            className={`mobile-nav-item${active ? " active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="mobile-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d={icon} /></svg>
            </span>
            <span className="mobile-nav-label">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default MobileNavBar;
