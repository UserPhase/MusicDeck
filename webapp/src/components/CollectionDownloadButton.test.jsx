import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import CollectionDownloadButton from "./CollectionDownloadButton";

const mockDownloadToDevice = jest.fn();

jest.mock("../utils/downloadManager", () => ({
  downloadToDevice: (...args) => mockDownloadToDevice(...args),
}));

beforeEach(() => {
  mockDownloadToDevice.mockReset();
  mockDownloadToDevice.mockResolvedValue({});
});

test("downloads every server-available track at the selected quality", async () => {
  render(
    <CollectionDownloadButton
      tracks={[
        { id: "one", isDownloaded: true },
        { id: "two", availability: { libraryAvailable: true } },
        { id: "external", isDownloaded: false },
      ]}
      quality="lossless"
      label="playlist"
    />
  );

  fireEvent.click(screen.getByRole("button", { name: "Download playlist to this device" }));

  await waitFor(() => {
    expect(mockDownloadToDevice).toHaveBeenNthCalledWith(1, "one", "lossless");
    expect(mockDownloadToDevice).toHaveBeenNthCalledWith(2, "two", "lossless");
    expect(screen.getByRole("button", { name: "playlist downloaded to this device" }))
      .toBeInTheDocument();
  });
});
