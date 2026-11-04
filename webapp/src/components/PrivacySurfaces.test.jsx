import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Explore from "../pages/Explore";
import ExternalAlbumCard from "./ExternalAlbumCard";
import TrackDownloadButton from "./TrackDownloadButton";
import { createExternalActions } from "../services/externalActions";
import { getExplore, getRecommendations, getPersonalizedDiscovery } from "../api/musicdeck";
import { externalDiscoveryService } from "../services/externalDiscovery";

jest.mock("../context/PrivacyContext", () => ({
  usePrivacy: () => ({ canMetadata: false, canImport: false, canArtwork: false, policy: { localOnly: true } }),
}));
jest.mock("../hooks/useAlbumArtwork", () => ({ useAlbumArtwork: () => ({ url: null, onError: () => {} }) }));
jest.mock("../api/musicdeck", () => ({
  ...jest.requireActual("../api/musicdeck"), getExplore: jest.fn(), getRecommendations: jest.fn(), getPersonalizedDiscovery: jest.fn(),
}));
jest.mock("../services/externalDiscovery", () => ({
  externalDiscoveryService: { charts: jest.fn(), genres: jest.fn(), genre: jest.fn(), previews: jest.fn() },
}));

test("Local-Only Explore replaces its remote shelves without starting discovery requests", async () => {
  await act(async () => { render(<MemoryRouter><Explore /></MemoryRouter>); });
  expect(screen.getByRole("status")).toHaveTextContent("Local-Only Mode Enabled. Outbound metadata services are offline.");
  expect(screen.getByRole("link", { name: "Browse your local albums" })).toHaveAttribute("href", "/albums");
  expect(getExplore).not.toHaveBeenCalled();
  expect(getRecommendations).not.toHaveBeenCalled();
  expect(getPersonalizedDiscovery).not.toHaveBeenCalled();
  for (const operation of Object.values(externalDiscoveryService)) expect(operation).not.toHaveBeenCalled();
});

test("external album controls cannot play previews or import while disabled", async () => {
  const create = jest.fn();
  const onPlay = jest.fn();
  const actions = createExternalActions({ create, list: async () => [], get: jest.fn(), isOnline: () => true });
  await act(async () => { render(<MemoryRouter><ExternalAlbumCard
    album={{ id: "external_deezer_album_7", title: "Night Drive", artist: "Neon", provider: "deezer", external: true }}
    actions={actions} onPlay={onPlay} /></MemoryRouter>); });
  expect(screen.queryByRole("button", { name: /Add to Library|Play Night Drive/i })).not.toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  expect(onPlay).not.toHaveBeenCalled();
});

test("legacy track import buttons disappear without removing local availability indicators", () => {
  const view = render(<TrackDownloadButton song={{ id: "external_deezer_track_7", title: "Track", source: { kind: "external" } }} />);
  expect(view.container).toBeEmptyDOMElement();
  view.rerender(<TrackDownloadButton song={{ id: "local-7", title: "Local Track", source: { kind: "library" } }} />);
  expect(screen.getByRole("img", { name: "Local Track already downloaded" })).toBeInTheDocument();
});
