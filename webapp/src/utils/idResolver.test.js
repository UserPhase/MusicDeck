import { toAlbumRouteIdFromApiId } from "./idResolver";

test.each([
  ["md_album_1", "md_album_1"],
  ["external_deezer_album_42", "external_deezer_album_42"],
  ["deezer_album_42", "external_deezer_album_42"],
  ["itunes_album_15", "external_itunes_album_15"],
  ["extdetail_cached-release", "extdetail_cached-release"],
  ["ext:spotify:record", "external_spotify_album_record"],
])("normalizes album %s for the detail API", (value, expected) => {
  expect(toAlbumRouteIdFromApiId(value)).toBe(expected);
});
