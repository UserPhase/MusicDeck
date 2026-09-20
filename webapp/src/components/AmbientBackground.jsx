/**
 * A static atmospheric layer for the glass shell. It deliberately has no
 * relationship to playback, so it never adds work while tracks are changing.
 */
export default function AmbientBackground() {
  return (
    <div className="ambient-background" aria-hidden="true">
      <div className="ambient-background-blob ambient-background-blob-top" />
      <div className="ambient-background-blob ambient-background-blob-bottom" />
    </div>
  );
}
