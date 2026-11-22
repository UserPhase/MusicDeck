import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { getVisualViewportBounds, observeVisualViewport, useVisualViewportBounds } from "../../hooks/useVisualViewportBounds";
import { MOBILE_LAYOUT_QUERY } from "../../utils/layoutPreset";

function menuItems(panel) {
  return [...(panel?.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]') || [])]
    .filter((item) => !item.disabled && item.getAttribute("aria-disabled") !== "true");
}

function moveMenuFocus(event, panel) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = menuItems(panel);
  if (!items.length) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
    : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

export default function FloatingPanel({
  anchorRef, children, className = "", onClose, matchWidth = false,
  role = "menu", ...props
}) {
  const mobile = useMediaQuery(MOBILE_LAYOUT_QUERY);
  const panelRef = useRef(null);
  const sheetRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState({ visibility: "hidden" });
  useVisualViewportBounds(sheetRef, mobile);

  useLayoutEffect(() => {
    if (mobile) return;
    function positionPanel() {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = getVisualViewportBounds();
      const availableWidth = Math.max(0, viewport.width - 24);
      const availableHeight = Math.max(0, viewport.height - 24);
      const width = Math.min(matchWidth ? rect.width : panel.offsetWidth, availableWidth);
      const height = Math.min(panel.offsetHeight, availableHeight);
      const right = viewport.left + viewport.width - 12;
      const bottom = viewport.top + viewport.height - 12;
      const below = rect.bottom + 8;
      const top = below + height <= bottom ? below : rect.top - height - 8;
      setPosition({
        visibility: "visible",
        left: Math.max(viewport.left + 12, Math.min(matchWidth ? rect.left : rect.right - width, right - width)),
        top: Math.max(viewport.top + 12, Math.min(top, bottom - height)),
        ...(viewport.width < window.innerWidth ? { maxWidth: availableWidth } : {}),
        ...(viewport.height < window.innerHeight ? { maxHeight: availableHeight, overflowY: "auto" } : {}),
        ...(matchWidth ? { width } : {}),
      });
    }
    const disconnectViewport = observeVisualViewport(positionPanel);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(positionPanel) : null;
    if (panelRef.current) observer?.observe(panelRef.current);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      observer?.disconnect();
      disconnectViewport();
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [anchorRef, matchWidth, mobile]);

  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    if (!mobile || !sheet) return;
    const anchor = anchorRef.current;
    sheet.showModal();
    return () => {
      if (sheet.open) sheet.close();
      if (anchor?.isConnected) anchor.focus({ preventScroll: true });
    };
  }, [anchorRef, mobile]);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (role === "menu") {
      const items = menuItems(panelRef.current);
      (items.find((item) => item.getAttribute("role") === "menuitemradio" && item.getAttribute("aria-checked") === "true") || items[0])
        ?.focus({ preventScroll: mobile });
    }
    if (mobile) return;
    function dismiss(event) {
      if (!panelRef.current?.contains(event.target) && !anchor?.contains(event.target)) closeRef.current?.();
    }
    function keyboard(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.();
        anchor?.focus();
      } else if (role === "menu" && panelRef.current?.contains(event.target)) {
        if (event.key === "Tab") closeRef.current?.();
        else moveMenuFocus(event, panelRef.current);
      }
    }
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("mousedown", dismiss, true);
      document.removeEventListener("keydown", keyboard);
    };
  }, [anchorRef, mobile, role]);

  if (mobile) return createPortal(
    <dialog ref={sheetRef} className="floating-panel-sheet"
      aria-label={props["aria-label"] || (props["aria-labelledby"] ? undefined : "Options")}
      aria-labelledby={props["aria-labelledby"]}
      onCancel={(event) => { event.preventDefault(); closeRef.current?.(); }}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) closeRef.current?.(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (role === "menu" && panelRef.current?.contains(event.target)) moveMenuFocus(event, panelRef.current);
      }}>
      <div {...props} ref={panelRef} role={role} className={`glass-dropdown ${className} floating-panel-sheet-body`}>
        {children}
      </div>
      <footer className="floating-panel-sheet-footer">
        <button type="button" onClick={() => closeRef.current?.()}>Done</button>
      </footer>
    </dialog>,
    document.body,
  );

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
