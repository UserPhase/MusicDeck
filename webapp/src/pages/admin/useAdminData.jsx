import { useCallback, useEffect, useState } from "react";

import {
  getServerSettings,
  updateServerSettings,
} from "../../api/musicdeck";


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
      const entries = await Promise.all(
        Object.entries(loaders).map(async ([key, fn]) => [
          key,
          await Promise.resolve()
            .then(fn)
            .catch(() => null),
        ])
      );

      setData(Object.fromEntries(entries));
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
        const entries = await Promise.all(
          Object.entries(loaders).map(async ([key, fn]) => [
            key,
            await Promise.resolve()
              .then(fn)
              .catch(() => null),
          ])
        );

        if (!cancelled) {
          setData(Object.fromEntries(entries));
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
