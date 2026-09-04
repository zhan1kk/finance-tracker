"use client";

import { useState } from "react";
import { downloadFile } from "./api";

/**
 * Runs an authenticated file download, tracking whether it is in flight and
 * catching a failure so the page can say something.
 *
 * The call sites were `void downloadFile(...)`, which throws the promise away:
 * a slow export looked exactly like a button that had done nothing — inviting
 * a second click and a second full export — and one that failed said nothing
 * at all. A whole-account export is the last thing that should fail quietly.
 */
export function useDownload() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const start = (path: string, filename: string) => {
    setError(null);
    setPending(true);
    downloadFile(path, filename)
      .catch(setError)
      .finally(() => setPending(false));
  };

  return { start, pending, error };
}
