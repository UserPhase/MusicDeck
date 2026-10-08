import { render, screen, waitFor } from "@testing-library/react";

import { BrandingProvider, BrandWordmark, splitBrandName } from "./BrandingContext";
import { getPublicConfig } from "../api/musicdeck";

jest.mock("../api/musicdeck", () => ({
  getPublicConfig: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  document.title = "";
});

describe("splitBrandName", () => {
  test.each([
    ["MusicDeck", ["Music", "Deck"]],
    ["Basement FM", ["Basement ", "FM"]],
    ["sonic", ["sonic", ""]],
    ["ABC", ["ABC", ""]],
  ])("splits %s", (name, expected) => {
    expect(splitBrandName(name)).toEqual(expected);
  });
});

describe("BrandingProvider", () => {
  test("applies the server app name to the wordmark, title and cache", async () => {
    getPublicConfig.mockResolvedValue({ appName: "Basement FM" });

    render(<BrandingProvider><h1><BrandWordmark /></h1></BrandingProvider>);

    await waitFor(() => expect(screen.getByRole("heading")).toHaveTextContent("Basement FM"));
    expect(document.title).toBe("Basement FM");
    expect(localStorage.getItem("musicdeckAppName")).toBe("Basement FM");
  });

  test("keeps the cached name when the config endpoint fails", async () => {
    localStorage.setItem("musicdeckAppName", "Cached Deck");
    getPublicConfig.mockRejectedValue(new Error("offline"));

    render(<BrandingProvider><h1><BrandWordmark /></h1></BrandingProvider>);

    await waitFor(() => expect(getPublicConfig).toHaveBeenCalled());
    expect(screen.getByRole("heading")).toHaveTextContent("Cached Deck");
    expect(document.title).toBe("Cached Deck");
  });

  test("falls back to MusicDeck for blank names", async () => {
    getPublicConfig.mockResolvedValue({ appName: "   " });

    render(<BrandingProvider><h1><BrandWordmark /></h1></BrandingProvider>);

    await waitFor(() => expect(getPublicConfig).toHaveBeenCalled());
    expect(screen.getByRole("heading")).toHaveTextContent("MusicDeck");
    expect(document.title).toBe("MusicDeck");
  });
});
