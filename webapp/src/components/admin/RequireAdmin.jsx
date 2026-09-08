import { Navigate, Outlet } from "react-router-dom";

import { useAuth } from "../../context/AuthContext";


/*
 * Guards every /admin/* route.
 *
 * Non-administrators are redirected to the normal MusicDeck experience
 * without unmounting the global player (the player lives above the router
 * outlet, so navigation alone never interrupts playback).
 */
function RequireAdmin() {
  const { session } = useAuth();

  if (session?.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}


export default RequireAdmin;
