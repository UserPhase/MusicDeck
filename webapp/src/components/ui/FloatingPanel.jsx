import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export default function FloatingPanel({
  anchorRef, children, className = "", onClose, matchWidth = false,
  role = "menu", ...props
}) {
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState({ visibility: "hidden" });

  useLayoutEffect(() => {
    function positionPanel() {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const width = matchWidth ? Math.min(rect.width, window.innerWidth - 24) : panel.offsetWidth;
      const height = panel.offsetHeight;
      const below = rect.bottom + 8;
      const top = below + height <= window.innerHeight - 12 ? below : rect.top - height - 8;
      setPosition({
        visibility: "visible",
        left: Math.max(12, Math.min(matchWidth ? rect.left : rect.right - width, window.innerWidth - width - 12)),
        top: Math.max(12, Math.min(top, window.innerHeight - height - 12)),
        ...(matchWidth ? { width } : {}),
      });
    }
    positionPanel();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(positionPanel) : null;
    if (panelRef.current) observer?.observe(panelRef.current);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [anchorRef, matchWidth]);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (role === "menu") panelRef.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    function dismiss(event) {
      if (!panelRef.current?.contains(event.target) && !anchor?.contains(event.target)) closeRef.current?.();
    }
    function keyboard(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.();
        anchor?.focus();
      } else if (role === "menu" && panelRef.current?.contains(event.target)) {
        const items = [...panelRef.current.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]')]
          .filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true");
        const index = items.indexOf(document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        } else if (event.key === "Tab") closeRef.current?.();
      }
    }
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", keyboard);
    };
  }, [anchorRef, role]);

  return createPortal(
    <div {...props} ref={panelRef} role={role}
      className={`glass-dropdown glass-dropdown-portal ${className}`.trim()} style={position}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}
