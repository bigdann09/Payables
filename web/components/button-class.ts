import { cn } from "@/lib/format";

export type Variant = "primary" | "secondary" | "ghost" | "danger";
export type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover border border-transparent shadow-sm",
  secondary: "bg-surface text-fg border border-border-strong hover:bg-surface-2",
  ghost: "text-muted hover:text-fg hover:bg-surface-2 border border-transparent",
  danger: "bg-danger text-white hover:opacity-90 border border-transparent",
};
const sizes: Record<Size, string> = {
  sm: "h-8 px-2.5 text-[13px] gap-1.5",
  md: "h-9 px-3.5 text-sm gap-2",
};

export const buttonClass = (variant: Variant = "primary", size: Size = "md", className?: string) =>
  cn(
    "inline-flex items-center justify-center rounded-md font-medium transition-colors whitespace-nowrap focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none",
    variants[variant],
    sizes[size],
    className,
  );

