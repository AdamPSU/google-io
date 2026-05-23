"use client";

import { useMemo, useRef, useState } from "react";

// A sticky note reads as a sticky note — canary yellow paper, dark ink.
// Deliberately NOT tied to the LLM palette: when the card flips to green
// or navy, the sticky note stays the universally legible "post-it on the
// desk" object. The carte is themed; the note is constant.
const PAPER = "#FBE48C";
const INK = "#1F1B16";

type Props = {
  businessName: string | null;
  ready: boolean;
  /** Real email extracted from the business's website. Preferred over the
   *  domain-derived fallback when present. */
  email?: string | null;
  /** Used to derive a plausible `info@{domain}` address when no real email
   *  was found in the site's HTML. */
  websiteUri?: string | null;
};

function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function NoteToBusiness({
  businessName,
  ready,
  email,
  websiteUri,
}: Props) {
  const [note, setNote] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Real email > domain-derived `info@{site}` > nothing. Both fallbacks
  // keep the note feeling addressed to a real recipient even before the
  // BusinessContext fetch resolves.
  const resolvedEmail = useMemo(() => {
    if (email) return email;
    const domain = domainOf(websiteUri);
    return domain ? `info@${domain}` : null;
  }, [email, websiteUri]);

  // Send is intentionally a no-op — this pane is a "vibe" element on the
  // sandbox; the button is decorative, not a real outbound action. Keep
  // it visible/styled but inert.
  const send = () => {};

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Swallow Cmd/Ctrl+Enter so the textarea doesn't fire a stray submit
    // on a form somewhere up the tree; no action triggered.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
    }
  }

  return (
    <aside
      aria-label={`leave a note for ${businessName ?? "this business"}`}
      className="paper-settle relative shrink-0 self-center"
      style={{
        width: "var(--note-w, 360px)",
        animationDelay: ready ? "480ms" : "0ms",
      }}
    >
      <div
        className="relative flex flex-col overflow-hidden"
        style={{
          // Sticky-note paper, with a faint darker band at the top edge
          // that reads as the adhesive gum strip.
          background: `linear-gradient(to bottom, rgba(0,0,0,0.07) 0, rgba(0,0,0,0) 14px), ${PAPER}`,
          border: `1px solid color-mix(in srgb, ${INK} 8%, transparent)`,
          borderRadius: 4,
          padding: "1.5rem 1.5rem 1.25rem",
          color: INK,
          boxShadow: [
            `0 1px 0 color-mix(in srgb, ${INK} 12%, transparent)`,
            `0 10px 20px -8px color-mix(in srgb, ${INK} 22%, transparent)`,
            `0 30px 60px -28px color-mix(in srgb, ${INK} 34%, transparent)`,
          ].join(", "),
        }}
      >
        <PaperNoise />

        <h2
          className="m-0 flex items-baseline gap-1.5"
          style={{
            fontFamily: "var(--font-hand)",
            fontWeight: 700,
            fontSize: "2rem",
            lineHeight: 1,
            letterSpacing: "-0.005em",
            color: INK,
            WebkitTextStroke: `0.4px ${INK}`,
          }}
        >
          <span>say hi to them</span>
          <PenArrow />
        </h2>

        <div className="mt-3">
          <div
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "0.62rem",
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: `color-mix(in srgb, ${INK} 55%, transparent)`,
            }}
          >
            to —
          </div>
          <div
            className="truncate"
            style={{
              fontFamily: "var(--font-serif)",
              fontStyle: "italic",
              fontSize: "1.1rem",
              lineHeight: 1.2,
              marginTop: "0.18rem",
              color: businessName
                ? INK
                : `color-mix(in srgb, ${INK} 35%, transparent)`,
            }}
            title={businessName ?? ""}
          >
            {businessName ?? "—"}
          </div>
          <div
            className="truncate"
            style={{
              fontFamily: "var(--font-sans)",
              fontSize: "0.78rem",
              letterSpacing: "0.005em",
              color: resolvedEmail
                ? `color-mix(in srgb, ${INK} 75%, transparent)`
                : `color-mix(in srgb, ${INK} 35%, transparent)`,
              marginTop: "0.1rem",
            }}
          >
            {resolvedEmail ?? "—"}
          </div>
        </div>

        <SquigglyDivider />

        <label className="sr-only" htmlFor="note-textarea">
          your note
        </label>
        <textarea
          id="note-textarea"
          ref={taRef}
          rows={6}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          placeholder="i made a little card for your business. hope it makes you smile."
          className="block w-full resize-none border-0 bg-transparent px-0 outline-none placeholder:opacity-60"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "0.95rem",
            fontWeight: 500,
            lineHeight: "28px",
            color: INK,
            minHeight: 168,
            opacity: 1,
            backgroundImage: `linear-gradient(to top, color-mix(in srgb, ${INK} 14%, transparent) 1px, transparent 1px)`,
            backgroundSize: "100% 28px",
            backgroundAttachment: "local",
            backgroundOrigin: "content-box",
            backgroundClip: "content-box",
          }}
        />

        <div className="mt-3 flex items-end justify-between">
          <CharCount n={note.length} />
          {/* Send is intentionally inert — see send() above. */}
          <SendLink onClick={send} />
        </div>
      </div>
    </aside>
  );
}

function PaperNoise() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      style={{
        opacity: 0.07,
        mixBlendMode: "multiply",
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.92' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.55 0'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)'/%3E%3C/svg%3E\")",
        backgroundSize: "220px 220px",
      }}
    />
  );
}

function PenArrow() {
  return (
    <svg
      width="22"
      height="20"
      viewBox="0 0 22 20"
      fill="none"
      aria-hidden
      style={{ transform: "translateY(-3px)", overflow: "visible" }}
    >
      <path
        d="M2 17 Q 7 12, 12 8 T 20 2"
        stroke={INK}
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M13 2 L 20 2 L 20 9"
        stroke={INK}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function SquigglyDivider() {
  return (
    <svg
      aria-hidden
      width="100%"
      height="5"
      viewBox="0 0 240 5"
      preserveAspectRatio="none"
      style={{
        display: "block",
        marginTop: "0.95rem",
        marginBottom: "0.45rem",
        opacity: 0.32,
      }}
    >
      <path
        d="M0 2.5 Q 6 0, 12 2.5 T 24 2.5 T 36 2.5 T 48 2.5 T 60 2.5 T 72 2.5 T 84 2.5 T 96 2.5 T 108 2.5 T 120 2.5 T 132 2.5 T 144 2.5 T 156 2.5 T 168 2.5 T 180 2.5 T 192 2.5 T 204 2.5 T 216 2.5 T 228 2.5 T 240 2.5"
        stroke={INK}
        strokeWidth="0.7"
        fill="none"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CharCount({ n }: { n: number }) {
  return (
    <span
      aria-hidden
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "0.62rem",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: `color-mix(in srgb, ${INK} 45%, transparent)`,
        opacity: n === 0 ? 0 : 1,
        transition: "opacity 200ms ease-out",
        minHeight: "1rem",
      }}
    >
      {n} {n === 1 ? "mark" : "marks"}
    </span>
  );
}

function SendLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative inline-flex items-center gap-1.5 bg-transparent p-0 outline-none"
      style={{
        cursor: "pointer",
        color: INK,
        fontFamily: "var(--font-hand)",
        fontWeight: 700,
        fontSize: "1.35rem",
        lineHeight: 1,
        WebkitTextStroke: `0.35px ${INK}`,
      }}
    >
      <span>send it</span>
      <span
        aria-hidden
        className="inline-flex transition-transform duration-200 ease-out group-hover:translate-x-[3px]"
        style={{ transform: "translateY(1px)" }}
      >
        <ArrowGlyph />
      </span>
      <HoverSquiggle />
    </button>
  );
}

function ArrowGlyph() {
  return (
    <svg
      width="22"
      height="12"
      viewBox="0 0 22 12"
      fill="none"
      aria-hidden
      style={{ display: "block", overflow: "visible" }}
    >
      <path
        d="M1 6 L 20 6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M15 1.5 L 20 6 L 15 10.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function HoverSquiggle() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-0 right-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
      style={{ bottom: -6 }}
    >
      <svg width="100%" height="5" viewBox="0 0 80 5" preserveAspectRatio="none">
        <path
          d="M0 2.5 Q 5 0, 10 2.5 T 20 2.5 T 30 2.5 T 40 2.5 T 50 2.5 T 60 2.5 T 70 2.5 T 80 2.5"
          stroke={INK}
          strokeWidth="0.9"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

