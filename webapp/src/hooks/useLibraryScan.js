import { useEffect, useRef, useState } from "react";
import { useVisualActivity } from "./useVisualActivity";

export default function useLibraryScan({ getScan, startScan, disabled, parameters }) {
  const [scan, setScan] = useState(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [statusError, setStatusError] = useState("");
  const mounted = useRef(true);
  const visualActive = useVisualActivity();
  const active = ["discovering", "running"].includes(scan?.status);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!visualActive) return;
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const current = await getScan(controller.signal);
        if (controller.signal.aborted) return;
        setScan(current); setStatusError("");
        if (["discovering", "running"].includes(current?.status)) timer = setTimeout(refresh, 2000);
      } catch (err) {
        if (!controller.signal.aborted) {
          setStatusError((err?.status && err.message) || "Could not check scan progress. Reopen Settings to reconnect.");
          timer = setTimeout(refresh, 10000);
        }
      }
    }
    refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [getScan, scan?.id, visualActive]);
  async function start() {
    if (disabled || starting || active) return;
    setStarting(true); setStartError("");
    try { const result = await startScan(parameters); if (mounted.current) setScan(result); }
    catch (err) {
      if (mounted.current) {
        const message = err?.status || err?.message?.includes("already running") ? err.message : "";
        setStartError(message || "Could not start the library scan. Please try again.");
      }
    }
    finally { if (mounted.current) setStarting(false); }
  }
  return { scan, starting, active, error: startError || statusError, start };
}
