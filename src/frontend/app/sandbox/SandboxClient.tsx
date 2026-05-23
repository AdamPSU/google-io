"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Generation = {
  job_id: string;
  url: string;
  created_at: string;
  preview_url: string;
};

type Status = "loading" | "generating" | "ready" | "empty" | "error";

export function SandboxClient({ initialUrl }: { initialUrl: string | null }) {
  const [status, setStatus] = useState<Status>("loading");
  const [current, setCurrent] = useState<Generation | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Guard against React Strict Mode double-invoking the mount effect and
  // creating two generations for the same `?url=` query param.
  const generatedFor = useRef<string | null>(null);

  const fetchCurrent = useCallback(async () => {
    const res = await fetch(`${API_URL}/api/generation/current`, {
      cache: "no-store",
    });
    if (res.status === 204) {
      setCurrent(null);
      setStatus("empty");
      return;
    }
    if (!res.ok) {
      setStatus("error");
      setErrorMessage(`fetch current failed (${res.status})`);
      return;
    }
    const data = (await res.json()) as Generation;
    setCurrent(data);
    setStatus("ready");
  }, []);

  const generate = useCallback(
    async (url: string) => {
      setStatus("generating");
      setErrorMessage(null);
      const res = await fetch(`${API_URL}/api/generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        setStatus("error");
        setErrorMessage(`generate failed (${res.status})`);
        return;
      }
      await fetchCurrent();
    },
    [fetchCurrent],
  );

  useEffect(() => {
    if (initialUrl && generatedFor.current !== initialUrl) {
      generatedFor.current = initialUrl;
      void generate(initialUrl);
    } else {
      void fetchCurrent();
    }
  }, [initialUrl, generate, fetchCurrent]);

  const regenerate = () => {
    const url = current?.url ?? initialUrl;
    if (url) void generate(url);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-zinc-950 text-zinc-50">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-sm">
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-zinc-500">sandbox</span>
          {current && (
            <span className="truncate text-zinc-300" title={current.url}>
              {current.url}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {current && (
            <span className="font-mono text-xs text-zinc-500">
              {new Date(current.created_at).toLocaleString()}
            </span>
          )}
          <button
            type="button"
            onClick={regenerate}
            disabled={
              status === "generating" || (!current && !initialUrl)
            }
            className="rounded-md bg-zinc-50 px-3 py-1 text-xs font-medium text-black hover:bg-zinc-200 disabled:opacity-40"
          >
            {status === "generating" ? "generating…" : "regenerate"}
          </button>
        </div>
      </header>

      <main className="flex-1">
        {status === "loading" && (
          <Centered>loading…</Centered>
        )}
        {status === "generating" && (
          <Centered>generating card…</Centered>
        )}
        {status === "empty" && (
          <Centered>
            no generation yet — go{" "}
            <a href="/" className="underline">
              search for a place
            </a>{" "}
            first.
          </Centered>
        )}
        {status === "error" && (
          <Centered>
            <span className="text-red-400">{errorMessage ?? "error"}</span>
          </Centered>
        )}
        {status === "ready" && current && (
          <iframe
            key={current.job_id}
            src={current.preview_url}
            sandbox="allow-scripts"
            className="h-full w-full border-0"
            title={`generation ${current.job_id}`}
          />
        )}
      </main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-zinc-400">
      {children}
    </div>
  );
}
