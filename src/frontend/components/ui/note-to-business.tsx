"use client";

import { useMemo, useRef, useState } from "react";

// A sticky note reads as a sticky note — canary yellow paper, dark ink,
// rust-red stamp. Deliberately NOT tied to the LLM palette: when the card
// flips to green or navy, the sticky note stays the universally legible
// "post-it on the desk" object. The carte is themed; the note is constant.
const PAPER = "#FBE48C";
const INK = "#1F1B16";
const STAMP = "#9B3A2A";

type Status = "idle" | "sending" | "sent";

type Props = {
  businessName: string | null;
  ready: boolean;
};

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "hello";
}

export function NoteToBusiness({ businessName, ready }: Props) {
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const email = useMemo(
    () => `hello@${slugify(businessName ?? "")}.com`,
    [businessName],
  );

  const idle = status === "idle";
  const canSend = idle && note.trim().length > 0 && !!businessName;

  function send() {
    if (!canSend) return;
    setStatus("sending");
    window.setTimeout(() => setStatus("sent"), 850);
  }

  function reset() {
    setNote("");
    setStatus("idle");
    requestAnimationFrame(() => taRef.current?.focus());
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
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
              fontSize: "0.74rem",
              letterSpacing: "0.005em",
              color: `color-mix(in srgb, ${INK} ${businessName ? 60 : 35}%, transparent)`,
              marginTop: "0.1rem",
            }}
          >
            {email}
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
          disabled={!businessName || !idle}
          spellCheck={false}
          placeholder={
            !businessName
              ? "the carte's almost ready…"
              : "i made a little card for your business. hope it makes you smile."
          }
          className="block w-full resize-none border-0 bg-transparent px-0 outline-none placeholder:opacity-50 disabled:opacity-50"
          style={{
            fontFamily: "var(--font-sans)",
            fontSize: "0.9rem",
            lineHeight: "28px",
            color: INK,
            minHeight: 168,
            opacity:
              status === "sent" ? 0.42 : status === "sending" ? 0.85 : 1,
            transition: "opacity 220ms ease-out",
            backgroundImage: `linear-gradient(to top, color-mix(in srgb, ${INK} 14%, transparent) 1px, transparent 1px)`,
            backgroundSize: "100% 28px",
            backgroundAttachment: "local",
            backgroundOrigin: "content-box",
            backgroundClip: "content-box",
          }}
          aria-busy={status === "sending"}
        />

        <div className="mt-3 flex items-end justify-between">
          <CharCount n={note.length} dimmed={status === "sent"} />
          {status === "sent" ? (
            <ResetLink onClick={reset} />
          ) : (
            <SendLink
              busy={status === "sending"}
              disabled={!canSend}
              onClick={send}
            />
          )}
        </div>

        {status === "sent" && <SentStamp />}
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

function CharCount({ n, dimmed }: { n: number; dimmed?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        fontFamily: "var(--font-sans)",
        fontSize: "0.62rem",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: `color-mix(in srgb, ${INK} 45%, transparent)`,
        opacity: n === 0 ? 0 : dimmed ? 0.5 : 1,
        transition: "opacity 200ms ease-out",
        minHeight: "1rem",
      }}
    >
      {n} {n === 1 ? "mark" : "marks"}
    </span>
  );
}

function SendLink({
  busy,
  disabled,
  onClick,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className="group relative inline-flex items-center gap-1.5 bg-transparent p-0 outline-none"
      style={{
        cursor: disabled || busy ? "default" : "pointer",
        opacity: disabled ? 0.32 : 1,
        color: INK,
        fontFamily: "var(--font-hand)",
        fontWeight: 700,
        fontSize: "1.35rem",
        lineHeight: 1,
        WebkitTextStroke: `0.35px ${INK}`,
        transition: "opacity 200ms ease-out",
      }}
    >
      {busy ? (
        <>
          <span>writing it down</span>
          <span aria-hidden className="inline-flex translate-y-[1px] gap-[3px]">
            <Dot delay={0} />
            <Dot delay={180} />
            <Dot delay={360} />
          </span>
        </>
      ) : (
        <>
          <span>send it</span>
          <span
            aria-hidden
            className="inline-flex transition-transform duration-200 ease-out group-hover:translate-x-[3px]"
            style={{ transform: "translateY(1px)" }}
          >
            <ArrowGlyph />
          </span>
        </>
      )}
      {!disabled && !busy && <HoverSquiggle />}
    </button>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="ink-dot inline-block h-[3px] w-[3px] rounded-full"
      style={{ background: INK, animationDelay: `${delay}ms` }}
    />
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

function ResetLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="bg-transparent p-0 outline-none"
      style={{
        cursor: "pointer",
        color: `color-mix(in srgb, ${INK} 75%, transparent)`,
        fontFamily: "var(--font-hand)",
        fontWeight: 700,
        fontSize: "1.1rem",
        textDecoration: "underline",
        textUnderlineOffset: "3px",
        textDecorationThickness: "0.6px",
      }}
    >
      write another?
    </button>
  );
}

function SentStamp() {
  return (
    <div
      className="stamp-drop pointer-events-none absolute"
      aria-hidden
      style={{
        top: 14,
        right: 14,
        width: 84,
        height: 84,
        transformOrigin: "70% 30%",
      }}
    >
      <svg
        viewBox="0 0 100 100"
        width="84"
        height="84"
        style={{ overflow: "visible" }}
      >
        <circle
          cx="50"
          cy="50"
          r="44"
          fill="none"
          stroke={STAMP}
          strokeWidth="1.6"
          strokeDasharray="3 3"
          opacity="0.9"
        />
        <circle
          cx="50"
          cy="50"
          r="36"
          fill="none"
          stroke={STAMP}
          strokeWidth="0.8"
          opacity="0.7"
        />
        <defs>
          <path id="stamp-arc" d="M 20 50 A 30 30 0 0 1 80 50" />
        </defs>
        <text
          fill={STAMP}
          style={{
            fontFamily: "var(--font-hand)",
            fontWeight: 700,
            letterSpacing: "0.04em",
          }}
          fontSize="22"
        >
          <textPath href="#stamp-arc" startOffset="50%" textAnchor="middle">
            sent
          </textPath>
        </text>
        <g
          transform="translate(50 64)"
          stroke={STAMP}
          strokeWidth="1.2"
          fill="none"
          opacity="0.95"
        >
          <ellipse cx="0" cy="-5" rx="1.8" ry="4" />
          <ellipse cx="0" cy="5" rx="1.8" ry="4" />
          <ellipse cx="-5" cy="0" rx="4" ry="1.8" />
          <ellipse cx="5" cy="0" rx="4" ry="1.8" />
          <ellipse cx="-3.5" cy="-3.5" rx="3" ry="1.5" transform="rotate(-45 -3.5 -3.5)" />
          <ellipse cx="3.5" cy="3.5" rx="3" ry="1.5" transform="rotate(-45 3.5 3.5)" />
          <circle cx="0" cy="0" r="0.9" fill={STAMP} />
        </g>
      </svg>
    </div>
  );
}
