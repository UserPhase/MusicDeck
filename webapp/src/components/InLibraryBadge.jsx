export default function InLibraryBadge({ visible }) {
  if (!visible) return null;
  return <span className="in-library-badge" aria-label="In your library">In Library</span>;
}
