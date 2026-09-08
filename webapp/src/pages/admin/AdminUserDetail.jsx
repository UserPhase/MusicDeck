import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  deleteUser,
  getUsers,
  updateUser,
} from "../../api/musicdeck";
import { useAuth } from "../../context/AuthContext";


function AdminUserDetail() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { session } = useAuth();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const users = await getUsers();
        if (!cancelled) {
          setUser(users.find((item) => item.id === userId) || null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load user.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function save(updates, successMessage = "User updated.") {
    try {
      setSaving(true);
      setError(null);
      setMessage("");
      const updated = await updateUser(userId, updates);
      setUser(updated);
      setMessage(successMessage);
    } catch (err) {
      setError(err.message || "Could not update user.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (session?.id === userId) {
      setError("You cannot delete your own administrator account here.");
      return;
    }
    if (!window.confirm(`Delete ${user?.username}? This cannot be undone.`)) {
      return;
    }
    try {
      setSaving(true);
      await deleteUser(userId);
      navigate("/admin/users", { replace: true });
    } catch (err) {
      setError(err.message || "Could not delete user.");
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="loading">Loading user...</div>;
  }

  if (!user) {
    return (
      <div className="admin-page">
        <div className="library-empty">
          User not found. <Link to="/admin/users">Back to users</Link>
        </div>
      </div>
    );
  }

  const active = !user.disabled;

  return (
    <div className="admin-page">
      <div className="admin-detail-header">
        <div className="admin-detail-identity">
          <Link to="/admin/users" className="admin-back-link">← Users</Link>
          <div className="admin-user-avatar">{(user.displayName || user.username).slice(0, 2).toUpperCase()}</div>
          <div>
            <h1>{user.displayName || user.username}</h1>
            <p>{user.role === "admin" ? "Administrator" : "User"}</p>
            <span className={`admin-badge ${active ? "is-active" : "is-disabled"}`}>
              {active ? "● Active" : "● Disabled"}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="account-action"
          onClick={() => save({ displayName: window.prompt("Display name", user.displayName || "") || user.displayName })}
          disabled={saving}
        >
          Edit user
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}

      <section className="admin-section admin-detail-section">
        <h2>Account</h2>
        <div className="admin-detail-fields">
          <div><span>Username</span><strong>{user.username}</strong></div>
          <div><span>Display name</span><strong>{user.displayName || "Not set"}</strong></div>
          <div><span>Role</span><strong>{user.role === "admin" ? "Administrator" : "User"}</strong></div>
          <div><span>Status</span><strong>{active ? "Active" : "Disabled"}</strong></div>
        </div>
      </section>

      <section className="admin-section admin-detail-section">
        <h2>Permissions</h2>
        <div className="admin-permission-matrix" role="table" aria-label="User permissions">
          {[
            ["Playback", true],
            ["Library", true],
            ["Downloads", Boolean(user.externalPlaybackEnabled)],
            ["Administration", user.role === "admin"],
            ["Plugin Management", user.role === "admin"],
          ].map(([label, enabled]) => (
            <div className="admin-permission-row" role="row" key={label}>
              <span>{label}</span>
              <span className={`admin-badge ${enabled ? "is-active" : "is-disabled"}`}>
                {enabled ? "✓ Enabled" : "✕ Disabled"}
              </span>
            </div>
          ))}
        </div>
        <div className="admin-detail-controls">
          <label className="account-checkbox">
            <input
              type="checkbox"
              checked={Boolean(user.externalSearchEnabled)}
              onChange={(event) => save({ externalSearchEnabled: event.target.checked })}
              disabled={saving}
            />
            <span>External search</span>
          </label>
          <label className="account-checkbox">
            <input
              type="checkbox"
              checked={Boolean(user.externalPlaybackEnabled)}
              onChange={(event) => save({ externalPlaybackEnabled: event.target.checked })}
              disabled={saving}
            />
            <span>External playback</span>
          </label>
        </div>
      </section>

      <section className="admin-section admin-detail-section">
        <h2>Preferences</h2>
        <div className="admin-detail-fields">
          <div><span>Theme</span><strong>MusicDeck Dark</strong></div>
          <div><span>Playback settings</span><strong>Managed by MusicDeck player</strong></div>
          <div><span>Download preferences</span><strong>Managed by server</strong></div>
        </div>
      </section>

      <section className="admin-section admin-detail-section">
        <h2>Connected servers</h2>
        <div className="admin-link-grid">
          <div className="admin-link-card"><strong>Navidrome</strong><span>Primary music library backend</span></div>
          <div className="admin-link-card"><strong>Jellyfin</strong><span>Not configured</span></div>
        </div>
      </section>

      <section className="admin-section admin-detail-section">
        <h2>Activity</h2>
        <div className="admin-detail-fields">
          <div><span>Last login</span><strong>Not available</strong></div>
          <div><span>Last playback</span><strong>Not available</strong></div>
          <div><span>Recent actions</span><strong>No recent actions</strong></div>
        </div>
      </section>

      <section className="admin-section admin-detail-section admin-danger-zone">
        <h2>Danger zone</h2>
        <div className="admin-actions">
          <button type="button" className="account-action" disabled={saving} onClick={() => save({ disabled: active }, active ? "User disabled." : "User enabled.")}>
            {active ? "Disable user" : "Enable user"}
          </button>
          <button type="button" className="admin-danger" disabled={saving} onClick={handleDelete}>
            Delete user
          </button>
        </div>
      </section>
    </div>
  );
}


export default AdminUserDetail;
