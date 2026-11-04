import { createContext, useContext } from "react";
import type { RemoteSessionValue } from "../types/remoteSession";

export const RemoteSessionContext = createContext<RemoteSessionValue | null>(null);
export const useRemoteControl = () => useContext(RemoteSessionContext);
