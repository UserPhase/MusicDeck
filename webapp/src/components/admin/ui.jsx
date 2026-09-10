/*
 * Shared presentational primitives for admin pages.
 *
 * These keep table headers, status pills, and section chrome consistent
 * across Plugins, Users, Sources, and future admin screens instead of each
 * page re-implementing its own markup/classnames.
 */

export function AdminPageHeader({ label = "ADMIN", title, meta, actions }) {
  return (
    <div className="account-header">
      <div>
        <div className="account-label">{label}</div>
        <h1>{title}</h1>
        {meta && <div className="account-meta">{meta}</div>}
      </div>
      {actions}
    </div>
  );
}

export function AdminSection({ title, children, className = "" }) {
  return (
    <section className={`admin-section ${className}`.trim()}>
      {title && <h2>{title}</h2>}
      {children}
    </section>
  );
}

export function AdminTable({ label, columns, children, className = "" }) {
  return (
    <div className={`admin-table ${className}`.trim()} role="table" aria-label={label}>
      <div className="admin-row admin-row-head" role="row">
        {columns.map((column) => (
          <span key={column}>{column}</span>
        ))}
      </div>
      {children}
    </div>
  );
}

export function AdminBadge({ active, activeLabel, inactiveLabel, dot = true }) {
  const prefix = dot ? (active ? "● " : "○ ") : "";
  return (
    <span className={`admin-badge ${active ? "is-active" : "is-disabled"}`}>
      {prefix}
      {active ? activeLabel : inactiveLabel}
    </span>
  );
}

export function AdminActionBar({ children }) {
  return <div className="admin-actions">{children}</div>;
}
