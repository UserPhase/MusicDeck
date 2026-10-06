function LightHero({
  eyebrow,
  title,
  subtitle,
  className = "",
  children,
}) {
  return (
    <header className={`light-hero ${className}`.trim()}>
      <div className="light-hero-copy">
        {eyebrow && <p className="light-hero-eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="light-hero-subtitle">{subtitle}</p>}
      </div>
      {children && <div className="light-hero-actions">{children}</div>}
    </header>
  );
}

export default LightHero;
