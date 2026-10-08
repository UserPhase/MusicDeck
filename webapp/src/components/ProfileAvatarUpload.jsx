import { useRef, useState } from "react";

import UserAvatar from "./UserAvatar";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}

/*
 * Circular profile avatar that doubles as a file picker. Hover or keyboard
 * focus reveals a "Choose photo" overlay; the file is validated client-side
 * (type and 5 MB cap, mirroring the server) before `onUpload` receives the
 * data URL. Errors are reported through `onError` so the page owns messaging.
 */
function ProfileAvatarUpload({ user, onUpload, onError }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);

  async function handleChange(event) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    if (!ACCEPTED_AVATAR_TYPES.includes(file.type)) {
      onError("Choose a JPEG, PNG, or WebP image.");
      return;
    }

    if (file.size > MAX_AVATAR_BYTES) {
      onError("Avatar images must be 5 MB or smaller.");
      return;
    }

    setBusy(true);
    onError(null);

    try {
      await onUpload(await readAsDataUrl(file));
    } catch (err) {
      onError(err.message || "Could not update your avatar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="account-avatar-button"
        aria-label="Choose profile photo"
        aria-busy={busy}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        <UserAvatar user={user} className="account-avatar" />

        <span className="account-avatar-overlay" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.17 6.81a2.83 2.83 0 0 0-4-4L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5Z" />
            <path d="m15 5 4 4" />
          </svg>
          <span>{busy ? "Uploading…" : "Choose photo"}</span>
        </span>
      </button>

      <input
        ref={inputRef}
        className="visually-hidden-input"
        type="file"
        accept={ACCEPTED_AVATAR_TYPES.join(",")}
        tabIndex={-1}
        aria-hidden="true"
        data-testid="avatar-file-input"
        disabled={busy}
        onChange={handleChange}
      />
    </>
  );
}

export default ProfileAvatarUpload;
