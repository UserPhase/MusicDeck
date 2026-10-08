import { useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router-dom";

import {
  getUserSettings,
  updateAppConfig,
  updateUserSettings,
} from "../../api/musicdeck";
import {
  CUSTOM_CSS_PLACEHOLDER,
  CUSTOM_CSS_SETTING_KEY,
  sanitizeCustomCss,
} from "../../components/admin/CustomCssStyle";
import {
  DEFAULT_APP_NAME,
  splitBrandName,
  useBranding,
} from "../../context/BrandingContext";

// Mirrors the server-side limit in config-routes.ts.
const APP_NAME_MAX_LENGTH = 40;


function AdminAppearanceHome() {
  return (
    <section className="admin-section">
      <h2>Appearance</h2>
      <p className="account-meta">
        Customize how the app looks for everyone. Themes and layout styles are
        personal preferences in each user&apos;s Settings.
      </p>
      <div className="admin-link-grid">
        <NavLink to="/admin/appearance/branding" className="admin-link-card">
          <strong>Branding</strong>
          <span>Application name shown in the header, sidebar and browser title.</span>
        </NavLink>
        <NavLink to="/admin/appearance/custom-css" className="admin-link-card">
          <strong>Custom CSS</strong>
          <span>Write your own CSS overrides with preview and reset.</span>
        </NavLink>
      </div>
    </section>
  );
}


function AdminAppearanceBranding() {
  const { appName, setAppName } = useBranding();
  const [draft, setDraft] = useState(appName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");
  const draftTouchedRef = useRef(false);

  // Follow the loaded name until the admin starts typing.
  useEffect(() => {
    if (!draftTouchedRef.current) setDraft(appName);
  }, [appName]);

  const trimmed = draft.trim();
  const isValid = trimmed.length > 0 && trimmed.length <= APP_NAME_MAX_LENGTH;
  const isDirty = trimmed !== appName;

  async function handleSubmit(event) {
    event.preventDefault();
    if (!isValid || !isDirty) return;

    try {
      setSaving(true);
      setError(null);
      setMessage("");
      const config = await updateAppConfig({ appName: trimmed });
      setAppName(config?.appName || trimmed);
      setDraft(config?.appName || trimmed);
      draftTouchedRef.current = false;
      setMessage("Application name saved.");
    } catch (err) {
      setError(err.message || "Could not save the application name.");
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    draftTouchedRef.current = true;
    setDraft(DEFAULT_APP_NAME);
    setMessage("");
  }

  return (
    <section className="admin-section">
      <h2>Branding</h2>

      {error && <div className="error" role="alert">{error}</div>}
      {message && <div className="success" role="status">{message}</div>}

      <form className="admin-form admin-branding-form" onSubmit={handleSubmit}>
        <label htmlFor="admin-app-name">
          Application Name
          <input
            id="admin-app-name"
            type="text"
            value={draft}
            maxLength={APP_NAME_MAX_LENGTH}
            autoComplete="off"
            aria-describedby="admin-app-name-help"
            aria-invalid={!isValid}
            onChange={(event) => {
              draftTouchedRef.current = true;
              setDraft(event.target.value);
              setMessage("");
            }}
          />
        </label>
        <p id="admin-app-name-help" className="account-meta">
          This name will appear in the sidebar logo, header, and browser window title.
        </p>

        <div className="admin-brand-preview" aria-hidden="true">
          <span className="admin-brand-preview-label">Preview</span>
          <span className="logo admin-brand-preview-mark">
            {splitBrandName(trimmed || DEFAULT_APP_NAME).map((part, index) => (
              index === 0 ? part : part && <span key="accent">{part}</span>
            ))}
          </span>
        </div>

        <div className="admin-actions">
          <button
            type="submit"
            className="account-primary"
            disabled={saving || !isValid || !isDirty}
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            className="account-action"
            disabled={saving || draft === DEFAULT_APP_NAME}
            onClick={handleReset}
          >
            Use default name
          </button>
        </div>
      </form>
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
        <NavLink to="/admin/appearance/branding" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Branding
        </NavLink>
        <NavLink to="/admin/appearance/custom-css" className={({ isActive }) => `admin-subnav-item${isActive ? " active" : ""}`}>
          Custom CSS
        </NavLink>
      </nav>

      <Routes>
        <Route index element={<AdminAppearanceHome />} />
        <Route path="branding" element={<AdminAppearanceBranding />} />
        <Route path="custom-css" element={<AdminCustomCss />} />
        <Route path="*" element={<Navigate to="/admin/appearance" replace />} />
      </Routes>
    </div>
  );
}


export default AdminAppearance;
