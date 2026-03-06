import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-colors outline-none disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Primary: subtle accent, not a loud colored pill
        default: "bg-[rgba(var(--accent-rgb),0.15)] text-[var(--accent)] hover:bg-[rgba(var(--accent-rgb),0.25)]",
        // Destructive: muted red, not a fire truck
        destructive:
          "bg-red-500/10 text-red-400 hover:bg-red-500/20",
        // Outline: thin border, blends in
        outline:
          "border border-[var(--surface-border)] text-[var(--text-secondary)] hover:bg-[var(--background-elevated)] hover:text-[var(--text-primary)]",
        // Secondary: filled but muted
        secondary:
          "bg-[var(--background-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
        // Ghost: invisible until hover
        ghost:
          "text-[var(--text-secondary)] hover:bg-[var(--background-elevated)] hover:text-[var(--text-primary)]",
        // Link: just text
        link: "text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3 text-[13px] has-[>svg]:px-2.5",
        xs: "h-6 gap-1 rounded px-2 text-[11px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 rounded px-2.5 text-[12px] has-[>svg]:px-2",
        lg: "h-9 rounded-md px-5 text-sm has-[>svg]:px-4",
        icon: "size-8",
        "icon-xs": "size-6 rounded [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
