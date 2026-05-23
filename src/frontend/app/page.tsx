"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

type Result = {
  place_id: string;
  name: string;
  address: string;
  website_uri: string | null;
};

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "result"; data: Result }
  | { kind: "empty" }
  | { kind: "error"; message: string };

export default function Home() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setStatus({ kind: "loading" });
    try {
      const res = await fetch(`${API_URL}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (res.status === 404) {
        setStatus({ kind: "empty" });
        return;
      }
      if (!res.ok) {
        setStatus({ kind: "error", message: `request failed (${res.status})` });
        return;
      }
      const data: Result = await res.json();
      setStatus({ kind: "result", data });
      const url = data.website_uri ?? q;
      router.push(`/sandbox?url=${encodeURIComponent(url)}`);
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : "request failed",
      });
    }
  }

  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-xl flex-col gap-8 px-6 py-24">
        <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Search a place
        </h1>

        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Seu Pizza Lisboa"
            className="flex-1 rounded-md border border-zinc-300 bg-white px-4 py-2 text-base text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-50"
          />
          <button
            type="submit"
            disabled={status.kind === "loading"}
            className="rounded-md bg-black px-5 py-2 text-base font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-50 dark:text-black dark:hover:bg-zinc-200"
          >
            Search
          </button>
        </form>

        <div className="min-h-24">
          {status.kind === "loading" && (
            <p className="text-zinc-600 dark:text-zinc-400">Searching…</p>
          )}
          {status.kind === "empty" && (
            <p className="text-zinc-600 dark:text-zinc-400">No results.</p>
          )}
          {status.kind === "error" && (
            <p className="text-red-600 dark:text-red-400">{status.message}</p>
          )}
          {status.kind === "result" && (
            <div className="flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="text-lg font-semibold text-black dark:text-zinc-50">
                {status.data.name}
              </h2>
              <p className="text-zinc-700 dark:text-zinc-300">
                {status.data.address}
              </p>
              <p className="font-mono text-xs text-zinc-500 dark:text-zinc-500">
                {status.data.place_id}
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
