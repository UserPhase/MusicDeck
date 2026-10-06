import { isDefaultPlaceholder } from "./placeholderDetector";

test.each([
  "al-0", "ar-0", "default-cover", "default_avatar",
  "/images/placeholder.png", "/album-placeholder.svg",
  "/api/artwork/al-0?size=300", "/rest/getCoverArt.view?id=al-0",
  "/api/artwork/%61l-0", "https://server.test/placeholder/album.png",
])("recognizes the placeholder reference %s", (value) => {
  expect(isDefaultPlaceholder(value)).toBe(true);
});

test.each([null, "", "al-0123", "mdart_abc", "/api/artwork/al-123",
  "https://cdn.test/real-cover.jpg", "https://cdn.test/album-called-placeholder.jpg"])(
  "does not guess that %s is a placeholder", (value) => {
    expect(isDefaultPlaceholder(value)).toBe(false);
  }
);
