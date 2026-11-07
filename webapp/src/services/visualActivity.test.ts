import { getVisualActivity, setDesktopForeground, subscribeVisualActivity } from "./visualActivity";

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
