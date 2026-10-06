import { useRef, useState } from "react";
import FloatingPanel from "./FloatingPanel";

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
  const toggleRef = useRef(null);

  function updateOpen(next) {
    setOpen((current) => {
      const value = typeof next === "function" ? next(current) : next;
      onOpenChange?.(value);
      return value;
    });
  }

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
        <FloatingPanel
          anchorRef={toggleRef}
          onClose={() => updateOpen(false)}
          className={`ui-menu-popover ${menuClassName}`.trim()}
          role="menu"
          aria-label={title || label}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {title && <div className="ui-menu-title">{title}</div>}
          {typeof children === "function" ? children({ close: () => updateOpen(false) }) : children}
        </FloatingPanel>
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
