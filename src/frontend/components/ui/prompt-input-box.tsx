"use client";

import { useEffect, useRef } from "react";
import { MorphingSpinner } from "./morphing-spinner";

const cn = (...classes: (string | undefined | null | false)[]) =>
  classes.filter(Boolean).join(" ");

interface PromptInputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  isLoading?: boolean;
  disabled?: boolean;
  maxHeight?: number;
  className?: string;
  autoFocus?: boolean;
}

export function PromptInputBox({
  value,
  onChange,
  onSubmit,
  placeholder = "Type a name…",
  isLoading = false,
  disabled = false,
  maxHeight = 240,
  className,
  autoFocus,
}: PromptInputBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !isLoading && value.trim().length > 0) onSubmit();
    }
  };

  const hasContent = value.trim().length > 0;
  const sendDisabled = disabled || isLoading || !hasContent;

  return (
    <div
      className={cn(
        "rounded-3xl border border-[#1F3A2E]/12 bg-[#FFFDF6] p-2 shadow-[0_18px_60px_-12px_rgba(31,58,46,0.22),0_4px_14px_-6px_rgba(31,58,46,0.12)] transition-all duration-300",
        isLoading && "border-[#1F3A2E]/35",
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        className="flex min-h-[44px] w-full resize-none rounded-md border-none bg-transparent px-3 py-2.5 text-base text-[#1F3A2E] placeholder:text-[#1F3A2E]/40 outline-none focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex items-center justify-end gap-2.5 pt-2">
        {isLoading && (
          <span
            className="text-[13px] italic text-[#1F3A2E]/65"
            style={{
              fontFamily: "var(--font-serif)",
              letterSpacing: "-0.01em",
            }}
            aria-hidden
          >
            loading
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            if (!sendDisabled) onSubmit();
          }}
          disabled={sendDisabled}
          aria-label={isLoading ? "Loading" : "Send"}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-full font-medium transition-all duration-200",
            isLoading
              ? "bg-[#1F3A2E] text-white"
              : hasContent
                ? "bg-[#1F3A2E] text-white hover:bg-[#1F3A2E]/85"
                : "bg-transparent text-[#1F3A2E]/45 hover:bg-[#1F3A2E]/10 hover:text-[#1F3A2E]/75",
            sendDisabled && !isLoading && "cursor-not-allowed",
          )}
        >
          {isLoading ? (
            <MorphingSpinner size="sm" color="#FFFDF6" className="!w-4 !h-4" />
          ) : (
            <ArrowUp />
          )}
        </button>
      </div>
    </div>
  );
}

function ArrowUp() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}

