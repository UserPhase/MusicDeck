import { act, renderHook, waitFor } from "@testing-library/react";
import { inspectAudioStream } from "../api/musicdeck";
import { useStreamQualityDetails } from "./useStreamQualityDetails";

jest.mock("../api/musicdeck", () => ({ inspectAudioStream: jest.fn() }));
const inspect = jest.mocked(inspectAudioStream);
const props = { engine: null, trackId: "song", userId: "user", streamUrl: "/api/tracks/song/stream?inspectionId=first", preview: false, serverNormalized: false };
beforeEach(() => { inspect.mockReset(); });
test("correlates each source/account and ignores late responses from rapid track changes", async () => {
  let resolve!: (value: unknown) => void;
  inspect.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const { result, rerender, unmount } = renderHook(useStreamQualityDetails, { initialProps: props });
  const firstSignal = inspect.mock.calls[0][2] as AbortSignal;
  inspect.mockResolvedValueOnce({ source: { codec: "MP3" }, output: null, delivery: null });
  rerender({ ...props, userId: "other", trackId: "next", streamUrl: "/api/tracks/next/stream?inspectionId=second" });
  await waitFor(() => expect(result.current.source?.codec).toBe("MP3"));
  expect(firstSignal.aborted).toBe(true);
  await act(async () => { resolve({ source: { codec: "FLAC" }, output: null, delivery: null }); });
  expect(result.current.source?.codec).toBe("MP3");
  expect(inspect).toHaveBeenLastCalledWith("next", "second", expect.any(AbortSignal));
  unmount();
});
test("does not inspect previews or separate normalized files as library streams", async () => {
  const { result, rerender } = renderHook(useStreamQualityDetails, { initialProps: { ...props, preview: true, streamUrl: "https://preview.invalid/file.mp3" } });
  expect(inspect).not.toHaveBeenCalled();
  expect(result.current.note).toMatch(/preview/);
  rerender({ ...props, preview: false, serverNormalized: true, streamUrl: "/api/normalized/song" });
  expect(inspect).not.toHaveBeenCalled();
  expect(result.current.note).toMatch(/separate processed/);
});
test("exposes network failures instead of presenting source metadata as verified output", async () => {
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  inspect.mockRejectedValueOnce(new Error("Inspection offline"));
  const { result } = renderHook(useStreamQualityDetails, { initialProps: props });
  await waitFor(() => expect(result.current.error).toBe("Inspection offline"));
  expect(result.current.output).toBeNull();
  log.mockRestore();
});
