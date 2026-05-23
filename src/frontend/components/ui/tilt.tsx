"use client";

import { useRef, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Maximum tilt in degrees on either axis. */
  max?: number;
  /** Perspective depth in pixels — smaller = stronger 3D effect. */
  perspective?: number;
  className?: string;
};

/**
 * Wrap a card to give it a cursor-following 3D tilt on hover. Ported from
 * AdamPSU/portfolio's ThreeDCard: mouse offset from the element's center
 * drives rotateX/rotateY, rAF-throttled, with a smooth return to rest on
 * mouseleave. The outer container holds perspective so children can
 * compose translateZ if needed; the inner element receives the transform.
 *
 * Animations on descendants (fade-up, paper-settle) compose cleanly
 * because they target their own elements — Tilt only writes to its inner
 * div.
 */
export function Tilt({
  children,
  max = 6,
  perspective = 1000,
  className,
}: Props) {
  const innerRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const lastRef = useRef<{ x: number; y: number } | null>(null);

  function handleMove(e: React.MouseEvent<HTMLDivElement>) {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    lastRef.current = { x: e.clientX, y: e.clientY };
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = innerRef.current;
      const pos = lastRef.current;
      if (!el || !pos) return;
      const { left, top, width, height } = el.getBoundingClientRect();
      const px = (pos.x - left) / width - 0.5;
      const py = (pos.y - top) / height - 0.5;
      const rx = (-py * max * 2).toFixed(2);
      const ry = (px * max * 2).toFixed(2);
      el.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
    });
  }

  function handleLeave() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    const el = innerRef.current;
    if (el) el.style.transform = "";
  }

  return (
    <div
      className={className}
      style={{ perspective: `${perspective}px` }}
    >
      <div
        ref={innerRef}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        className="transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{
          transformStyle: "preserve-3d",
          willChange: "transform",
        }}
      >
        {children}
      </div>
    </div>
  );
}
