import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AdminAppearance from "../../pages/admin/AdminAppearance";
import {
  CUSTOM_CSS_SETTING_KEY,
  sanitizeCustomCss,
} from "./CustomCssStyle";
import { getPublicConfig, getUserSettings, updateAppConfig, updateUserSettings } from "../../api/musicdeck";
import { BrandingProvider } from "../../context/BrandingContext";


jest.mock("../../api/musicdeck", () => ({
  getPublicConfig: jest.fn(),
  getUserSettings: jest.fn(),
  updateAppConfig: jest.fn(),
  updateUserSettings: jest.fn(),
}));

jest.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ session: { id: "a1", username: "admin", role: "admin" } }),
}));


function renderAppearance(route = "/admin/appearance/custom-css") {
  return render(
    <BrandingProvider>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/admin/appearance/*" element={<AdminAppearance />} />
        </Routes>
      </MemoryRouter>
    </BrandingProvider>
  );
}


beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  getPublicConfig.mockResolvedValue({ appName: "MusicDeck" });
  getUserSettings.mockResolvedValue([]);
  updateUserSettings.mockResolvedValue([]);
});


describe("sanitizeCustomCss", () => {
  test("keeps safe rules intact", () => {
    const css = ":root { --accent: #1db954; }\n.track { color: red; }";
    expect(sanitizeCustomCss(css)).toBe(css);
  });

  test("strips rules that hide the player", () => {
    const css = ".player { display: none; }";
    const result = sanitizeCustomCss(css);
    expect(result).not.toMatch(/display\s*:\s*none/i);
    expect(result).toMatch(/blocked unsafe rule/);
  });

  test("strips rules that hide the admin sidebar", () => {
    const css = ".admin-sidebar { visibility: hidden; }";
    const result = sanitizeCustomCss(css);
    expect(result).not.toMatch(/visibility\s*:\s*hidden/i);
  });

  test("strips @import statements", () => {
    const css = '@import url("https://evil.example/x.css");';
    const result = sanitizeCustomCss(css);
    expect(result).not.toMatch(/@import\s+url/i);
  });
});


describe("Appearance custom CSS page", () => {
  test("renders the CSS editor with Preview, Save and Reset", async () => {
    renderAppearance();

    expect(
      await screen.findByRole("textbox", { name: /custom css/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /preview/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /reset to default/i })
    ).toBeInTheDocument();
  });

  test("saves sanitized CSS through the user settings API", async () => {
    getUserSettings.mockResolvedValue([
      { key: CUSTOM_CSS_SETTING_KEY, value: JSON.stringify(":root { --accent: #123456; }") },
    ]);

    renderAppearance();

    const editor = await screen.findByRole("textbox", { name: /custom css/i });
    await waitFor(() => expect(editor).toHaveValue(":root { --accent: #123456; }"));

    fireEvent.change(editor, { target: { value: ".track { color: red; }" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(updateUserSettings).toHaveBeenCalledWith({
        [CUSTOM_CSS_SETTING_KEY]: ".track { color: red; }",
      })
    );
  });

  test("reset clears the saved CSS after confirmation", async () => {
    window.confirm = jest.fn(() => true);
    getUserSettings.mockResolvedValue([
      { key: CUSTOM_CSS_SETTING_KEY, value: JSON.stringify(".track { color: red; }") },
    ]);

    renderAppearance();

    await screen.findByRole("textbox", { name: /custom css/i });
    fireEvent.click(screen.getByRole("button", { name: /reset to default/i }));

    await waitFor(() =>
      expect(updateUserSettings).toHaveBeenCalledWith({
        [CUSTOM_CSS_SETTING_KEY]: "",
      })
    );
  });
});


describe("Appearance navigation and branding", () => {
  test("only offers the Overview, Branding and Custom CSS sections", async () => {
    renderAppearance("/admin/appearance");

    const nav = screen.getByRole("navigation", { name: /appearance sections/i });
    const tabs = Array.from(nav.querySelectorAll("a")).map((link) => link.textContent);
    expect(tabs).toEqual(["Overview", "Branding", "Custom CSS"]);
    expect(screen.queryByRole("link", { name: /^themes$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^layout$/i })).not.toBeInTheDocument();
  });

  test("retired section URLs fall back to the overview", async () => {
    renderAppearance("/admin/appearance/themes");

    expect(await screen.findByRole("heading", { name: /^appearance$/i, level: 2 })).toBeInTheDocument();
  });

  test("saves the application name and applies it immediately", async () => {
    updateAppConfig.mockResolvedValue({ appName: "Basement FM" });
    renderAppearance("/admin/appearance/branding");

    const input = await screen.findByRole("textbox", { name: /application name/i });
    await waitFor(() => expect(input).toHaveValue("MusicDeck"));
    expect(
      screen.getByText("This name will appear in the sidebar logo, header, and browser window title.")
    ).toBeInTheDocument();

    const save = screen.getByRole("button", { name: /^save$/i });
    expect(save).toBeDisabled();

    fireEvent.change(input, { target: { value: "  Basement FM " } });
    fireEvent.click(save);

    await waitFor(() => expect(updateAppConfig).toHaveBeenCalledWith({ appName: "Basement FM" }));
    expect(await screen.findByText(/application name saved/i)).toBeInTheDocument();
    expect(document.title).toBe("Basement FM");
    expect(input).toHaveValue("Basement FM");
  });

  test("blocks empty names and reports save errors", async () => {
    updateAppConfig.mockRejectedValue(new Error("Application name must be 1-40 characters"));
    renderAppearance("/admin/appearance/branding");

    const input = await screen.findByRole("textbox", { name: /application name/i });
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: /^save$/i })).toBeDisabled();
    expect(input).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(input, { target: { value: "Deck" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/1-40 characters/);
    expect(document.title).toBe("MusicDeck");
  });
});