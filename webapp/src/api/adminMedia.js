async function remove(path) {
  const response = await fetch(path, { method: "DELETE", credentials: "include" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Could not delete the file from the server.");
  return data;
}

export const deleteServerTrack = (trackId) => remove(`/api/v1/admin/tracks/${encodeURIComponent(trackId)}`);
export const deleteServerAlbum = (albumId) => remove(`/api/v1/admin/albums/${encodeURIComponent(albumId)}`);
