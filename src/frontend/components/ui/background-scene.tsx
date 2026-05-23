/**
 * The shared dark-video stage used on both the landing page and the
 * sandbox. Three layered fixtures behind the content:
 *
 *   1. Blurred looping video (`/final-bg.mp4`) — `-z-30`
 *   2. Reduced-motion fallback fill (`#191512`) — `-z-40`
 *   3. Dark vignette scrim — `-z-20`
 *   4. Subtle SVG film-grain — `-z-10`
 *
 * Mount it as the first child of a parent that has `position: relative;
 * isolation: isolate;` and `overflow: hidden;` so the negative z-indices
 * stay contained.
 */
export function BackgroundScene() {
  return (
    <>
      <video
        className="absolute inset-0 -z-30 h-full w-full object-cover motion-reduce:hidden"
        src="/final-bg.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        disableRemotePlayback
        aria-hidden
        style={{ filter: "blur(3px) saturate(1.05)", transform: "scale(1.03)" }}
      />
      <div
        className="absolute inset-0 -z-40 hidden motion-reduce:block"
        aria-hidden
        style={{ background: "#191512" }}
      />
      <div
        className="pointer-events-none absolute inset-0 -z-20"
        aria-hidden
        style={{
          background:
            "linear-gradient(180deg, rgba(25,21,18,0.55) 0%, rgba(25,21,18,0.32) 35%, rgba(25,21,18,0.32) 65%, rgba(25,21,18,0.55) 100%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        aria-hidden
        style={{
          opacity: 0.08,
          mixBlendMode: "overlay",
          backgroundImage:
            "url(\"data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 220 220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.6 0'/%3E%3C/filter%3E%3Crect width='220' height='220' filter='url(%23n)'/%3E%3C/svg%3E\")",
          backgroundSize: "220px 220px",
        }}
      />
    </>
  );
}
