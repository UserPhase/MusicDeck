import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import {
  deleteUser,
  getAdminUserSettings,
  getUsers,
  updateAdminUserSettings,
  updateUser,
  USER_SETTINGS_CHANGED_EVENT,
} from "../../api/musicdeck";
import UserAvatar from "../../components/UserAvatar";
import { useAuth } from "../../context/AuthContext";
import { THEME_OPTIONS, THEME_SETTING_KEY } from "../../utils/theme";

const PREFERENCE_FIELDS = [
  {
    key: THEME_SETTING_KEY,
    label: "Theme",
    fallback: "dark",
    options: THEME_OPTIONS.map((option) => [option.value, option.label]),
  },
  {
    key: "playback.streamQuality",
    label: "Playback quality",
    fallback: "original",
    options: [
      ["original", "Original file"],
      ["320", "High (320 kbps)"],
      ["128", "Data saver (128 kbps)"],
    ],
  },
  {
    key: "playback.downloadQuality",
    label: "Download quality",
    fallback: "320kbps",
    options: [
      ["lossless", "Lossless"],
      ["320kbps", "320 kbps"],
      ["256kbps", "256 kbps"],
      ["192kbps", "192 kbps"],
      ["128kbps", "128 kbps"],
    ],
  },
];

const RELATIVE_UNITS = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

export function formatRelativeTime(value, now = Date.now()) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(timestamp)) return null;

  const seconds = Math.round((timestamp - now) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return "Just now";
}

function settingsToMap(settings) {
  const map = {};
  for (const setting of settings || []) {
    try {
      map[setting.key] = JSON.parse(setting.value);
    } catch {
      map[setting.key] = setting.value;
    }
  }
  return map;
}

function PermissionSwitch({ id, label, description, checked, disabled, onChange }) {
  return (
    <div className={`admin-permission-row${disabled ? " is-locked" : ""}`}>
      <div className="admin-permission-copy">
        <span id={`${id}-label`}>{label}</span>
        <small id={`${id}-description`}>{description}</small>
      </div>
      <button
        type="button"
        role="switch"
        className="admin-switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="admin-switch-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}

function ActivityField({ label, value, emptyLabel }) {
  const relative = formatRelativeTime(value);
  return (
    <div>
      <span>{label}</span>
      {relative ? (
        <strong>
          <time dateTime={value} title={new Date(value).toLocaleString()}>{relative}</time>
        </strong>
      ) : (
        <strong className="admin-muted-value">{emptyLabel}</strong>
      )}
    </div>
  );
}

function AdminUserDetail() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { session, updateSession } = useAuth();
  const [user, setUser] = useState(null);
  const [preferences, setPreferences] = useState({});
  const [preferencesError, setPreferencesError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
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

      try {
        const settings = await getAdminUserSettings(userId);
        if (!cancelled) setPreferences(settingsToMap(settings));
      } catch (err) {
        if (!cancelled) setPreferencesError(err.message || "Could not load preferences.");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const isSelf = session?.id === userId;
  const isMaster = Boolean(user?.isMasterAdmin);
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    if (!isSelf) return undefined;

    function handleUserSettingsChanged(event) {
      const nextTheme = event.detail?.[THEME_SETTING_KEY];
      if (nextTheme === "dark" || nextTheme === "light") {
        setPreferences((current) => ({ ...current, [THEME_SETTING_KEY]: nextTheme }));
      }
    }

    window.addEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
    return () => window.removeEventListener(USER_SETTINGS_CHANGED_EVENT, handleUserSettingsChanged);
  }, [isSelf]);

  async function save(updates, successMessage = "User updated.") {
    try {
      setSaving(true);
      setError(null);
      setMessage("");
      const updated = await updateUser(userId, updates);
      setUser((current) => ({ ...current, ...updated }));
      if (isSelf) updateSession(updated);
      setMessage(successMessage);
    } catch (err) {
      setError(err.message || "Could not update user.");
    } finally {
      setSaving(false);
    }
  }

  async function savePreference(key, value) {
    const previous = preferences;
    setPreferences((current) => ({ ...current, [key]: value }));
    try {
      setSaving(true);
      setError(null);
      setMessage("");
      const settings = await updateAdminUserSettings(userId, { [key]: value });
      setPreferences(settingsToMap(settings));
      if (isSelf) {
        window.dispatchEvent(new CustomEvent(USER_SETTINGS_CHANGED_EVENT, { detail: { [key]: value } }));
      }
      setMessage("Preferences updated.");
    } catch (err) {
      setPreferences(previous);
      setError(err.message || "Could not update preferences.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (isMaster || isSelf) return;
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
        {error && <div className="error">{error}</div>}
        <div className="library-empty">
          User not found. <Link to="/admin/users">Back to users</Link>
        </div>
      </div>
    );
  }

  const active = !user.disabled;
  const lockedPermissions = isMaster || saving;
  const adminIncludes = "Included with administrator access";
  const dangerLockReason = isMaster
    ? "The master administrator cannot be disabled or deleted."
    : isSelf
      ? "You cannot disable or delete your own account."
      : null;

  return (
    <div className="admin-page">
      <div className="admin-detail-header">
        <div className="admin-detail-identity">
          <Link to="/admin/users" className="admin-back-link">← Users</Link>
          <UserAvatar user={user} className="admin-user-avatar" />
          <div>
            <h1>{user.displayName || user.username}</h1>
            <p>{isMaster ? "Master administrator" : isAdmin ? "Administrator" : "User"}</p>
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

      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="success" role="status">{message}</div>}

      <section className="admin-section admin-detail-section">
        <h2>Account</h2>
        <div className="admin-detail-fields">
          <div><span>Username</span><strong>{user.username}</strong></div>
          <div><span>Display name</span><strong>{user.displayName || "Not set"}</strong></div>
          <div><span>Role</span><strong>{isAdmin ? "Administrator" : "User"}</strong></div>
          <div><span>Status</span><strong>{active ? "Active" : "Disabled"}</strong></div>
        </div>
      </section>

      <section className="admin-section admin-detail-section" aria-labelledby="admin-permissions-heading">
        <h2 id="admin-permissions-heading">Permissions</h2>
        {isMaster && (
          <p className="admin-lock-note">
            The master administrator&apos;s permissions are protected and cannot be changed.
          </p>
        )}
        <div className="admin-permission-matrix">
          <PermissionSwitch
            id="permission-library"
            label="Library & playback"
            description="Every account can browse and stream the library"
            checked
            disabled
            onChange={() => {}}
          />
          <PermissionSwitch
            id="permission-search"
            label="External search"
            description={isAdmin ? adminIncludes : "Search Deezer, iTunes, and other external catalogs"}
            checked={isAdmin || Boolean(user.externalSearchEnabled)}
            disabled={lockedPermissions || isAdmin}
            onChange={(next) => save({ externalSearchEnabled: next }, "Permissions updated.")}
          />
          <PermissionSwitch
            id="permission-downloads"
            label="Downloads"
            description={isAdmin ? adminIncludes : "On-demand acquisition and external playback"}
            checked={isAdmin || Boolean(user.externalPlaybackEnabled)}
            disabled={lockedPermissions || isAdmin}
            onChange={(next) => save({ externalPlaybackEnabled: next }, "Permissions updated.")}
          />
          <PermissionSwitch
            id="permission-admin"
            label="Administration"
            description={isSelf && !isMaster
              ? "You cannot remove your own administrator access"
              : "Server, library, plugin, and user management"}
            checked={isAdmin}
            disabled={lockedPermissions || isSelf}
            onChange={(next) => save({ role: next ? "admin" : "user" }, "Permissions updated.")}
          />
        </div>
      </section>

      <section className="admin-section admin-detail-section" aria-labelledby="admin-preferences-heading">
        <h2 id="admin-preferences-heading">Preferences</h2>
        {preferencesError && <div className="error">{preferencesError}</div>}
        <div className="admin-preference-grid">
          {PREFERENCE_FIELDS.map((field) => {
            const inputId = `preference-${field.key.replace(/\W+/g, "-")}`;
            return (
              <label className="admin-preference-field" htmlFor={inputId} key={field.key}>
                <span>{field.label}</span>
                <select
                  id={inputId}
                  value={preferences[field.key] ?? field.fallback}
                  disabled={saving || Boolean(preferencesError)}
                  onChange={(event) => savePreference(field.key, event.target.value)}
                >
                  {field.options.map(([value, optionLabel]) => (
                    <option value={value} key={value}>{optionLabel}</option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      </section>

      <section className="admin-section admin-detail-section">
        <h2>Activity</h2>
        <div className="admin-detail-fields">
          <ActivityField label="Last login" value={user.lastLoginAt} emptyLabel="Never signed in" />
          <ActivityField label="Last playback" value={user.lastPlaybackAt} emptyLabel="No playback yet" />
          <ActivityField label="Member since" value={user.createdAt} emptyLabel="Unknown" />
        </div>
      </section>

      <section className="admin-section admin-detail-section admin-danger-zone">
        <h2>Danger zone</h2>
        {dangerLockReason && <p className="admin-lock-note">{dangerLockReason}</p>}
        <div className="admin-actions">
          <button
            type="button"
            className="account-action"
            disabled={saving || Boolean(dangerLockReason)}
            onClick={() => save({ disabled: active }, active ? "User disabled." : "User enabled.")}
          >
            {active ? "Disable user" : "Enable user"}
          </button>
          <button
            type="button"
            className="admin-danger"
            disabled={saving || Boolean(dangerLockReason)}
            onClick={handleDelete}
          >
            Delete user
          </button>
        </div>
      </section>
    </div>
  );
}


export default AdminUserDetail;
