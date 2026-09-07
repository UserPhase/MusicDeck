import {
  getCurrentSession,
  logout,
} from "./musicdeck";


export async function getAuthSession() {
  const session = await getCurrentSession();
  return session.authenticated ? session.user : null;
}


export function setAuthSession() {
  throw new Error("MusicDeck sessions are managed by the server");
}


export async function clearAuthSession() {
  await logout();
}


export async function isAuthenticated() {
  return (await getAuthSession()) !== null;
}

