import { useCallback, useEffect, useState } from "react";

import {
  getServerSettings,
  updateServerSettings,
} from "../../api/musicdeck";

async function loadAdminData(loaders) {
  const entries = Object.entries(loaders);
  const results = await Promise.allSettled(
    entries.map(([, loader]) => Promise.resolve().then(loader))
  );
  const data = {};
  const errors = [];
  results.forEach((result, index) => {
    const [key] = entries[index];
    if (result.status === "fulfilled") {
      data[key] = result.value;
    } else {
      console.error(`Could not load admin ${key}:`, result.reason);
      errors.push(`${key}: ${result.reason instanceof Error
        ? result.reason.message : "Could not load admin data."}`);
      data[key] = null;
    }
  });
  return { data, error: errors.length ? errors.join(" ") : null };
}

/*
 * Shared loader for admin sub-pages: fetches a set of API functions in
 * parallel and exposes { data, loading, error, saving, message, run, reload }.
 *
 * `loaders` is an object of { key: asyncFn }. Results land in data[key].
 */
export function useAdminData(loaders, deps = []) {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await loadAdminData(loaders);
      setData(result.data);
      setError(result.error);
    } catch (err) {
      setError(err.message || "Could not load admin data.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);

      try {
        const result = await loadAdminData(loaders);

        if (!cancelled) {
          setData(result.data);
          setError(result.error);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Could not load admin data.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  /*
   * Wrap a mutating action with consistent saving/message/error handling.
   */
  async function run(action, { successMessage, errorMessage } = {}) {
    try {
      setSaving(true);
      setMessage("");
      setError(null);
      const result = await action();
      if (successMessage) {
        setMessage(
          typeof successMessage === "function"
            ? successMessage(result)
            : successMessage
        );
      }
      return result;
    } catch (err) {
      setError(err.message || errorMessage || "Action failed.");
      return undefined;
    } finally {
      setSaving(false);
    }
  }

  return {
    data,
    setData,
    loading,
    saving,
    error,
    setError,
    message,
    setMessage,
    run,
    reload: load,
  };
}


export { getServerSettings, updateServerSettings };
