import Tracks from "../Tracks";
import Albums from "../Albums";
import Artists from "../Artists";
import { AdminLibraryNav } from "./AdminLibraryNav";


function AdminLibraryPage({ title, children }) {
  return (
    <div className="admin-page">
      <div className="account-header">
        <div>
          <div className="account-label">ADMIN · LIBRARY</div>
          <h1>{title}</h1>
        </div>
      </div>

      <AdminLibraryNav />

      <section className="admin-section">{children}</section>
    </div>
  );
}


export function AdminLibraryTracks() {
  return (
    <AdminLibraryPage title="Tracks">
      <Tracks />
    </AdminLibraryPage>
  );
}

export function AdminLibraryAlbums() {
  return (
    <AdminLibraryPage title="Albums">
      <Albums />
    </AdminLibraryPage>
  );
}

export function AdminLibraryArtists() {
  return (
    <AdminLibraryPage title="Artists">
      <Artists />
    </AdminLibraryPage>
  );
}
