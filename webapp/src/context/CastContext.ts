import { createContext, useContext } from "react";
import type { CastState } from "../services/cast/CastManager";

export interface CastControl extends CastState {
  supported: boolean; allowed: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
export const CastContext = createContext<CastControl | null>(null);
export const useCast = () => useContext(CastContext);
