import { useEffect, useRef, useState } from "react";

import IconButton from "./IconButton";

function Menu({
  label,
  icon = "⋯",
  title,
  children,
  className = "",
  toggleClassName = "",
  menuClassName = "",
  renderToggle,
  onOpenChange,
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const toggleRef = useRef(null);

  function updateOpen(next) {
    setOpen((current) => {
      const value = typeof next === "function" ? next(current) : next;
      onOpenChange?.(value);
      return value;
    });
  }

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    function onKeyDown(event) {
      if (event.key === "Escape") {
        setOpen(false);
        onOpenChange?.(false);
        toggleRef.current?.focus();
      }
    }

    function onPointerDown(event) {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
        onOpenChange?.(false);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, onOpenChange]);

  const toggleProps = {
    ref: toggleRef,
    label,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    onMouseDown: (event) => event.stopPropagation(),
    onClick: (event) => {
      event.stopPropagation();
      updateOpen((value) => !value);
    },
  };

  return (
    <div
      className={`ui-menu ${className}`.trim()}
      ref={containerRef}
      onClick={(event) => event.stopPropagation()}
    >
      {renderToggle ? (
        renderToggle(toggleProps)
      ) : (
        <IconButton
          {...toggleProps}
          className={`ui-menu-toggle ${toggleClassName}`.trim()}
        >
          {icon}
        </IconButton>
      )}

      {open && (
        <div
          className={`ui-menu-popover ${menuClassName}`.trim()}
          role="menu"
          aria-label={title || label}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {title && <div className="ui-menu-title">{title}</div>}
          {typeof children === "function" ? children({ close: () => updateOpen(false) }) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ children, className = "", onSelect, ...props }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`ui-menu-item ${className}`.trim()}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(event);
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export default Menu;
