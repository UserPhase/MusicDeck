import { request } from "./musicdeck";
import { discoverExtensions, getExtensions, setExtensionEnabled } from "./extensions";
jest.mock("./musicdeck", () => ({ request: jest.fn() }));
const fetchRequest = jest.mocked(request);
const extension = { apiVersion: 1, id: "sonic", name: "Sonic", version: "1", description: "", entry: "index.mjs",
  enabled: false, status: "disabled", error: null };
beforeEach(() => jest.clearAllMocks());
test("uses the authenticated API boundary and validates inventory/update responses", async () => {
  fetchRequest.mockResolvedValue({ extensions: [extension], issues: [] });
  expect(await getExtensions()).toEqual({ extensions: [extension], issues: [] });
  expect(fetchRequest).toHaveBeenCalledWith("/api/v1/admin/extensions");
  await discoverExtensions();
  expect(fetchRequest).toHaveBeenLastCalledWith("/api/v1/admin/extensions/discover", { method: "POST" });
  fetchRequest.mockResolvedValue({ extension: { ...extension, enabled: true, status: "enabled" } });
  await setExtensionEnabled("sonic/module", true);
  expect(fetchRequest).toHaveBeenLastCalledWith("/api/v1/admin/extensions/sonic%2Fmodule", { method: "PATCH", body: '{"enabled":true}' });
});
test("malformed responses never masquerade as empty success", async () => {
  for (const response of [{}, { extensions: [], issues: "bad" }, { extensions: [{ ...extension, enabled: "yes" }], issues: [] }]) {
    fetchRequest.mockResolvedValueOnce(response);
    await expect(getExtensions()).rejects.toThrow("invalid extension inventory");
  }
  fetchRequest.mockResolvedValueOnce({ extension: null });
  await expect(setExtensionEnabled("sonic", false)).rejects.toThrow("invalid extension update");
});
