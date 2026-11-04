import { useEffect, useRef, useState } from "react";

export default function useLibraryScan({ getScan, startScan, disabled, parameters }) {
  const [scan, setScan] = useState(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const active = ["discovering", "running"].includes(scan?.status);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const current = await getScan(controller.signal);
        if (controller.signal.aborted) return;
        setScan(current); setError("");
        if (["discovering", "running"].includes(current?.status)) timer = setTimeout(refresh, 2000);
      } catch {
        if (!controller.signal.aborted) {
          setError("Could not check scan progress. Reopen Settings to reconnect.");
          timer = setTimeout(refresh, 10000);
        }
      }
    }
    refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [getScan, scan?.id]);
  async function start() {
    if (disabled || starting || active) return;
    setStarting(true); setError("");
    try { const result = await startScan(parameters); if (mounted.current) setScan(result); }
    catch (err) { if (mounted.current) setError(err.message?.includes("already running") ? err.message : "Could not start the library scan. Please try again."); }
    finally { if (mounted.current) setStarting(false); }
  }
  return { scan, starting, active, error, start };
}
