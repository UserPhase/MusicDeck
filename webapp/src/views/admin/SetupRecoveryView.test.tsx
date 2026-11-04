import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SetupRecoveryView from "./SetupRecoveryView";
import { createSystemBackup, getSystemRecoveryStatus, restoreSystemBackup, runSystemDiagnostics, saveSystemConfiguration, updateDailyBackupPolicy } from "../../api/setupRecovery";
jest.mock("../../api/setupRecovery", () => ({ ...jest.requireActual("../../api/setupRecovery"), getSystemRecoveryStatus: jest.fn(), runSystemDiagnostics: jest.fn(), createSystemBackup: jest.fn(), saveSystemConfiguration: jest.fn(), restoreSystemBackup: jest.fn(), updateDailyBackupPolicy: jest.fn() }));
const status = { configuration: { version: 1, backend: "navidrome", navidrome: { url: "http://navidrome:4533", username: "music", passwordSet: true }, jellyfin: { url: "http://jellyfin:8096", apiKeySet: false }, musicRoot: "/music", acquisitionTmpDir: "/data/staging" }, firstRun: true, restartSupported: true, backupDaily: false, operation: { state: "idle", message: "Ready" }, backups: [], limits: { uploadBytes: 256 * 1024 * 1024 }, mediaIncluded: false };
function mount() { return render(<MemoryRouter><SetupRecoveryView /></MemoryRouter>); }
beforeEach(() => { jest.clearAllMocks(); (getSystemRecoveryStatus as jest.Mock).mockResolvedValue(status); });
test("renders first-run configuration without disclosing saved secrets", async () => {
  mount(); await screen.findByLabelText("Navidrome password");
  expect(screen.getByText(/First-run setup/)).toBeInTheDocument();
  expect(screen.getByLabelText("Navidrome password")).toHaveValue("");
  expect(screen.getByLabelText("Navidrome URL")).toHaveValue("http://navidrome:4533");
});
test("renders health failures with actionable remediation", async () => {
  (runSystemDiagnostics as jest.Mock).mockResolvedValue({ report: { ready: false, status: "fail", checkedAt: "2026-11-01", checks: [{ id: "storage", title: "Artwork directory", status: "fail", message: "/data/artwork is read-only", fix: "Mount the directory with write permission for the service user.", durationMs: 12 }] } });
  mount(); fireEvent.click(await screen.findByRole("button", { name: /02 Check health/ }));
  fireEvent.click(screen.getByRole("button", { name: "Run health diagnostics" }));
  expect(await screen.findByText("/data/artwork is read-only")).toBeInTheDocument();
  expect(screen.getByText("Mount the directory with write permission for the service user.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Complete setup/ })).toBeDisabled();
});
test("creates a backup and displays its authenticated archive link", async () => {
  const backup = { id: "backup-1", filename: "system-backup.tar.gz", kind: "system", bytes: 1000, createdAt: "2026-11-01T10:00:00Z" };
  (createSystemBackup as jest.Mock).mockResolvedValue({ backup });
  mount(); await screen.findByLabelText("Navidrome URL"); fireEvent.click(screen.getByRole("button", { name: /03 Protect/ }));
  (getSystemRecoveryStatus as jest.Mock).mockResolvedValue({ ...status, backups: [backup] });
  fireEvent.click(screen.getByRole("button", { name: "Create System Backup" }));
  expect(await screen.findByRole("link", { name: /Download archive/ })).toHaveAttribute("href", "/api/v1/admin/system/backups/backup-1");
  expect(createSystemBackup).toHaveBeenCalledTimes(1);
});
test("never submits a restore until the selected file and replacement acknowledgment are confirmed", async () => {
  (restoreSystemBackup as jest.Mock).mockResolvedValue({ accepted: true });
  mount(); await screen.findByLabelText("Navidrome URL"); fireEvent.click(screen.getByRole("button", { name: /03 Protect/ }));
  const file = new File(["archive"], "system.tar.gz", { type: "application/gzip" });
  fireEvent.change(screen.getByLabelText("Backup file"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Restore from Backup File" }));
  const dialog = screen.getByRole("alertdialog"); expect(restoreSystemBackup).not.toHaveBeenCalled();
  expect(within(dialog).getByRole("button", { name: "Validate & restore backup" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Validate & restore backup" }));
  await waitFor(() => expect(restoreSystemBackup).toHaveBeenCalledWith(file));
  expect(await screen.findByText(/The server is restarting/)).toBeInTheDocument();
});
test("surfaces backup errors and allows another attempt", async () => {
  (createSystemBackup as jest.Mock).mockRejectedValue(new Error("Not enough free space for a system backup."));
  mount(); await screen.findByLabelText("Navidrome URL"); fireEvent.click(screen.getByRole("button", { name: /03 Protect/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create System Backup" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Not enough free space");
  expect(screen.getByRole("button", { name: "Create System Backup" })).toBeEnabled();
});
test("saves daily backup policy from the recovery controls", async () => {
  (updateDailyBackupPolicy as jest.Mock).mockResolvedValue({ daily: true });
  mount(); await screen.findByLabelText("Navidrome URL"); fireEvent.click(screen.getByRole("button", { name: /03 Protect/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Create a backup daily/ }));
  await waitFor(() => expect(updateDailyBackupPolicy).toHaveBeenCalledWith(true));
});
test("saves new backend credentials only when the administrator requests a configuration restart", async () => {
  (saveSystemConfiguration as jest.Mock).mockResolvedValue({ accepted: true });
  mount(); const password = await screen.findByLabelText("Navidrome password");
  fireEvent.change(password, { target: { value: "new-backend-secret" } });
  expect(saveSystemConfiguration).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Save & restart server" }));
  await waitFor(() => expect(saveSystemConfiguration).toHaveBeenCalledWith(expect.objectContaining({ navidrome: expect.objectContaining({ password: "new-backend-secret" }) })));
  expect(await screen.findByText(/The server is restarting/)).toBeInTheDocument();
});
