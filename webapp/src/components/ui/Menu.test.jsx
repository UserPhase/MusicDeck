import { fireEvent, render, screen } from "@testing-library/react";

import Menu, { MenuItem } from "./Menu";


test("menu opens, selects, and returns focus on Escape", () => {
  const onSelect = jest.fn();

  render(
    <Menu label="More options" title="Actions">
      {({ close }) => (
        <MenuItem
          onSelect={() => {
            onSelect();
            close();
          }}
        >
          Play
        </MenuItem>
      )}
    </Menu>
  );

  const toggle = screen.getByRole("button", { name: "More options" });

  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);

  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("menu", { name: "Actions" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("menuitem", { name: "Play" }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();

  fireEvent.click(toggle);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(toggle).toHaveFocus();
});
