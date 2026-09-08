import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";

import {
  getUserSettings,
  updateUserSettings,
} from "../../api/musicdeck";
import {
  CUSTOM_CSS_PLACEHOLDER,
  CUSTOM_CSS_SETTING_KEY,
  sanitizeCustomCss,
} from "../../components/admin/CustomCssStyle";


function AdminAppearanceHome() {
  return (
    <section className="admin-section">
      <h2>Appearance</h2>
      <p className="account-meta">
        Customize how MusicDeck looks. Choose a section above.
      </p>
      <div className="admin-link-grid">
        <NavLink to="/admin/appearance/themes" className="admin-link-card">
          <strong>Themes</strong>
          <span>Accent color and base theme.</span>
        </NavLink>
        <NavLink to="/admin/appearance/custom-css" className="admin-link-card">
          <strong>Custom CSS</strong>
          <span>Write your own CSS overrides with preview and reset.</span>
        </NavLink>
        <NavLink to="/admin/appearance/branding" className="admin-link-card">
          <strong>Branding</strong>
          <span>Application name shown in the top bar.</span>
        </NavLink>
        <NavLink to="/admin/appearance/layout" className="admin-link-card">
          <strong>Layout</strong>
          <span>Density and sidebar preferences.</span>
        </NavLink>
      </div>
    </section>
  );
}


function AdminAppearanceThemes() {
  return (
    <section className="admin-section">
      <h2>Themes</h2>
      <p className="account-meta">
        The default MusicDeck dark theme is always applied. Use Custom CSS to
        override accent colors and surfaces.
      </p>
      <div className="admin-grid">
        <div className="admin-card">
          <span>Active theme</span>
          <strong>MusicDeck Dark</strong>
        </div>
      </div>
    </section>
  );
}


function AdminAppearanceBranding() {
  return (
    <section className="admin-section">
      <h2>Branding</h2>
      <p className="account-meta">
        The application is branded as MusicDeck. A future release will allow
        overriding the display name here.
      </p>
    </section>
  );
}


function AdminAppearanceLayout() {
  return (
    <section className="admin-section">
      <h2>Layout</h2>
      <p className="account-meta">
        The standard MusicDeck layout (sidebar + content + global player) is
        always used. The admin area switches to its own sidebar automatically.
      </p>
    </section>
  );
}


function AdminCustomCss() {
  const [css, setCss] = useState("");
  const [savedCss, setSavedCss] = useState("");
  const [previewCss, setPreviewCss] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        const settings = await getUserSettings();
        const entry = (settings || []).find(
          (item) => item.key === CUSTOM_CSS_SETTING_KEY
        );

        if (cancelled) {
          return;
        }

        if (entry) {
          try {
            const parsed = JSON.parse(entry.value);
            setCss(parsed);
            setSavedCss(parsed);
          } catch {
            setCss(entry.value);
            setSavedCss(entry.value);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load custom CSS.");
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
  }, []);

  function applyPreview(value) {
    setPreviewCss(sanitizeCustomCss(value));
  }

  async function handleSave() {
    try {
      setSaving(true);
      setError(null);
      setMessage("");

      const sanitized = sanitizeCustomCss(css);
      await updateUserSettings({ [CUSTOM_CSS_SETTING_KEY]: sanitized });

      setCss(sanitized);
      setSavedCss(sanitized);
      setPreviewCss("");
      window.dispatchEvent(
        new CustomEvent("musicdeck:custom-css", { detail: { css: sanitized } })
      );
      setMessage("Custom CSS saved.");
    } catch (err) {
      setError(err.message || "Could not save custom CSS.");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (
      !window.confirm(
        "Reset custom CSS to default? This removes all custom styling."
      )
    ) {
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setMessage("");

      await updateUserSettings({ [CUSTOM_CSS_SETTING_KEY]: "" });

      setCss("");
      setSavedCss("");
      setPreviewCss("");
      window.dispatchEvent(
        new CustomEvent("musicdeck:custom-css", { detail: { css: "" } })
      );
      setMessage("Custom CSS reset to default.");
    } catch (err) {
      setError(err.message || "Could not reset custom CSS.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="loading">Loading custom CSS...</div>;
  }

  const sanitized = sanitizeCustomCss(css);
  const wasSanitized = sanitized !== css.trim() && css.trim() !== "";

  return (
    <section className="admin-section">
      <h2>Custom CSS</h2>
      <p className="account-meta">
        Applied to the whole MusicDeck interface. Rules that would hide the
        player or navigation are stripped for safety.
      </p>

      {error && <div className="error">{error}</div>}
      {message && <div className="success">{message}</div>}
      {wasSanitized && (
        <div className="admin-warning" role="note">
          Some unsafe rules (hiding the player or navigation) will be removed
          when saving or previewing.
        </div>
      )}

      <textarea
        className="admin-css-editor"
        aria-label="Custom CSS"
        rows={16}
        spellCheck={false}
        placeholder={CUSTOM_CSS_PLACEHOLDER}
        value={css}
        onChange={(event) => setCss(event.target.value)}
      />

      <div className="admin-actions">
        <button
          type="button"
          className="account-action"
          disabled={saving || !css.trim()}
          onClick={() => applyPreview(css)}
        >
          Preview
        </button>
        <button
          type="button"
          className="account-primary"
          disabled={saving || css === savedCss}
          onClick={handleSave}
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          type="button"
          className="admin-danger"
          disabled={saving || (!css && !savedCss)}
          onClick={handleReset}
        >
          Reset to default
        </button>
      </div>

      {previewCss && (
        <style data-testid="custom-css-preview">{previewCss}</style>
      )}
    </section>
  );
}


function AdminAppearance() {
  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN</div>
          <h1>Appearance</h1>
        </div>
      </div>

      <nav className="admin-subnav" aria-label="Appearance sections">
        <NavLink to="/admin/appearance" end className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Overview
        </NavLink>
        <NavLink to="/admin/appearance/themes" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Themes
        </NavLink>
        <NavLink to="/admin/appearance/custom-css" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Custom CSS
        </NavLink>
        <NavLink to="/admin/appearance/branding" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Branding
        </NavLink>
        <NavLink to="/admin/appearance/layout" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Layout
        </NavLink>
      </nav>

      <Routes>
        <Route index element={<AdminAppearanceHome />} />
        <Route path="themes" element={<AdminAppearanceThemes />} />
        <Route path="custom-css" element={<AdminCustomCss />} />
        <Route path="branding" element={<AdminAppearanceBranding />} />
        <Route path="layout" element={<AdminAppearanceLayout />} />
      </Routes>
    </div>
  );
}


export default AdminAppearance;
