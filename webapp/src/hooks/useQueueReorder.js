import { useEffect, useRef, useState } from "react";

export const QUEUE_DRAG_THRESHOLD = 6;
const INTERACTIVE = "button, a, input, select, textarea, [contenteditable='true'], [role='button']";

export function useQueueReorder({ queue, queueIndex, moveQueueItem, enabled, listRef, onMove }) {
  const identity = useRef({ queue: null, entries: [], nextId: 0 });
  const rows = useRef(new Map());
  const pointer = useRef(null);
  const cleanup = useRef(null);
  const pendingFocus = useRef(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState(null);
  const [announcement, setAnnouncement] = useState("");

  // Keys belong to occurrences, not track IDs (even two occurrences of one object).
  if (identity.current.queue !== queue) {
    const remaining = [...identity.current.entries];
    identity.current.entries = queue.map((song) => {
      const index = remaining.findIndex((entry) => entry.song === song);
      return index >= 0
        ? remaining.splice(index, 1)[0]
        : { song, key: `queue-entry-${identity.current.nextId++}` };
    });
    identity.current.queue = queue;
  }
  const entries = identity.current.entries;

  useEffect(() => {
    if (pendingFocus.current) {
      const { key, handle } = pendingFocus.current;
      const row = rows.current.get(key);
      const target = (handle ? row?.querySelector(".queue-sidebar-drag-handle") : null) || row;
      target?.focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: "nearest" });
      pendingFocus.current = null;
    }
  }, [queue, entries]);

  useEffect(() => () => {
    const wasDragging = pointer.current?.active;
    cleanup.current?.();
    pointer.current = null;
    setDrag(null);
    if (wasDragging) setAnnouncement("Queue reorder cancelled.");
  }, [queue, queueIndex, enabled]);

  function move(from, to, focusHandle = false) {
    if (!enabled || !Number.isInteger(to) || from <= queueIndex || to <= queueIndex ||
      from >= queue.length || to >= queue.length || from === to) return;
    const reordered = [...entries];
    const [entry] = reordered.splice(from, 1);
    reordered.splice(to, 0, entry);
    identity.current = { ...identity.current, queue: null, entries: reordered };
    pendingFocus.current = { key: entry.key, handle: focusHandle };
    setAnnouncement(`${entry.song.title || "Unknown title"} moved to upcoming position ${to - queueIndex}.`);
    onMove(to);
    moveQueueItem(from, to);
  }

  function cancel() {
    const active = pointer.current?.active;
    cleanup.current?.();
    pointer.current = null;
    setDrag(null);
    if (active) setAnnouncement("Queue reorder cancelled.");
  }

  function startPointer(event, from) {
    if (!pointer.current) suppressClick.current = false;
    if (!enabled || from <= queueIndex || event.button !== 0 || event.isPrimary === false ||
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const handle = event.target.closest(".queue-sidebar-drag-handle");
    if (event.pointerType !== "mouse" && !handle) return;
    if (!handle && event.target.closest(INTERACTIVE)) return;
    if (pointer.current) return;
    const row = rows.current.get(entries[from].key);
    const list = listRef.current;
    if (!row || !list) return;
    const state = {
      pointerId: event.pointerId, from, to: from, key: entries[from].key,
      startX: event.clientX, startY: event.clientY, y: event.clientY,
      scrollTop: list.scrollTop, active: false, handle: Boolean(handle),
      bounds: [], height: 0,
    };
    pointer.current = state;
    let frame = null;

    function update() {
      const scrollDelta = list.scrollTop - state.scrollTop;
      const boundary = state.bounds.find((item) => item.index !== from && state.y < item.center - scrollDelta);
      const insertion = boundary ? boundary.index : state.bounds[state.bounds.length - 1].index + 1;
      state.to = insertion > from ? insertion - 1 : insertion;
      setDrag({
        key: state.key, from, to: state.to, height: state.height,
        offset: state.y - state.startY + scrollDelta,
      });
    }

    function autoScroll() {
      if (!state.active) return;
      const bounds = list.getBoundingClientRect();
      const edge = Math.min(44, bounds.height / 4);
      const distance = state.y < bounds.top + edge
        ? -Math.min(12, (bounds.top + edge - state.y) / 3)
        : state.y > bounds.bottom - edge
          ? Math.min(12, (state.y - bounds.bottom + edge) / 3) : 0;
      if (distance) {
        const previous = list.scrollTop;
        list.scrollTop = Math.max(0, Math.min(list.scrollHeight - list.clientHeight, previous + distance));
        if (list.scrollTop !== previous) update();
      }
      frame = window.requestAnimationFrame(autoScroll);
    }

    function onMove(nextEvent) {
      if (nextEvent.pointerId !== state.pointerId) return;
      state.y = nextEvent.clientY;
      if (!state.active) {
        if (Math.hypot(nextEvent.clientX - state.startX, state.y - state.startY) < QUEUE_DRAG_THRESHOLD) return;
        state.active = true;
        suppressClick.current = true;
        window.getSelection()?.removeAllRanges();
        state.scrollTop = list.scrollTop;
        const rect = row.getBoundingClientRect();
        state.height = rect.height + 2;
        state.bounds = entries.flatMap((entry, index) => {
          const element = rows.current.get(entry.key);
          if (index <= queueIndex || !element) return [];
          const bounds = element.getBoundingClientRect();
          return [{ index, center: bounds.top + bounds.height / 2 }];
        });
        row.setPointerCapture?.(state.pointerId);
        setAnnouncement(`Moving ${entries[from].song.title || "Unknown title"}. Release to drop; Escape to cancel.`);
        frame = window.requestAnimationFrame(autoScroll);
      }
      nextEvent.preventDefault();
      update();
    }

    function onUp(nextEvent) {
      if (nextEvent.pointerId !== state.pointerId) return;
      if (state.active) {
        state.y = nextEvent.clientY;
        update();
      }
      const { active, to } = state;
      cleanup.current?.();
      pointer.current = null;
      setDrag(null);
      if (active) {
        if (to === from) setAnnouncement("Queue order unchanged.");
        else move(from, to, state.handle);
      }
    }

    function onCancel(nextEvent) {
      if (nextEvent.pointerId === state.pointerId) cancel();
    }
    function onKeyDown(nextEvent) {
      if (nextEvent.key === "Escape") {
        nextEvent.preventDefault();
        nextEvent.stopPropagation();
        cancel();
      }
    }
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    cleanup.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (row.hasPointerCapture?.(state.pointerId)) row.releasePointerCapture(state.pointerId);
      cleanup.current = null;
    };
  }

  function rowProps(entry, index) {
    const offset = !drag ? 0 : drag.key === entry.key ? drag.offset
      : drag.from < index && index <= drag.to ? -drag.height
        : drag.to <= index && index < drag.from ? drag.height : 0;
    return {
      ref: (element) => {
        if (element) rows.current.set(entry.key, element);
        else rows.current.delete(entry.key);
      },
      style: { transform: offset ? `translateY(${offset}px)` : undefined },
      "data-dragging": drag?.key === entry.key || undefined,
      "data-drop-edge": drag && drag.to !== drag.from && index === drag.to
        ? (drag.to > drag.from ? "after" : "before") : undefined,
      onPointerDown: (event) => startPointer(event, index),
      onDragStart: (event) => event.preventDefault(),
      onClickCapture: (event) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
      onKeyDown: (event) => {
        const handle = event.target.closest(".queue-sidebar-drag-handle");
        if (event.target !== event.currentTarget && !handle) return;
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        if (pointer.current) return;
        event.preventDefault();
        move(index, index + (event.key === "ArrowUp" ? -1 : 1), Boolean(handle));
      },
    };
  }

  return { entries, drag, announcement, rowProps };
}
