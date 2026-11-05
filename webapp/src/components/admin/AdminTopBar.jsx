import { useRef, useState } from "react";
import FloatingPanel from "../ui/FloatingPanel";
import { Link } from "react-router-dom";

import { useAuth } from "../../context/AuthContext";
import { useBranding } from "../../context/BrandingContext";
import DesktopWindowControls from "../desktop/DesktopWindowControls";
import {
  handleDesktopTitlebarDoubleClick,
  handleDesktopTitlebarMouseDown,
  isDesktopRuntime,
} from "../../services/desktop/desktopRuntime";
import UserAvatar from "../UserAvatar";


function AdminTopBar() {
  const { session, signOut } = useAuth();
  const { appName } = useBranding();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  return (
    <header
      className="admin-topbar"
      data-tauri-drag-region={isDesktopRuntime() ? "" : undefined}
      onMouseDown={handleDesktopTitlebarMouseDown}
      onDoubleClick={handleDesktopTitlebarDoubleClick}
    >
      <Link to="/admin" className="admin-topbar-brand">
        {appName} <span>Admin</span>
      </Link>

      <div className="admin-topbar-profile" style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <button
          type="button"
          className="admin-profile-button"
          ref={triggerRef}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <UserAvatar user={session} className="admin-avatar" fallback="A" />
          <span>Profile</span>
          <span aria-hidden="true">▾</span>
        </button>

        {open && (
          <FloatingPanel anchorRef={triggerRef} onClose={() => setOpen(false)} className="admin-profile-menu" role="menu">
            <Link to="/profile" role="menuitem" onClick={() => setOpen(false)}>
              Profile
            </Link>
            <Link to="/settings" role="menuitem" onClick={() => setOpen(false)}>
              Account settings
            </Link>
            <button type="button" role="menuitem" onClick={signOut}>
              Log out
            </button>
          </FloatingPanel>
        )}
        <DesktopWindowControls />
      </div>
    </header>
  );
}


export default AdminTopBar;
