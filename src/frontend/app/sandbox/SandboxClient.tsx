"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { BackgroundScene } from "@/components/ui/background-scene";
import { NoteToBusiness } from "@/components/ui/note-to-business";
import { Tilt } from "@/components/ui/tilt";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// The page chrome lives in two zones with inverted palettes:
//   - Masthead (TopBar + NavRule): a solid cream paper strip; text paints
//     in dark warm ink, ornaments in sienna — like a printed menu header.
//   - Page stage (CornerBrackets and anything outside the masthead): cream
//     on the dark video, with a soft text-shadow for legibility.
// CHROME_* drives the on-video chrome; NAV_* drives the cream masthead.
const CHROME_INK = "#FFFDF6";
const CHROME_ACCENT = "#F0D9A8";
const CHROME_SHADOW = "0 1px 2px rgba(25,21,18,0.55)";
// Default masthead colors. Overridden at runtime via --nav-bg / --nav-ink /
// --nav-accent CSS vars once the build's palette arrives.
const NAV_BG = "#F5EFE0";
const NAV_INK = "#2A1F17";
const NAV_ACCENT = "#8A5A36";

// WCAG relative luminance — used to pick between white and near-black ink
// against the build's chosen background color. Anything brighter than
// ~0.5 reads as a light surface (use dark ink); below, use white ink.
function relativeLuminance(hex: string): number {
  const m = hex.replace("#", "").match(/.{2}/g);
  if (!m || m.length < 3) return 0.5;
  const [r, g, b] = m.slice(0, 3).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function inkForBg(bgHex: string): string {
  return relativeLuminance(bgHex) > 0.5 ? "#1A1A1A" : "#FFFFFF";
}

// --carte-* still gets set on the outer div so descendant *surfaces* that
// own their own background (the carte itself, the archive drawer
// interior) can theme to the LLM palette. INK/BG are the variable refs
// children use; they fall back to the cream/forest-green defaults the
// builder produced before any palette arrives.
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
  const [contactEmail, setContactEmail] = useState<string | null>(null);
  const [websiteUri, setWebsiteUri] = useState<string | null>(null);
  const paletteFetchedRef = useRef(false);

  // Sync URL → state. App Router keeps this client component mounted
  // across query-string changes, so a router.push to a new ?job_id=
  // (from HistoryStrip, ArchiveDrawer, or any deep link) doesn't
  // re-run useState's initializer. Watch the prop and push it in
  // ourselves so the SSE + palette effect below kicks off for the
  // newly-selected job.
  useEffect(() => {
    setJobId(initialJobId);
    setName(initialName);
  }, [initialJobId, initialName]);

  // Fetch slice-1 BusinessContext for the current job (email + website,
  // any other surfaces that want richer data). Only the bits the
  // NoteToBusiness pane needs are plumbed into state; the rest stays
  // on the server. Refires whenever jobId changes; tries again when
  // a build reaches "done" since the row may have been new.
  useEffect(() => {
    if (!jobId) {
      setContactEmail(null);
      setWebsiteUri(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/context/${encodeURIComponent(jobId)}`,
          { cache: "no-store" },
        );
        if (!res.ok || cancelled) return;
        const ctx = (await res.json()) as {
          email: string | null;
          website_uri: string | null;
        };
        if (cancelled) return;
        setContactEmail(ctx.email ?? null);
        setWebsiteUri(ctx.website_uri ?? null);
      } catch {
        // silent — note pane just falls back to a domain-derived email
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, status.kind]);

  useEffect(() => {
    setPalette([]);
    setStatus({ kind: "waiting" });
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
    // Masthead retints in lockstep with the card. Bg + accent come straight
    // from the brand palette; ink picks white vs near-black via luminance
    // so contrast holds regardless of what palette[1] turned out to be.
    "--nav-bg": themed ? palette[0] : NAV_BG,
    "--nav-ink": themed ? inkForBg(palette[0]) : NAV_INK,
    "--nav-accent": themed ? palette[2] : NAV_ACCENT,
  } as CSSProperties;

  const createdAt =
    status.kind === "done" ? status.createdAt ?? null : null;

  return (
    <div
      className="relative isolate flex h-screen flex-col overflow-hidden"
      style={{
        ...themeVars,
        color: CHROME_INK,
      }}
    >
      <BackgroundScene />
      {/* Masthead: a solid cream paper strip across the top of the page.
          Reads as a printed menu header — warm, inviting — with the dark
          video stage and the carte beneath. A soft drop-shadow on the
          bottom edge lifts it off the stage. */}
      <div
        className="relative shrink-0 transition-[background,color] duration-700 ease-out"
        style={{
          background: "var(--nav-bg)",
          color: "var(--nav-ink)",
          boxShadow:
            "0 10px 24px -16px rgba(0,0,0,0.55), inset 0 -1px 0 color-mix(in srgb, var(--nav-ink) 10%, transparent)",
        }}
      >
        <TopBar
          name={name}
          jobId={jobId}
          createdAt={createdAt}
          onOpenArchive={() => setArchiveOpen(true)}
        />
        <NavRule />
      </div>

      <main
        className="flex min-h-0 flex-1 items-stretch justify-center gap-8 px-6 py-4 sm:px-10 sm:py-6"
        style={{ "--note-w": "360px" } as CSSProperties}
      >
        <div
          className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center"
          style={{ containerType: "size" }}
        >
          <Tilt max={5}>
            <div
              className="fade-up relative"
              style={{
                animationDelay: "120ms",
                width: "min(calc(100cqh * 16 / 9), 100cqw)",
                aspectRatio: "16 / 9",
              }}
            >
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
          </Tilt>
        </div>
        <Tilt max={8}>
          <NoteToBusiness
            businessName={name}
            ready={showIframe}
            email={contactEmail}
            websiteUri={websiteUri}
          />
        </Tilt>
      </main>

      <HistoryStrip
        currentJobId={jobId}
        refreshKey={status.kind === "done" ? status.revision : 0}
      />

      <ArchiveDrawer
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        currentJobId={jobId}
      />
    </div>
  );
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
        <a
          href="/"
          className="inline-flex items-baseline gap-3 transition-opacity duration-200 hover:opacity-80"
        >
          <span
            className="text-lg sm:text-xl"
            style={{
              color: "var(--nav-ink)",
              letterSpacing: "-0.01em",
            }}
          >
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
            background: "color-mix(in srgb, var(--nav-ink) 22%, transparent)",
          }}
        />
        <button
          type="button"
          onClick={onOpenArchive}
          className="hidden bg-transparent p-0 outline-none transition-opacity duration-200 hover:opacity-70 sm:inline-flex"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "0.62rem",
            letterSpacing: "0.24em",
            textTransform: "uppercase",
            color: "color-mix(in srgb, var(--nav-ink) 78%, transparent)",
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
                color: "var(--nav-ink)",
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
        color: "color-mix(in srgb, var(--nav-ink) 72%, transparent)",
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
          color: "var(--nav-ink)",
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

function CornerBrackets() {
  // Camera-viewfinder marks just outside the carte — small editorial
  // signal that this object is "the artifact in frame". Painted in the
  // warm cream-amber accent so they read as candlelight against the dark
  // video stage — friendly and inviting, complementary to most cartes.
  const size = 14;
  const offset = -10;
  const color = `color-mix(in srgb, ${CHROME_ACCENT} 70%, transparent)`;
  const thickness = "1px";
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
  // CardFrame fills the 16:9 sleeve that its parent already sized via
  // container queries. No viewport math here — parent flex chain (main
  // → card slot → 16:9 sleeve) owns sizing, so the card can never push
  // past the masthead or the page edges.
  //
  // Unready state: an opaque matte warm-charcoal slab. Slightly lifted
  // from the page bg with a soft top-center radial highlight so it reads
  // as a closed envelope sitting on the desk catching the room light —
  // no video bleed-through, just the cream hairline border framing it.
  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg transition-[background,border-color,box-shadow] duration-700 ease-out"
      style={{
        background: ready
          ? "#ffffff"
          : "radial-gradient(120% 80% at 50% 0%, #2a221d 0%, #1f1a17 55%, #18130f 100%)",
        border: ready
          ? `1px solid color-mix(in srgb, ${CHROME_INK} 18%, transparent)`
          : `1px solid color-mix(in srgb, ${CHROME_INK} 16%, transparent)`,
        boxShadow: ready
          ? [
              `inset 0 0 0 1px color-mix(in srgb, ${BG} 45%, transparent)`,
              `0 1px 0 color-mix(in srgb, ${BG} 55%, transparent)`,
              `0 28px 64px -24px rgba(0,0,0,0.5)`,
              `0 12px 24px -12px rgba(0,0,0,0.35)`,
            ].join(", ")
          : [
              `inset 0 1px 0 color-mix(in srgb, ${CHROME_INK} 10%, transparent)`,
              `inset 0 0 120px -40px color-mix(in srgb, ${CHROME_INK} 8%, transparent)`,
              `inset 0 -1px 0 rgba(0,0,0,0.45)`,
              `0 32px 80px -32px rgba(0,0,0,0.65)`,
              `0 14px 28px -14px rgba(0,0,0,0.45)`,
            ].join(", "),
      }}
    >
      {children}
    </div>
  );
}

function SoftRetry() {
  // SoftRetry sits inside an unready CardFrame — now a smoked-glass slab
  // over the dark video stage. So copy is painted in CHROME_INK (cream)
  // with the same soft text-shadow used by every other chrome element,
  // keeping the typography consistent with the masthead.
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-6 text-center">
      <span
        aria-hidden
        style={{ color: `color-mix(in srgb, ${CHROME_INK} 55%, transparent)` }}
      >
        <Fleuron size={6} />
      </span>
      <p
        className="m-0"
        style={{
          fontFamily: "var(--font-serif)",
          fontStyle: "italic",
          fontSize: "clamp(1.1rem, 2.3vw, 1.6rem)",
          color: CHROME_INK,
          textShadow: CHROME_SHADOW,
        }}
      >
        let&rsquo;s try a different name.
      </p>
      <a
        href="/"
        className="transition-opacity hover:opacity-70"
        style={{
          color: `color-mix(in srgb, ${CHROME_INK} 88%, transparent)`,
          fontFamily: "var(--font-serif)",
          fontStyle: "italic",
          fontSize: "0.95rem",
          textDecoration: "underline",
          textUnderlineOffset: "5px",
          textDecorationThickness: "0.5px",
          textShadow: CHROME_SHADOW,
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

function NavRule() {
  // Editorial page-divider broken by a centered fleuron. Two half-rules
  // with a soft gradient fade at the page edges — feels like a newspaper
  // masthead trailing off into the margins. Sienna on cream paper.
  const rule =
    "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--nav-accent) 45%, transparent) 14%, color-mix(in srgb, var(--nav-accent) 45%, transparent) 100%)";
  const ruleFlip =
    "linear-gradient(90deg, color-mix(in srgb, var(--nav-accent) 45%, transparent) 0%, color-mix(in srgb, var(--nav-accent) 45%, transparent) 86%, transparent 100%)";
  return (
    <div className="shrink-0 px-6 sm:px-10 pb-2">
      <div className="relative flex w-full items-center gap-3">
        <div className="h-px flex-1" style={{ background: rule }} />
        <span
          aria-hidden
          className="flex shrink-0 items-center justify-center"
          style={{
            color: "color-mix(in srgb, var(--nav-accent) 85%, transparent)",
          }}
        >
          <Fleuron size={7} />
        </span>
        <div className="h-px flex-1" style={{ background: ruleFlip }} />
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

// Always-visible row of tiny clickable thumbnails — a glanceable history
// of recent cartes. Each thumb is a scaled-down iframe of /api/preview;
// click to navigate. The current job gets a stronger outline.
function HistoryStrip({
  currentJobId,
  refreshKey,
}: {
  currentJobId: string | null;
  refreshKey: number;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ArchiveItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API_URL}/api/generations?limit=8`, {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as ArchiveItem[];
        if (!cancelled) setItems(data);
      } catch {
        // silent — strip just stays empty
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, currentJobId]);

  if (items.length === 0) return null;

  // Internal iframe size + uniform scale: cards render content with vh/vw
  // so any 16:9 frame composes correctly. Scaling a 1280x720 frame to
  // 80x45 (factor 0.0625) keeps the math clean and avoids per-thumb
  // calculation.
  const THUMB_W = 80;
  const THUMB_H = 45;
  const FRAME_W = 1280;
  const FRAME_H = 720;
  const SCALE = THUMB_W / FRAME_W;

  return (
    <div
      className="fade-up flex shrink-0 items-center justify-center gap-2 px-6 pb-3 pt-1"
      style={{ animationDelay: "420ms" }}
    >
      {items.map((it) => {
        const isCurrent = it.job_id === currentJobId;
        const previewUrl = `${API_URL}/api/preview/${encodeURIComponent(it.job_id)}`;
        return (
          <button
            key={it.job_id}
            type="button"
            onClick={() => {
              if (isCurrent) return;
              router.push(`/sandbox?job_id=${encodeURIComponent(it.job_id)}`);
            }}
            title={new Date(it.created_at).toLocaleString()}
            aria-label={`open carte from ${new Date(it.created_at).toLocaleString()}`}
            className="block bg-transparent p-0 outline-none transition-opacity duration-200 hover:opacity-100"
            style={{
              cursor: isCurrent ? "default" : "pointer",
              opacity: isCurrent ? 1 : 0.6,
            }}
          >
            <div
              className="relative overflow-hidden rounded-[3px]"
              style={{
                width: THUMB_W,
                height: THUMB_H,
                background: "#1F3A2E",
                outline: isCurrent
                  ? `1.5px solid ${CHROME_INK}`
                  : `1px solid color-mix(in srgb, ${CHROME_INK} 25%, transparent)`,
                outlineOffset: isCurrent ? 2 : 0,
                boxShadow: "0 2px 6px rgba(0,0,0,0.28)",
              }}
            >
              <iframe
                src={previewUrl}
                sandbox="allow-scripts"
                loading="lazy"
                aria-hidden
                tabIndex={-1}
                style={{
                  width: FRAME_W,
                  height: FRAME_H,
                  transform: `scale(${SCALE})`,
                  transformOrigin: "top left",
                  border: 0,
                  pointerEvents: "none",
                }}
              />
            </div>
          </button>
        );
      })}
    </div>
  );
}

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
        color: "color-mix(in srgb, var(--nav-accent) 80%, transparent)",
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
