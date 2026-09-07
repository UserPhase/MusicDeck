import { render, screen } from "@testing-library/react";
import App from "./App";

beforeEach(() => {
  localStorage.clear();
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        authenticated: false,
        user: null,
      }),
    })
  );
});

test("renders the MusicDeck login screen when unauthenticated", async () => {
  render(<App />);

  expect(
    await screen.findByRole("heading", {
      name: /welcome back/i,
    })
  ).toBeInTheDocument();
});
