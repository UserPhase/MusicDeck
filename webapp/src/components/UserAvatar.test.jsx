import { fireEvent, render } from "@testing-library/react";

import UserAvatar from "./UserAvatar";

test("renders initials when the user has no uploaded avatar", () => {
  const { container } = render(<UserAvatar user={{ displayName: "Sam" }} />);
  expect(container.querySelector(".avatar")).toHaveTextContent("SA");
  expect(container.querySelector("img")).toBeNull();
});

test("renders the uploaded photo and falls back to initials if it fails to load", () => {
  const user = { displayName: "Sam", avatarUrl: "/api/users/u1/avatar?v=1" };
  const { container, rerender } = render(<UserAvatar user={user} />);

  const img = container.querySelector("img");
  expect(img).toHaveAttribute("src", user.avatarUrl);

  fireEvent.error(img);
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".avatar")).toHaveTextContent("SA");

  // A new upload yields a new versioned URL, which retries the photo.
  rerender(<UserAvatar user={{ ...user, avatarUrl: "/api/users/u1/avatar?v=2" }} />);
  expect(container.querySelector("img")).toHaveAttribute("src", "/api/users/u1/avatar?v=2");
});
