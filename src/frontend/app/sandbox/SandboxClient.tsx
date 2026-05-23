"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { NoteToBusiness } from "@/components/ui/note-to-business";
import { Tilt } from "@/components/ui/tilt";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Default chrome — used until the LLM-chosen palette arrives. Deep forest
// green ink on cream reads as an apothecary / restaurant-menu palette. Once
// the build emits `<meta name="palette">`, the outer div overrides the
// --carte-* variables and the whole chrome re-themes to the card's palette.
const DEFAULT_BG = "#FFFDF6";
const DEFAULT_INK = "#1F3A2E";
const INK = `var(--carte-ink, ${DEFAULT_INK})`;
const BG = `var(--carte-bg, ${DEFAULT_BG})`;

type Status =
  | { kind: "waiting" }
  | { kind: "streaming"; revision: number }
  | { kind: "done"; revision: number; createdAt?: string }
  | { kind: "retry" };

type Generation = {
  job_id: string;
  url: string | null;
  created_at: string;
  preview_url: string;
};

// Mirror of backend BusinessContext (slim — only fields the chrome reads).
type SiteDistilled = {
  tagline: string | null;
  description: string;
  tone: string;
  vibe_tags: string[];
  key_phrases: string[];
  visual_cues: string[];
  site_summary: string;
};

type BusinessContext = {
  job_id: string;
  name: string;
  address: string;
  rating: number | null;
  user_rating_count: number | null;
  types: string[];
  editorial_summary: string | null;
  website_uri: string | null;
  google_maps_uri: string | null;
  site_distilled: SiteDistilled | null;
};

export function SandboxClient({
  initialJobId,
  initialName,
}: {
  initialJobId: string | null;
  initialName: string | null;
}) {
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [name, setName] = useState<string | null>(initialName);
  const [palette, setPalette] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "waiting" });
  const [regenerating, setRegenerating] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [context, setContext] = useState<BusinessContext | null>(null);
  const paletteFetchedRef = useRef(false);

  useEffect(() => {
    setPalette([]);
    setStatus({ kind: "waiting" });
    setContext(null);
    paletteFetchedRef.current = false;

    // No job_id: fall back to the most recent historic generation.
    if (!jobId) {
      let cancelled = false;
      void (async () => {
        try {
          const res = await fetch(`${API_URL}/api/generation/current`, {
            cache: "no-store",
          });
          if (cancelled) return;
          if (res.status === 204 || !res.ok) {
            setStatus({ kind: "retry" });
            return;
          }
          const gen = (await res.json()) as Generation;
          if (cancelled) return;
          setJobId(gen.job_id);
          setStatus({
            kind: "done",
            revision: 0,
            createdAt: gen.created_at,
          });
          void fetchPalette(gen.job_id).then((p) => {
            if (!cancelled) setPalette(p);
          });
        } catch {
          if (!cancelled) setStatus({ kind: "retry" });
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // Live SSE for an active or pending job.
    const es = new EventSource(
      `${API_URL}/api/jobs/${encodeURIComponent(jobId)}/events`,
    );
    let cancelled = false;

    const tryHistoric = async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/generation/${encodeURIComponent(jobId)}`,
          { cache: "no-store" },
        );
        if (cancelled) return;
        if (res.ok) {
          const gen = (await res.json()) as Generation;
          setStatus({
            kind: "done",
            revision: 0,
            createdAt: gen.created_at,
          });
          const p = await fetchPalette(gen.job_id);
          if (!cancelled) setPalette(p);
        } else {
          setStatus({ kind: "retry" });
        }
      } catch {
        if (!cancelled) setStatus({ kind: "retry" });
      }
    };

    es.onmessage = (e) => {
      if (cancelled) return;
      let event: {
        event?: string;
        name?: string;
        palette?: string[];
        revision?: number;
      };
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (event.event) {
        case "context":
          if (typeof event.name === "string" && event.name.length > 0) {
            setName(event.name);
          }
          if (Array.isArray(event.palette) && event.palette.length > 0) {
            setPalette(event.palette);
          }
          break;
        case "draft":
          if (typeof event.revision === "number") {
            setStatus({ kind: "streaming", revision: event.revision });
          }
          // The builder's first Write already includes <meta name="palette">,
          // so pull the palette in as soon as we see *any* draft — that way
          // the surrounding chrome re-themes in lockstep with the card
          // appearing, not seconds later when the builder finalizes.
          if (!paletteFetchedRef.current && jobId) {
            paletteFetchedRef.current = true;
            void fetchPalette(jobId).then((p) => {
              if (!cancelled && p.length > 0) setPalette(p);
            });
          }
          break;
        case "ready":
          if (typeof event.revision === "number") {
            // Stamp createdAt at the moment ready fires so the colophon
            // can render "minted just now" without a follow-up fetch. The
            // DB row was inserted seconds earlier; the drift is invisible.
            setStatus({
              kind: "done",
              revision: event.revision,
              createdAt: new Date().toISOString(),
            });
          }
          es.close();
          void fetchPalette(jobId).then((p) => {
            if (!cancelled && p.length > 0) setPalette(p);
          });
          break;
        case "timeout":
          es.close();
          void tryHistoric();
          break;
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; if it fails permanently, that's
      // surfaced through a subsequent message timeout. Close on
      // terminal failure to avoid leaks.
      if (es.readyState === EventSource.CLOSED) {
        return;
      }
    };

    return () => {
      cancelled = true;
      es.close();
    };
  }, [jobId]);

  // Fetch slice-1 context so the chrome can surface rating / reviews /
  // type / editorial summary / maps link. Runs on jobId change and once
  // more on `ready` (in case the live job reached ready before slice-1
  // upload settled). 404s are silently ignored — context simply remains
  // null and the chrome degrades to "just name + palette".
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const load = async () => {
      const ctx = await fetchContext(jobId);
      if (!cancelled && ctx) setContext(ctx);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId, status.kind === "done"]);

  const regenerate = useCallback(async () => {
    if (!name || regenerating) return;
    setRegenerating(true);
    try {
      const res = await fetch(`${API_URL}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: name }),
      });
      if (!res.ok) return;
      const { job_id: newId } = (await res.json()) as { job_id: string };
      router.replace(
        `/sandbox?job_id=${encodeURIComponent(newId)}&name=${encodeURIComponent(name)}`,
        { scroll: false },
      );
      setJobId(newId);
    } catch {
      // swallow — sandbox stays where it is
    } finally {
      setRegenerating(false);
    }
  }, [name, regenerating, router]);

  // Iframe is mounted for the entire life of any job — `/api/preview`
  // serves a cream waiting card when Storage has nothing yet, then the
  // real card the moment the builder's first Write lands. This way the
  // user watches the card area populate gradually instead of a React
  // overlay blocking the iframe until the first draft event arrives.
  const liveRevision =
    status.kind === "streaming" || status.kind === "done" ? status.revision : 0;
  const previewUrl = jobId
    ? `${API_URL}/api/preview/${encodeURIComponent(jobId)}?v=${liveRevision}`
    : null;
  const showIframe = previewUrl !== null && status.kind !== "retry";
  const busy =
    regenerating || status.kind === "waiting" || status.kind === "streaming";

  // Once the build's `<meta name="palette">` arrives we have three hex codes:
  // [0] background, [1] ink/foreground, [2] accent. Plumb them through CSS
  // variables on the outer div so every themed surface (top bar, card frame,
  // note panel, palette footer) re-tints in unison. Until then we fall back
  // to the cream + forest-green default.
  const themed = palette.length >= 3;
  const themeVars: CSSProperties = {
    "--carte-bg": themed ? palette[0] : DEFAULT_BG,
    "--carte-ink": themed ? palette[1] : DEFAULT_INK,
    "--carte-accent": themed ? palette[2] : DEFAULT_INK,
    "--carte-paper":
      "color-mix(in oklab, var(--carte-bg) 92%, var(--carte-ink) 8%)",
  } as CSSProperties;

  const createdAt =
    status.kind === "done" ? status.createdAt ?? null : null;

  return (
    <div
      className="relative isolate flex h-screen flex-col overflow-hidden"
      style={{
        ...themeVars,
        background: BG,
        color: INK,
        transition:
          "background-color 700ms ease-out, color 700ms ease-out",
      }}
    >
      <PaperGrain />
      <TopBar
        name={name}
        jobId={jobId}
        createdAt={createdAt}
        onOpenArchive={() => setArchiveOpen(true)}
      />
      <NavRule />

      <main
        className="flex min-h-0 flex-1 items-center justify-center gap-8 px-6 pb-2 sm:px-10"
        style={{ "--note-w": "360px" } as CSSProperties}
      >
        <Tilt max={5}>
          <div className="fade-up" style={{ animationDelay: "120ms" }}>
            <div className="relative">
              <CornerBrackets />
              <CardFrame ready={showIframe}>
                {status.kind === "retry" && <SoftRetry />}
                {showIframe && previewUrl && (
                  <iframe
                    key={`v-${liveRevision}`}
                    src={previewUrl}
                    sandbox="allow-scripts"
                    className="absolute inset-0 h-full w-full border-0"
                    title={name ?? "card"}
                  />
                )}
              </CardFrame>
            </div>
          </div>
        </Tilt>
        <Tilt max={8}>
          <NoteToBusiness businessName={name} ready={showIframe} />
        </Tilt>
      </main>

      <EditorialFooter context={context} palette={palette} />
      <ArchiveDrawer
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        currentJobId={jobId}
      />
    </div>
  );
}

async function fetchContext(jobId: string): Promise<BusinessContext | null> {
  try {
    const res = await fetch(
      `${API_URL}/api/context/${encodeURIComponent(jobId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    return (await res.json()) as BusinessContext;
  } catch {
    return null;
  }
}

async function fetchPalette(jobId: string): Promise<string[]> {
  try {
    const res = await fetch(
      `${API_URL}/api/generation/${encodeURIComponent(jobId)}/palette`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { palette: string[] };
    return data.palette ?? [];
  } catch {
    return [];
  }
}

function TopBar({
  name,
  jobId,
  createdAt,
  onOpenArchive,
}: {
  name: string | null;
  jobId: string | null;
  createdAt: string | null;
  onOpenArchive: () => void;
}) {
  return (
    <header
      className="fade-up relative grid shrink-0 grid-cols-[auto_1fr_auto] items-center gap-6 px-6 py-5 sm:px-10 sm:py-6"
      style={{ animationDelay: "0ms" }}
    >
      <div className="flex items-baseline gap-4 justify-self-start sm:gap-5">
        <a href="/" className="inline-flex items-baseline gap-3">
          {/* Brand wordmark stays ink-black (#191512) rather than the page's
              themed INK — Carte is the constant across every state. */}
          <span className="text-base sm:text-lg" style={{ color: "#191512" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>
              Carte
            </span>
            <em
              className="font-normal italic"
              style={{
                fontFamily: "var(--font-serif)",
                fontSize: "1.06em",
                marginLeft: "-0.02em",
              }}
            >
              .
            </em>
          </span>
        </a>
        <span
          aria-hidden
          className="hidden h-3 w-px sm:inline-block"
          style={{
            background: `color-mix(in srgb, ${INK} 22%, transparent)`,
          }}
        />
        <button
          type="button"
          onClick={onOpenArchive}
          className="hidden bg-transparent p-0 outline-none transition-opacity duration-200 hover:opacity-60 sm:inline-flex"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "0.62rem",
            letterSpacing: "0.24em",
            textTransform: "uppercase",
            color: `color-mix(in srgb, ${INK} 65%, transparent)`,
            cursor: "pointer",
          }}
        >
          archive
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-4 justify-self-center sm:gap-5">
        {name ? (
          <>
            <Flourish />
            <h1
              className="m-0 max-w-[60vw] truncate text-center"
              style={{
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontSize: "clamp(1.6rem, 3vw, 2.6rem)",
                letterSpacing: "-0.02em",
                lineHeight: 1.05,
                color: INK,
              }}
              title={name}
            >
              {name}
            </h1>
            <Flourish flip />
          </>
        ) : (
          <span aria-hidden className="h-[2.6rem]" />
        )}
      </div>

      <ColophonMark jobId={jobId} createdAt={createdAt} />
    </header>
  );
}

function ColophonMark({
  jobId,
  createdAt,
}: {
  jobId: string | null;
  createdAt: string | null;
}) {
  if (!jobId) {
    return <span aria-hidden className="justify-self-end" />;
  }
  const serial = jobId.slice(-4).toUpperCase();
  return (
    <div
      className="hidden items-center gap-2 justify-self-end sm:flex"
      style={{
        color: `color-mix(in srgb, ${INK} 60%, transparent)`,
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "0.62rem",
          letterSpacing: "0.24em",
          textTransform: "uppercase",
        }}
      >
        no.
      </span>
      <span
        style={{
          fontFamily: "var(--font-serif)",
          fontStyle: "italic",
          fontSize: "0.92rem",
          letterSpacing: "0.04em",
          color: INK,
        }}
      >
        {serial}
      </span>
      {createdAt && (
        <>
          <Fleuron />
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "0.62rem",
              letterSpacing: "0.22em",
              textTransform: "uppercase",
            }}
          >
            {relativeTime(createdAt)}
          </span>
        </>
      )}
    </div>
  );
}

function EditorialFooter({
  context,
  palette,
}: {
  context: BusinessContext | null;
  palette: string[];
}) {
  // Quieter footer: just the palette swatches with an italic-serif
  // tagline beneath when context is in hand. The colophon in the nav
  // already carries the serial + minted time; no need to repeat meta or
  // links here.
  const tagline =
    context?.editorial_summary ??
    context?.site_distilled?.tagline ??
    null;

  return (
    <footer
      className="fade-up flex shrink-0 flex-col items-center gap-2 px-6 py-4"
      style={{ animationDelay: "360ms" }}
    >
      <div className="flex items-center gap-3">
        {palette.length === 0 ? (
          <span aria-hidden className="h-3.5" />
        ) : (
          palette.map((hex) => (
            <span
              key={hex}
              title={hex}
              className="block h-3.5 w-3.5 rounded-sm"
              style={{
                background: hex,
                boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${INK} 14%, transparent)`,
              }}
            />
          ))
        )}
      </div>
      {tagline && (
        <span
          className="max-w-[60vw] truncate text-center"
          style={{
            fontFamily: "var(--font-serif)",
            fontStyle: "italic",
            fontSize: "0.85rem",
            lineHeight: 1.2,
            color: `color-mix(in srgb, ${INK} 65%, transparent)`,
          }}
          title={tagline}
        >
          {tagline}
        </span>
      )}
    </footer>
  );
}

function CornerBrackets() {
  // Camera-viewfinder marks just outside the carte — small editorial
  // signal that this object is "the artifact in frame".
  const size = 12;
  const offset = -8;
  const color = `color-mix(in srgb, ${INK} 38%, transparent)`;
  const thickness = "1.2px";
  const baseStyle: CSSProperties = {
    width: size,
    height: size,
    pointerEvents: "none",
  };
  return (
    <>
      <span
        aria-hidden
        className="absolute"
        style={{
          ...baseStyle,
          top: offset,
          left: offset,
          borderTop: `${thickness} solid ${color}`,
          borderLeft: `${thickness} solid ${color}`,
        }}
      />
      <span
        aria-hidden
        className="absolute"
        style={{
          ...baseStyle,
          top: offset,
          right: offset,
          borderTop: `${thickness} solid ${color}`,
          borderRight: `${thickness} solid ${color}`,
        }}
      />
      <span
        aria-hidden
        className="absolute"
        style={{
          ...baseStyle,
          bottom: offset,
          left: offset,
          borderBottom: `${thickness} solid ${color}`,
          borderLeft: `${thickness} solid ${color}`,
        }}
      />
      <span
        aria-hidden
        className="absolute"
        style={{
          ...baseStyle,
          bottom: offset,
          right: offset,
          borderBottom: `${thickness} solid ${color}`,
          borderRight: `${thickness} solid ${color}`,
        }}
      />
    </>
  );
}

function CardFrame({
  children,
  ready,
}: {
  children: React.ReactNode;
  ready: boolean;
}) {
  // The CardFrame is sized to consume most of the viewport.
  // Vertical chrome ≈ 8rem total (top bar ~3.5rem + bottom bar ~3.5rem + a
  // little breathing); we subtract that from 100vh and let aspect-ratio
  // derive the width, capped to viewport width.
  return (
    <div
      className="relative overflow-hidden rounded-lg transition-colors duration-500"
      style={{
        aspectRatio: "16 / 9",
        height:
          "min(calc(100vh - 9rem), calc((100vw - 3rem - var(--note-w, 0px) - 2rem) * 9 / 16))",
        background: ready ? "#ffffff" : INK,
        border: `1px solid color-mix(in srgb, ${INK} ${ready ? 10 : 35}%, transparent)`,
        boxShadow: [
          `inset 0 0 0 1px color-mix(in srgb, ${BG} 45%, transparent)`,
          `0 1px 0 color-mix(in srgb, ${BG} 55%, transparent)`,
          `0 28px 64px -24px color-mix(in srgb, ${INK} 32%, transparent)`,
          `0 12px 24px -12px color-mix(in srgb, ${INK} 22%, transparent)`,
        ].join(", "),
      }}
    >
      {children}
    </div>
  );
}

function SoftRetry() {
  // SoftRetry sits inside an unready CardFrame whose background is the
  // themed INK. Text uses BG (the page background color) so contrast with
  // the card is guaranteed for any LLM-picked palette: bg-on-ink is the
  // same pairing as the rest of the chrome, just inverted.
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center">
      <span
        aria-hidden
        style={{ color: `color-mix(in srgb, ${BG} 60%, transparent)` }}
      >
        <Fleuron size={6} />
      </span>
      <p
        className="m-0"
        style={{
          fontFamily: "var(--font-serif)",
          fontStyle: "italic",
          fontSize: "clamp(1.1rem, 2.3vw, 1.6rem)",
          color: BG,
        }}
      >
        let&rsquo;s try a different name.
      </p>
      <a
        href="/"
        className="transition-opacity hover:opacity-70"
        style={{
          color: `color-mix(in srgb, ${BG} 85%, transparent)`,
          fontFamily: "var(--font-serif)",
          fontStyle: "italic",
          fontSize: "0.95rem",
          textDecoration: "underline",
          textUnderlineOffset: "5px",
          textDecorationThickness: "0.5px",
        }}
      >
        begin again
      </a>
    </div>
  );
}

function Fleuron({ size = 7 }: { size?: number }) {
  // Just the floral mark from Flourish, no hairline. Reusable ornament.
  return (
    <svg
      width={size * 1.8}
      height={size}
      viewBox="0 0 14 8"
      fill="none"
      aria-hidden
      style={{ display: "inline-block", color: "currentColor", flexShrink: 0 }}
    >
      <ellipse cx="7" cy="2" rx="0.85" ry="1.9" fill="currentColor" opacity="0.7" />
      <ellipse cx="7" cy="6" rx="0.85" ry="1.9" fill="currentColor" opacity="0.7" />
      <ellipse cx="4.1" cy="4" rx="1.9" ry="0.85" fill="currentColor" opacity="0.7" />
      <ellipse cx="9.9" cy="4" rx="1.9" ry="0.85" fill="currentColor" opacity="0.7" />
      <circle cx="7" cy="4" r="0.7" fill="currentColor" />
    </svg>
  );
}

function PaperGrain() {
  // Sits in the background of the page chrome to give the cream a real
  // paper-fiber texture. Same SVG turbulence pattern used on the sticky
  // note and the landing page background, scaled larger and dimmer here so
  // it reads as ambient grain rather than visible noise.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10"
      style={{
        opacity: 0.06,
        mixBlendMode: "multiply",
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 320'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.5 0'/%3E%3C/filter%3E%3Crect width='320' height='320' filter='url(%23n)'/%3E%3C/svg%3E\")",
        backgroundSize: "320px 320px",
      }}
    />
  );
}

function NavRule() {
  // Editorial page-divider — a fine hairline broken by a centered fleuron,
  // like the rules used between sections in printed catalogues. Anchors
  // the header band as a discrete "running head" zone.
  return (
    <div className="shrink-0 px-6 sm:px-10">
      <div
        className="relative h-px w-full"
        style={{
          background: `color-mix(in srgb, ${INK} 14%, transparent)`,
        }}
      >
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center px-3"
          style={{
            background: BG,
            color: `color-mix(in srgb, ${INK} 45%, transparent)`,
            transition: "background-color 700ms ease-out, color 700ms ease-out",
          }}
        >
          <Fleuron size={6} />
        </span>
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = ms / 1000;
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

type ArchiveItem = {
  job_id: string;
  url: string | null;
  created_at: string;
};

function ArchiveDrawer({
  open,
  onClose,
  currentJobId,
}: {
  open: boolean;
  onClose: () => void;
  currentJobId: string | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ArchiveItem[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(false);
    setItems(null);
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/api/generations?limit=40`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(true);
          return;
        }
        const data = (await res.json()) as ArchiveItem[];
        if (!cancelled) setItems(data);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function go(id: string) {
    onClose();
    if (id === currentJobId) return;
    router.push(`/sandbox?job_id=${encodeURIComponent(id)}`);
  }

  return (
    <div
      aria-hidden={!open}
      className="pointer-events-none fixed inset-0 z-40"
      style={{ visibility: open ? "visible" : "hidden" }}
    >
      <div
        onClick={onClose}
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          pointerEvents: open ? "auto" : "none",
          opacity: open ? 1 : 0,
          background: `color-mix(in srgb, ${INK} 32%, transparent)`,
          backdropFilter: "blur(2px)",
        }}
      />
      <aside
        role="dialog"
        aria-label="archive of past cartes"
        className="absolute left-0 top-0 flex h-full w-full max-w-[420px] flex-col overflow-hidden transition-transform duration-300 ease-out"
        style={{
          pointerEvents: open ? "auto" : "none",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          background: BG,
          borderRight: `1px solid color-mix(in srgb, ${INK} 12%, transparent)`,
          boxShadow: `12px 0 40px -12px color-mix(in srgb, ${INK} 28%, transparent)`,
        }}
      >
        <header
          className="flex shrink-0 items-baseline justify-between px-7 pb-4 pt-7"
          style={{ color: INK }}
        >
          <div className="flex items-baseline gap-3">
            <h2
              className="m-0"
              style={{
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontSize: "1.45rem",
                letterSpacing: "-0.01em",
              }}
            >
              archive
            </h2>
            <span
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "0.6rem",
                letterSpacing: "0.24em",
                textTransform: "uppercase",
                color: `color-mix(in srgb, ${INK} 50%, transparent)`,
              }}
            >
              past cartes
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="close archive"
            className="bg-transparent p-1 outline-none transition-opacity hover:opacity-60"
            style={{
              cursor: "pointer",
              color: `color-mix(in srgb, ${INK} 70%, transparent)`,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
              <path
                d="M3 3 L 13 13 M13 3 L 3 13"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>
        <div className="px-7">
          <div
            className="h-px w-full"
            style={{
              background: `color-mix(in srgb, ${INK} 12%, transparent)`,
            }}
          />
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto px-2 py-3"
          style={{ color: INK }}
        >
          {items === null && !error && (
            <p
              className="m-0 px-5 py-4"
              style={{
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontSize: "0.9rem",
                color: `color-mix(in srgb, ${INK} 45%, transparent)`,
              }}
            >
              pressing the archive&hellip;
            </p>
          )}
          {error && (
            <p
              className="m-0 px-5 py-4"
              style={{
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontSize: "0.9rem",
                color: `color-mix(in srgb, ${INK} 55%, transparent)`,
              }}
            >
              couldn&rsquo;t fetch the archive right now.
            </p>
          )}
          {items && items.length === 0 && (
            <p
              className="m-0 px-5 py-4"
              style={{
                fontFamily: "var(--font-serif)",
                fontStyle: "italic",
                fontSize: "0.9rem",
                color: `color-mix(in srgb, ${INK} 55%, transparent)`,
              }}
            >
              no cartes yet — yours will be the first.
            </p>
          )}
          {items && items.length > 0 && (
            <ul className="m-0 list-none p-0">
              {items.map((it) => (
                <ArchiveRow
                  key={it.job_id}
                  item={it}
                  isCurrent={it.job_id === currentJobId}
                  onClick={() => go(it.job_id)}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

function ArchiveRow({
  item,
  isCurrent,
  onClick,
}: {
  item: ArchiveItem;
  isCurrent: boolean;
  onClick: () => void;
}) {
  const domain = item.url ? safeDomain(item.url) : null;
  const serial = item.job_id.slice(-4).toUpperCase();
  return (
    <li
      className="m-0 p-0"
      style={{
        borderBottom: `1px solid color-mix(in srgb, ${INK} 8%, transparent)`,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="group flex w-full items-baseline justify-between gap-3 bg-transparent px-5 py-3 text-left outline-none transition-colors duration-200"
        style={{
          cursor: "pointer",
          color: INK,
          background: isCurrent
            ? `color-mix(in srgb, ${INK} 6%, transparent)`
            : "transparent",
        }}
        onMouseEnter={(e) => {
          if (isCurrent) return;
          e.currentTarget.style.background = `color-mix(in srgb, ${INK} 4%, transparent)`;
        }}
        onMouseLeave={(e) => {
          if (isCurrent) return;
          e.currentTarget.style.background = "transparent";
        }}
      >
        <span className="flex min-w-0 flex-col items-start gap-1">
          <span
            className="truncate"
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontSize: "1.05rem",
              lineHeight: 1.1,
            }}
          >
            {domain ?? <em style={{ opacity: 0.55 }}>untitled</em>}
          </span>
          <span
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "0.6rem",
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: `color-mix(in srgb, ${INK} 50%, transparent)`,
            }}
          >
            no. {serial} &nbsp;·&nbsp; {relativeTime(item.created_at)}
          </span>
        </span>
        <span
          aria-hidden
          className="transition-transform duration-200 group-hover:translate-x-[2px]"
          style={{ color: `color-mix(in srgb, ${INK} 45%, transparent)` }}
        >
          <svg width="18" height="10" viewBox="0 0 18 10" fill="none">
            <path
              d="M1 5 L 16 5"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
            />
            <path
              d="M12 1.2 L 16 5 L 12 8.8"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </svg>
        </span>
      </button>
    </li>
  );
}

function safeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
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
        color: `color-mix(in srgb, ${INK} 55%, transparent)`,
        transform: flip ? "scaleX(-1)" : undefined,
        flexShrink: 0,
      }}
    >
      <line
        x1="0"
        y1="6"
        x2="38"
        y2="6"
        stroke="currentColor"
        strokeWidth="0.6"
        opacity="0.6"
      />
      <ellipse cx="48" cy="2.6" rx="1" ry="2.2" fill="currentColor" opacity="0.65" />
      <ellipse cx="48" cy="9.4" rx="1" ry="2.2" fill="currentColor" opacity="0.65" />
      <ellipse cx="44.6" cy="6" rx="2.2" ry="1" fill="currentColor" opacity="0.65" />
      <ellipse cx="51.4" cy="6" rx="2.2" ry="1" fill="currentColor" opacity="0.65" />
      <circle cx="48" cy="6" r="0.7" fill="currentColor" opacity="1" />
    </svg>
  );
}
