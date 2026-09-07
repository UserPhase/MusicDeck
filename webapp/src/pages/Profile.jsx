import { useEffect, useState } from "react";

import {
  changePassword,
  getCurrentUser,
  updateCurrentUser,
} from "../api/musicdeck";

import {
  useAuth,
} from "../context/AuthContext";


function Profile() {
  const { updateSession } = useAuth();

  const [user, setUser] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [avatarRef, setAvatarRef] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [error, setError] = useState(null);
  const [profileMessage, setProfileMessage] = useState("");
  const [passwordMessage, setPasswordMessage] = useState("");


  useEffect(() => {
    let cancelled = false;

    async function loadProfile() {
      try {
        setLoading(true);
        setError(null);

        const data = await getCurrentUser();

        if (!cancelled) {
          setUser(data);
          setDisplayName(data.displayName || data.username || "");
          setAvatarRef(data.avatarRef || "");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load profile.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadProfile();

    return () => {
      cancelled = true;
    };
  }, []);


  async function handleProfileSubmit(event) {
    event.preventDefault();

    try {
      setSavingProfile(true);
      setProfileMessage("");
      setError(null);

      const updated = await updateCurrentUser({
        displayName: displayName.trim(),
        avatarRef: avatarRef.trim() || null,
      });

      setUser(updated);
      updateSession(updated);
      setProfileMessage("Profile updated.");
    } catch (err) {
      setError(err.message || "Could not update profile.");
    } finally {
      setSavingProfile(false);
    }
  }


  async function handlePasswordSubmit(event) {
    event.preventDefault();

    try {
      setSavingPassword(true);
      setPasswordMessage("");
      setError(null);

      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordMessage("Password updated.");
    } catch (err) {
      setError(err.message || "Could not update password.");
    } finally {
      setSavingPassword(false);
    }
  }


  if (loading) {
    return <div className="loading">Loading profile...</div>;
  }

  if (error && !user) {
    return <div className="error">{error}</div>;
  }

  return (
    <div className="account-page">
      <div className="account-header">
        <div className="account-avatar">
          {(user?.displayName || user?.username || "MD")
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <div>
          <div className="account-label">PROFILE</div>
          <h1>{user?.displayName || user?.username}</h1>
          <div className="account-meta">{user?.username} · {user?.role}</div>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <form className="account-form" onSubmit={handleProfileSubmit}>
        <label>
          <span>Username</span>
          <input type="text" value={user?.username || ""} disabled />
        </label>

        <label>
          <span>Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </label>

        <label>
          <span>Avatar reference</span>
          <input
            type="text"
            value={avatarRef}
            onChange={(event) => setAvatarRef(event.target.value)}
            placeholder="Optional"
          />
        </label>

        <label>
          <span>Role</span>
          <input type="text" value={user?.role || ""} disabled />
        </label>

        {profileMessage && <div className="success">{profileMessage}</div>}

        <button type="submit" className="account-primary" disabled={savingProfile}>
          {savingProfile ? "Saving..." : "Save profile"}
        </button>
      </form>

      <form className="account-form" onSubmit={handlePasswordSubmit}>
        <h2>Change password</h2>

        <label>
          <span>Current password</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        <label>
          <span>New password</span>
          <input
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>

        {passwordMessage && <div className="success">{passwordMessage}</div>}

        <button type="submit" className="account-primary" disabled={savingPassword}>
          {savingPassword ? "Saving..." : "Change password"}
        </button>
      </form>
    </div>
  );
}


export default Profile;
