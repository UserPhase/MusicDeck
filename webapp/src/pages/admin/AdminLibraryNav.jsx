import { NavLink } from "react-router-dom";


const LIBRARY_SECTIONS = [
  {
    to: "/admin/library",
    end: true,
    title: "Overview",
    description: "Track, album and artist counts at a glance.",
  },
  {
    to: "/admin/library/tracks",
    title: "Tracks",
    description: "Browse every track indexed in the library.",
  },
  {
    to: "/admin/library/albums",
    title: "Albums",
    description: "Browse every album indexed in the library.",
  },
  {
    to: "/admin/library/artists",
    title: "Artists",
    description: "Browse every artist indexed in the library.",
  },
  {
    to: "/admin/library/health",
    title: "Health",
    description: "Missing files, broken references and scan status.",
  },
  {
    to: "/admin/library/duplicates",
    title: "Duplicates",
    description: "Find tracks that appear multiple times.",
  },
  {
    to: "/admin/library/metadata",
    title: "Metadata",
    description: "Tracks with missing or incomplete metadata.",
  },
  {
    to: "/admin/library/scan",
    title: "Scan",
    description: "Trigger a library rescan after adding files.",
  },
];


export function AdminLibraryNav() {
  return (
    <nav className="admin-subnav" aria-label="Library sections">
      {LIBRARY_SECTIONS.map((section) => (
        <NavLink
          key={section.to + section.title}
          to={section.to}
          end={section.end}
          className={({ isActive }) =>
            `admin-subnav-item${isActive ? " active" : ""}`
          }
        >
          {section.title}
        </NavLink>
      ))}
    </nav>
  );
}


export default LIBRARY_SECTIONS;
