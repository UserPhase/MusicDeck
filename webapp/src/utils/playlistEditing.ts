/** Insert a selected block at an original-array boundary, preserving selected order. */
export function reorderPlaylistEntries(
  itemIds: readonly string[], selectedIds: ReadonlySet<string>, targetIndex: number,
): string[] {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > itemIds.length) {
    throw new RangeError("Invalid playlist drop position.");
  }
  const selected: string[] = [];
  const remaining: string[] = [];
  let insertion = 0;
  itemIds.forEach((id, index) => {
    if (selectedIds.has(id)) selected.push(id);
    else {
      if (index < targetIndex) insertion++;
      remaining.push(id);
    }
  });
  return [...remaining.slice(0, insertion), ...selected, ...remaining.slice(insertion)];
}
