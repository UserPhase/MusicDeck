import { fireEvent, render, screen } from "@testing-library/react";
import useGlobalHotkeys from "./useGlobalHotkeys";

function Harness({ actions }) {
  useGlobalHotkeys(actions);
  return <input aria-label="typing target" />;
}

describe("useGlobalHotkeys", () => {
  test("runs playback shortcuts and leaves typing targets alone", () => {
    const actions = {
      onTogglePlay: jest.fn(), onToggleMute: jest.fn(), onNext: jest.fn(),
      onPrevious: jest.fn(), onToggleLike: jest.fn(), onOpenPalette: jest.fn(),
    };
    render(<Harness actions={actions} />);

    fireEvent.keyDown(window, { code: "Space" });
    fireEvent.keyDown(window, { code: "KeyM" });
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(window, { code: "KeyL" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(actions.onTogglePlay).toHaveBeenCalledTimes(1);
    expect(actions.onToggleMute).toHaveBeenCalledTimes(1);
    expect(actions.onNext).toHaveBeenCalledTimes(1);
    expect(actions.onPrevious).toHaveBeenCalledTimes(1);
    expect(actions.onToggleLike).toHaveBeenCalledTimes(1);
    expect(actions.onOpenPalette).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByLabelText("typing target"), { code: "Space" });
    expect(actions.onTogglePlay).toHaveBeenCalledTimes(1);
  });
});
