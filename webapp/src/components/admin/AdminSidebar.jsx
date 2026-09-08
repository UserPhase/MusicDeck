import { Link, NavLink, useLocation } from "react-router-dom";


const ADMIN_NAV_ITEMS = [
  { to: "/admin", label: "Dashboard", icon: "▦", end: true },
  { to: "/admin/users", label: "Users", icon: "◉" },
  { to: "/admin/library", label: "Library", icon: "♫" },
  { to: "/admin/sources", label: "Sources & Providers", icon: "⇄" },
  { to: "/admin/plugins", label: "Plugins", icon: "🧩" },
  { to: "/admin/appearance", label: "Appearance", icon: "🎨" },
  { to: "/admin/server", label: "Server", icon: "🖥" },
];


/*
 * Administration-only navigation shell.
 *
 * This replaces the normal MusicDeck library sidebar while inside /admin so
 * the administrator keeps the global player but never sees music navigation.
 */
function AdminSidebar() {
  const location = useLocation();

  return (
    <aside className="sidebar admin-sidebar" aria-label="Admin navigation">
      <div className="nav-section">
        <div className="nav-title">Administration</div>

        {ADMIN_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `nav-item admin-nav-item${isActive ? " active" : ""}`
            }
          >
            <span className="nav-icon">{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>

      <div className="admin-sidebar-footer">
        <Link
          to="/"
          className={`nav-item admin-nav-item admin-back-link${
            location.pathname === "/" ? " active" : ""
          }`}
        >
          <span className="nav-icon">←</span>
          <span>Back to MusicDeck</span>
        </Link>
      </div>
    </aside>
  );
}


export default AdminSidebar;
