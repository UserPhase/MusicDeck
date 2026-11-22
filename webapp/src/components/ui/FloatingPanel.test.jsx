import { useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import FloatingPanel from "./FloatingPanel";

function Example({ onSelect = () => {} }) {
  const anchor = useRef(null);
  const [open, setOpen] = useState(false);
  return <div data-testid="clipped-parent" style={{ overflow: "hidden" }}>
    <button ref={anchor} onClick={() => setOpen(!open)}>Open</button>
    {open && <FloatingPanel anchorRef={anchor} onClose={() => setOpen(false)} aria-label="Actions">
      <button role="menuitem" onClick={onSelect}>First</button>
      <button role="menuitem" disabled>Disabled</button>
      <button role="menuitem">Last</button>
    </FloatingPanel>}
  </div>;
}

test("portals glass menus outside clipped parents and retains interaction", () => {
  const onSelect = jest.fn();
  render(<Example onSelect={onSelect} />);
  fireEvent.click(screen.getByText("Open"));
  const menu = screen.getByRole("menu");
  expect(menu.parentElement).toBe(document.body);
  expect(screen.getByTestId("clipped-parent")).not.toContainElement(menu);
  expect(menu).toHaveClass("glass-dropdown", "glass-dropdown-portal");
  expect(menu.style.visibility).toBe("visible");
  expect(screen.getByText("First")).toHaveFocus();
  fireEvent.mouseDown(screen.getByText("First"));
  fireEvent.click(screen.getByText("First"));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(menu).toBeInTheDocument();
  fireEvent.keyDown(screen.getByText("First"), { key: "ArrowDown" });
  expect(screen.getByText("Last")).toHaveFocus();
  fireEvent.keyDown(screen.getByText("Last"), { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByText("Open")).toHaveFocus();
});

test("outside clicks dismiss the panel", () => {
  render(<Example />);
  fireEvent.click(screen.getByText("Open"));
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

test("clamps a panel anchored beyond the viewport and cleans up positioning listeners", () => {
  const rect = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 2000, right: 2200, top: 2000, bottom: 2040, width: 200, height: 40,
  });
  const remove = jest.spyOn(window, "removeEventListener");
  const { unmount } = render(<Example />);
  fireEvent.click(screen.getByText("Open"));
  const menu = screen.getByRole("menu");
  expect(Number.parseFloat(menu.style.top)).toBeLessThanOrEqual(window.innerHeight - 12);
  expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth - 12);
  unmount();
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function), true);
  expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
  rect.mockRestore();
  remove.mockRestore();
});

test("recalculates anchored menu bounds when the visual viewport shrinks and pans", () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), { width: 400, height: 500, offsetLeft: 20, offsetTop: 80 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const rect = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 500, right: 540, top: 650, bottom: 694, width: 40, height: 44,
  });
  try {
    render(<Example />);
    fireEvent.click(screen.getByText("Open"));
    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe("568px");
    expect(menu.style.left).toBe("408px");
    Object.assign(viewport, { height: 255, offsetTop: 110 });
    fireEvent(viewport, new Event("resize"));
    expect(menu.style.top).toBe("353px");
    expect(menu.style.maxHeight).toBe("231px");
  } finally {
    rect.mockRestore();
    if (descriptor) Object.defineProperty(window, "visualViewport", descriptor);
    else delete window.visualViewport;
  }
});
