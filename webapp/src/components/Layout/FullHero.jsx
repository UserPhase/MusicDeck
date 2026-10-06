import { useAlbumArtwork } from "../../hooks/useAlbumArtwork";

export function HeroArtwork({ entity, className = "", width = 230, height = 230 }) {
  const { url, onError } = useAlbumArtwork(entity);
  return (
    <div className={className}>
      {url ? <img src={url} onError={onError} width={width} height={height}
        alt={`${entity?.name || entity?.title || "Album"} cover`} />
        : <span className="explore-artwork-fallback" aria-label="Artwork unavailable">&#9835;</span>}
    </div>
  );
}

function FullHero({
  artwork,
  entity,
  eyebrow,
  title,
  metadata,
  actions,
  className = "",
}) {
  return (
    <section className={`full-hero ${className}`.trim()}>
      <div className="full-hero-artwork">{artwork || (entity && <HeroArtwork entity={entity} />)}</div>
      <div className="full-hero-copy">
        <p className="full-hero-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {metadata && <div className="full-hero-metadata">{metadata}</div>}
        {actions && <div className="full-hero-actions">{actions}</div>}
      </div>
    </section>
  );
}

export default FullHero;
