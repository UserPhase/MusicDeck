import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import AdminAppearance from "../../pages/admin/AdminAppearance";
import {
  CUSTOM_CSS_SETTING_KEY,
  sanitizeCustomCss,
} from "./CustomCssStyle";
import { getUserSettings, updateUserSettings } from "../../api/musicdeck";


jest.mock("../../api/musicdeck", () => ({
  getUserSettings: jest.fn(),
  updateUserSettings: jest.fn(),
}));

jest.mock("../../context/AuthContext", () => ({
  useAuth: () => ({ session: { id: "a1", username: "admin", role: "admin" } }),
}));


function renderAppearance(route = "/admin/appearance/custom-css") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/admin/appearance/*" element={<AdminAppearance />} />
      </Routes>
    </MemoryRouter>
  );
}


beforeEach(() => {
  jest.clearAllMocks();
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
