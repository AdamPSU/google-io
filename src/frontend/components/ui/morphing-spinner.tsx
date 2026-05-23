"use client";

const cn = (...classes: (string | undefined | null | false)[]) =>
  classes.filter(Boolean).join(" ");

interface MorphingSpinnerProps {
  size?: "sm" | "md" | "lg";
  color?: string;
  className?: string;
}

const sizeClasses: Record<NonNullable<MorphingSpinnerProps["size"]>, string> = {
  sm: "w-6 h-6",
  md: "w-8 h-8",
  lg: "w-12 h-12",
};

export function MorphingSpinner({
  size = "md",
  color = "#191512",
  className,
}: MorphingSpinnerProps) {
  return (
    <div className={cn("relative", sizeClasses[size], className)}>
      <div
        className="morph absolute inset-0"
        style={{ background: color }}
        aria-hidden
      />
    </div>
  );
}
