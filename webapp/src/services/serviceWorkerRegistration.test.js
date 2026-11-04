import { registerServiceWorker, sendCachePolicy } from "./serviceWorkerRegistration";

const environment = process.env.NODE_ENV;
const publicUrl = process.env.PUBLIC_URL;
beforeEach(() => {
  process.env.NODE_ENV = "production";
  process.env.PUBLIC_URL = "";
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
});
afterEach(() => {
  process.env.NODE_ENV = environment;
  if (publicUrl === undefined) delete process.env.PUBLIC_URL;
  else process.env.PUBLIC_URL = publicUrl;
  delete navigator.serviceWorker;
  jest.restoreAllMocks();
});
test("registers the production worker at the normalized application scope", async () => {
  const registration = {};
  const register = jest.fn(async () => registration);
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
  process.env.PUBLIC_URL = "/music/";
  await expect(registerServiceWorker()).resolves.toBe(registration);
  expect(register).toHaveBeenCalledWith("http://localhost/music/service-worker.js", { scope: "/music/" });
});
test("does not register on insecure origins or in development", async () => {
  const register = jest.fn();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
  process.env.NODE_ENV = "development";
  await expect(registerServiceWorker()).resolves.toBeNull();
  process.env.NODE_ENV = "production";
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
  await expect(registerServiceWorker()).resolves.toBeNull();
  expect(register).not.toHaveBeenCalled();
});
test("reports registration failures and rejects cross-origin worker locations before transport", async () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const register = jest.fn(async () => { throw new Error("Storage denied"); });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
  const failure = jest.fn();
  window.addEventListener("musicdeck:service-worker-error", failure);
  try {
    await expect(registerServiceWorker()).resolves.toBeNull();
    expect(failure).toHaveBeenCalledTimes(1);
    process.env.PUBLIC_URL = "https://other.invalid/";
    await expect(registerServiceWorker()).resolves.toBeNull();
    expect(register).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(2);
  } finally { window.removeEventListener("musicdeck:service-worker-error", failure); }
});
test("sends authenticated account and privacy mode without storing credentials", () => {
  const postMessage = jest.fn();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: { postMessage } } });
  sendCachePolicy("user-1", false, false);
  expect(postMessage).toHaveBeenCalledWith({ type: "MUSICDECK_CACHE_POLICY", owner: "user-1", externalArtwork: false, metadata: false });
});
