import { fireEvent, render, screen } from "@testing-library/react";
import OfflineStatusBanner from "./OfflineStatusBanner";

afterEach(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); });
test("persists offline limitations and clears them only when the browser returns online", () => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  render(<OfflineStatusBanner />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
  fireEvent(window, new Event("offline"));
  expect(screen.getByRole("status")).toHaveTextContent("Offline / Web mode");
  expect(screen.getByRole("status")).toHaveTextContent("Browser storage limits still apply");
  expect(screen.getByRole("link", { name: "Downloads" })).toHaveAttribute("href", "/downloads");
  fireEvent(window, new Event("offline"));
  expect(screen.getByRole("status")).toBeInTheDocument();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  fireEvent(window, new Event("online"));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
