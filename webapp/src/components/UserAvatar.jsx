import { useState } from "react";

/*
 * Single render point for a MusicDeck user's avatar: the uploaded photo when
 * the server exposes one, otherwise two-letter initials. Used by the top bar,
 * the admin top bar, and the profile page so an upload shows up everywhere.
 */
export function userInitials(user, fallback = "MD") {
  return (user?.displayName || user?.username || fallback).slice(0, 2).toUpperCase();
}

function UserAvatar({ user, className = "avatar", fallback }) {
  const avatarUrl = user?.avatarUrl || null;
  const [failedUrl, setFailedUrl] = useState(null);
  const showPhoto = avatarUrl && failedUrl !== avatarUrl;

  return (
    <span className={`${className}${showPhoto ? " has-photo" : ""}`} aria-hidden="true">
      {showPhoto ? (
        <img
          className="user-avatar-photo"
          src={avatarUrl}
          alt=""
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : userInitials(user, fallback)}
    </span>
  );
}

export default UserAvatar;
