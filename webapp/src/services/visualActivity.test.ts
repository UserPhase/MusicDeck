import { getVisualActivity, setDesktopForeground, startVisualPolling, subscribeVisualActivity } from "./visualActivity";

test("document visibility and desktop focus both gate visual work", () => {
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const listener = jest.fn();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  const unsubscribe = subscribeVisualActivity(listener);
  try {
    setDesktopForeground(false);
    expect(getVisualActivity()).toBe(false);
    expect(document.documentElement.dataset.visualActive).toBe("false");
    expect(listener).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    setDesktopForeground(true);
    expect(getVisualActivity()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getVisualActivity()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    if (original) Object.defineProperty(document, "visibilityState", original);
    else Reflect.deleteProperty(document, "visibilityState");
    setDesktopForeground(null);
  }
});

test("foreground polling clears its timer, refreshes on return, and disposes its subscription", () => {
  jest.useFakeTimers();
  const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
  const visibility = (value: DocumentVisibilityState) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const refresh = jest.fn();
  visibility("visible");
  const stop = startVisualPolling(refresh, 1000, { immediate: false });
  try {
    expect(refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    setDesktopForeground(false);
    expect(jest.getTimerCount()).toBe(0);
    visibility("hidden");
    setDesktopForeground(true);
    jest.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility("visible");
    expect(refresh).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(3);
    stop();
    setDesktopForeground(false);
    setDesktopForeground(true);
    expect(jest.getTimerCount()).toBe(0);
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally {
    stop();
    if (original) Object.defineProperty(document, "visibilityState", original);
    else Reflect.deleteProperty(document, "visibilityState");
    setDesktopForeground(null);
    jest.useRealTimers();
  }
});
