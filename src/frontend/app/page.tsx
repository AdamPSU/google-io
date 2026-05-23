"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BackgroundScene } from "@/components/ui/background-scene";
import BounceCards from "@/components/ui/bounce-cards";
import { PromptInputBox } from "@/components/ui/prompt-input-box";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const CREAM = "#FFFDF6";

const MENU_IMAGES = [
  // round table of dishes
  "https://images.unsplash.com/photo-1755811248324-c70c1f10a7fd?w=500&q=80&auto=format&fit=crop",
  // cozy dimly-lit restaurant table
  "https://images.unsplash.com/photo-1771532447024-ee348a315f41?w=500&q=80&auto=format&fit=crop",
  // pasta + wine
  "https://images.unsplash.com/photo-1620475676913-9497df261cc3?w=500&q=80&auto=format&fit=crop",
  // cafe interior
  "https://images.unsplash.com/photo-1749922217403-412f69429dc5?w=500&q=80&auto=format&fit=crop",
  // coffee + croissant
  "https://images.unsplash.com/photo-1721277000438-488066df7ac8?w=500&q=80&auto=format&fit=crop",
];

const MENU_TRANSFORMS = [
  "rotate(8deg) translate(-128px)",
  "rotate(4deg) translate(-64px)",
  "rotate(-3deg)",
  "rotate(-8deg) translate(64px)",
  "rotate(3deg) translate(128px)",
];

type Status = { kind: "idle" } | { kind: "loading" };

// Opens the job's SSE stream and resolves as soon as the backend publishes
// the "context" event (Places lookup + site distillation done). Returns the
// resolved business name from Places, falling back to the user's query if
// the event never carries one. Only a real `context` event or the 30s safety
// timeout resolves — transient SSE errors are ignored so the magic border
// never blinks past the user during a connection blip.
const MIN_BORDER_HOLD_MS = 1500;
const CONTEXT_TIMEOUT_MS = 30_000;

function waitForContext(jobId: string, fallbackName: string): Promise<string> {
  return new Promise((resolve) => {
    const es = new EventSource(`${API_URL}/api/jobs/${jobId}/events`);
    const startedAt = Date.now();

    const finish = (name: string) => {
      clearTimeout(timeoutId);
      es.close();
      // Hold for a minimum so the spinning border is always perceivable —
      // even if the backend resolves context instantly (cached job, etc.).
      const elapsed = Date.now() - startedAt;
      const wait = Math.max(0, MIN_BORDER_HOLD_MS - elapsed);
      window.setTimeout(() => resolve(name), wait);
    };

    const timeoutId = window.setTimeout(
      () => finish(fallbackName),
      CONTEXT_TIMEOUT_MS,
    );

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as {
          event?: string;
          name?: string;
        };
        if (event.event === "context") {
          finish(
            typeof event.name === "string" && event.name.length > 0
              ? event.name
              : fallbackName,
          );
        } else if (event.event === "timeout") {
          // Slice 1 failed (no Places result, network, etc). Don't make
          // the user wait the full safety timeout — navigate now with
          // the typed query and let the sandbox show its soft-retry.
          finish(fallbackName);
        }
      } catch {
        // Ignore malformed events; keep listening.
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects on transient errors. Do NOT resolve on
      // terminal close either — premature navigation defeats the whole
      // point of holding the border until context is real. The safety
      // timeout above bounds the worst case.
    };
  });
}

export default function Home() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function submit() {
    const q = query.trim();
    if (!q) return;
    setStatus({ kind: "loading" });
    try {
      const res = await fetch(`${API_URL}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok) {
        // Silent fallback — sandbox shows the soft retry once the
        // (missing) job times out. User never sees the error.
        router.push(`/sandbox?name=${encodeURIComponent(q)}`);
        return;
      }
      const { job_id } = (await res.json()) as { job_id: string };

      // Hold the spinning border until the backend has built the
      // BusinessContext (Places + site distillation). The "context"
      // SSE event is the first signal the job has real data; only
      // then do we transition to the sandbox.
      const resolvedName = await waitForContext(job_id, q);

      router.push(
        `/sandbox?job_id=${encodeURIComponent(job_id)}&name=${encodeURIComponent(resolvedName)}`,
      );
    } catch {
      router.push(`/sandbox?name=${encodeURIComponent(q)}`);
    }
  }

  const busy = status.kind === "loading";

  return (
    <div className="relative isolate flex min-h-screen flex-1 items-center justify-center overflow-hidden px-6 py-12 sm:py-16">
      <BackgroundScene />

      <main
        className="relative z-10 flex w-full max-w-xl flex-col items-center text-center"
        style={{ color: CREAM }}
      >
        <div className="flex flex-col items-center gap-4">
          <span
            className="fade-up flex items-center gap-4 text-[11px] tracking-[0.22em]"
            style={{
              color: "rgba(255,253,246,0.78)",
              animationDelay: "0ms",
            }}
          >
            <Flourish />
            <span>one name · one carte</span>
            <Flourish flip />
          </span>

          <h1
            className="fade-up m-0 inline-flex items-baseline"
            style={{
              fontSize: "clamp(4rem, 12vw, 7.5rem)",
              letterSpacing: "-0.035em",
              lineHeight: 1,
              color: CREAM,
              textShadow:
                "0 1px 1px rgba(25,21,18,0.35), 0 8px 28px rgba(25,21,18,0.35)",
              animationDelay: "80ms",
            }}
          >
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>
              Carte
            </span>
            <em
              className="font-normal italic"
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: "1.08em",
                marginLeft: "-0.02em",
              }}
            >
              .
            </em>
          </h1>

          <p
            className="fade-up whitespace-nowrap"
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontSize: "clamp(1.05rem, 1.5vw, 1.3rem)",
              lineHeight: 1.3,
              color: "rgba(255,253,246,0.92)",
              textShadow: "0 1px 18px rgba(25,21,18,0.45)",
              animationDelay: "220ms",
            }}
          >
            your business identity, packed into one carte.
          </p>
        </div>

        <div
          className="fade-up mt-14 w-full max-w-lg"
          style={{ animationDelay: "360ms" }}
        >
          <PromptInputBox
            value={query}
            onChange={setQuery}
            onSubmit={submit}
            isLoading={busy}
            autoFocus
            placeholder="Seu Pizza Lisboa"
          />
        </div>
      </main>

      <div
        className="fade-up pointer-events-auto absolute bottom-4 left-1/2 z-10 -translate-x-1/2"
        style={{ animationDelay: "600ms" }}
      >
        <BounceCards
          images={MENU_IMAGES}
          transformStyles={MENU_TRANSFORMS}
          containerWidth={440}
          containerHeight={190}
          animationDelay={0.9}
          animationStagger={0.08}
          easeType="elastic.out(1, 0.55)"
          enableHover
        />
      </div>
    </div>
  );
}

function Flourish({ flip = false }: { flip?: boolean }) {
  return (
    <svg
      width="58"
      height="12"
      viewBox="0 0 58 12"
      fill="none"
      aria-hidden
      style={{
        color: "rgba(255,253,246,0.78)",
        transform: flip ? "scaleX(-1)" : undefined,
        flexShrink: 0,
      }}
    >
      {/* hairline rule that fades toward the floral mark */}
      <line
        x1="0"
        y1="6"
        x2="38"
        y2="6"
        stroke="currentColor"
        strokeWidth="0.6"
        opacity="0.5"
      />
      {/* 4-petal floral fleuron */}
      <ellipse cx="48" cy="2.6" rx="1" ry="2.2" fill="currentColor" opacity="0.55" />
      <ellipse cx="48" cy="9.4" rx="1" ry="2.2" fill="currentColor" opacity="0.55" />
      <ellipse cx="44.6" cy="6" rx="2.2" ry="1" fill="currentColor" opacity="0.55" />
      <ellipse cx="51.4" cy="6" rx="2.2" ry="1" fill="currentColor" opacity="0.55" />
      <circle cx="48" cy="6" r="0.7" fill="currentColor" opacity="0.95" />
    </svg>
  );
}

