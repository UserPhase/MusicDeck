import {
  clearAuthSession,
  getAuthSession,
  isAuthenticated,
  setAuthSession,
} from "./session";

import {
  getCurrentSession,
  logout,
} from "./musicdeck";


jest.mock("./musicdeck", () => ({
  getCurrentSession: jest.fn(),
  logout: jest.fn(),
}));


const session = {
  id: "user-1",
  username: "test-user",
  displayName: "Test User",
  role: "user",
};


beforeEach(() => {
  jest.clearAllMocks();
});


test("reads the current authenticated server session", async () => {
  getCurrentSession.mockResolvedValue({
    authenticated: true,
    user: session,
  });

  await expect(getAuthSession()).resolves.toEqual(session);
  await expect(isAuthenticated()).resolves.toBe(true);
});


test("returns null when the server has no authenticated session", async () => {
  getCurrentSession.mockResolvedValue({
    authenticated: false,
    user: null,
  });

  await expect(getAuthSession()).resolves.toBeNull();
  await expect(isAuthenticated()).resolves.toBe(false);
});


test("clears the server session", async () => {
  logout.mockResolvedValue(undefined);

  await clearAuthSession();

  expect(logout).toHaveBeenCalledTimes(1);
});


test("throws if code attempts to set a browser session directly", () => {
  expect(() => setAuthSession(session)).toThrow(
    "MusicDeck sessions are managed by the server"
  );
});
