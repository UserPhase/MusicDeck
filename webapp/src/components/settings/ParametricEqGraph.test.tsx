import { act, render } from "@testing-library/react";
import ParametricEqGraph from "./ParametricEqGraph";
import { setDesktopForeground } from "../../services/visualActivity";

test("draws at most 30 spectrum frames per second and stops when it cannot be seen", () => {
  jest.useFakeTimers();
  const observerDescriptor = Object.getOwnPropertyDescriptor(window, "IntersectionObserver");
  let setIntersecting = (_visible: boolean) => {};
  const disconnect = jest.fn();
  Object.defineProperty(window, "IntersectionObserver", { configurable: true, value: class {
    constructor(callback: IntersectionObserverCallback) {
      setIntersecting = (visible) => callback([{ isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    disconnect = disconnect;
  } });
  const getContext = jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: jest.fn(), beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(), fill: jest.fn(),
  } as unknown as CanvasRenderingContext2D);
  const width = jest.spyOn(HTMLCanvasElement.prototype, "clientWidth", "get").mockReturnValue(300);
  const height = jest.spyOn(HTMLCanvasElement.prototype, "clientHeight", "get").mockReturnValue(100);
  const sample = jest.fn();
  const analyser = { frequencyBinCount: 64, fftSize: 128, context: { sampleRate: 48000 },
    getByteFrequencyData: sample } as unknown as AnalyserNode;
  const props = { bands: [], active: 0, sampleRate: 48000, onSelect: jest.fn(), onChange: jest.fn(), getAnalyser: () => analyser };
  try {
    const view = render(<ParametricEqGraph {...props} playing />);
    act(() => jest.advanceTimersByTime(1000));
    expect(sample).not.toHaveBeenCalled();

    act(() => setIntersecting(true));
    act(() => jest.advanceTimersByTime(1000));
    expect(sample).toHaveBeenCalledTimes(30);

    act(() => setDesktopForeground(false));
    act(() => jest.advanceTimersByTime(1000));
    expect(sample).toHaveBeenCalledTimes(30);

    act(() => setDesktopForeground(true));
    expect(sample).toHaveBeenCalledTimes(31);
    view.rerender(<ParametricEqGraph {...props} playing={false} />);
    act(() => jest.advanceTimersByTime(1000));
    expect(sample).toHaveBeenCalledTimes(31);
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    if (observerDescriptor) Object.defineProperty(window, "IntersectionObserver", observerDescriptor);
    else Reflect.deleteProperty(window, "IntersectionObserver");
    setDesktopForeground(null);
    getContext.mockRestore(); width.mockRestore(); height.mockRestore();
    jest.useRealTimers();
  }
});
