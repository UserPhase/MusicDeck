function IconButton({
  label,
  children,
  className = "",
  type = "button",
  ...props
}) {
  return (
    <button
      type={type}
      className={`ui-icon-button ${className}`.trim()}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  );
}

export default IconButton;
