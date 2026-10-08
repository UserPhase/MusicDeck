import { useEffect, useState } from "react";

import {
  changePassword,
  getCurrentUser,
  removeCurrentUserAvatar,
  updateCurrentUser,
  uploadCurrentUserAvatar,
} from "../api/musicdeck";

import ProfileAvatarUpload from "../components/ProfileAvatarUpload";

import {
  useAuth,
} from "../context/AuthContext";


function Profile() {
  const { updateSession } = useAuth();

  const [user, setUser] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [removingAvatar, setRemovingAvatar] = useState(false);
  const [error, setError] = useState(null);
  const [avatarError, setAvatarError] = useState(null);
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


  // The session user feeds the top bar avatar, so syncing it here updates
  // every avatar in the app without a reload.
  function applyAvatarUpdate(updated) {
    if (!updated) return;
    setUser(updated);
    updateSession(updated);
  }

  async function handleAvatarUpload(image) {
    applyAvatarUpdate(await uploadCurrentUserAvatar(image));
  }

  async function handleAvatarRemove() {
    try {
      setRemovingAvatar(true);
      setAvatarError(null);
      applyAvatarUpdate(await removeCurrentUserAvatar());
    } catch (err) {
      setAvatarError(err.message || "Could not remove your avatar.");
    } finally {
      setRemovingAvatar(false);
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
        <div className="account-avatar-column">
          <ProfileAvatarUpload
            user={user}
            onUpload={handleAvatarUpload}
            onError={setAvatarError}
          />
          {user?.avatarUrl && (
            <button
              type="button"
              className="account-avatar-remove"
              disabled={removingAvatar}
              onClick={handleAvatarRemove}
            >
              {removingAvatar ? "Removing…" : "Remove photo"}
            </button>
          )}
        </div>
        <div>
          <div className="account-label">PROFILE</div>
          <h1>{user?.displayName || user?.username}</h1>
          <div className="account-meta">{user?.username} · {user?.role}</div>
        </div>
      </div>

      {avatarError && <div className="error" role="alert">{avatarError}</div>}
      {error && <div className="error">{error}</div>}

      <form className="account-form" onSubmit={handleProfileSubmit}>
        <label>
          <span>Display name</span>
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
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
