import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getSystemRecoveryStatus } from "../../api/setupRecovery";
export default function FirstRunSetupNotice() {
  const [firstRun, setFirstRun] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void getSystemRecoveryStatus(controller.signal).then((status) => { if (!controller.signal.aborted) setFirstRun(status.firstRun); }).catch(() => { /* The dashboard remains available if the setup service cannot be reached. */ });
    return () => controller.abort();
  }, []);
  return firstRun ? <aside className="admin-section"><h2>Finish your server setup</h2><p>Check the music server connection, storage permissions, and recovery options.</p><Link to="/admin/setup-recovery">Open Setup & Recovery →</Link></aside> : null;
}
