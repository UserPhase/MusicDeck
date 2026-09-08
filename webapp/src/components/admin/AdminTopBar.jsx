import { useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../../context/AuthContext";


function AdminTopBar() {
  const { session, signOut } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <header className="admin-topbar">
      <Link to="/admin" className="admin-topbar-brand">
        MusicDeck <span>Admin</span>
      </Link>

      <div className="admin-topbar-profile">
        <button
          type="button"
          className="admin-profile-button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="admin-avatar">
            {(session?.displayName || session?.username || "A")
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <span>Profile</span>
          <span aria-hidden="true">▾</span>
        </button>

        {open && (
          <div className="admin-profile-menu" role="menu">
            <Link to="/profile" role="menuitem" onClick={() => setOpen(false)}>
              Profile
            </Link>
            <Link to="/settings" role="menuitem" onClick={() => setOpen(false)}>
              Account settings
            </Link>
            <button type="button" role="menuitem" onClick={signOut}>
              Log out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}


export default AdminTopBar;
