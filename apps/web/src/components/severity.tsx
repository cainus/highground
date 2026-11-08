import type { RadarCollision } from "@highground/core";
import { AlertOctagon, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

const STYLE = {
  HIGH: { icon: AlertOctagon, color: "text-critical", ring: "border-critical" },
  MEDIUM: { icon: AlertTriangle, color: "text-serious", ring: "border-serious" },
  LOW: { icon: Info, color: "text-warning", ring: "border-warning" },
} as const;

/** A severity as status: icon and label, never colour alone. */
export function Severity({
  level,
  className,
}: {
  level: RadarCollision["severity"];
  className?: string;
}) {
  const { icon: Icon, color, ring } = STYLE[level];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-semibold text-primary",
        ring,
        className,
      )}
    >
      <Icon aria-hidden className={cn("size-3.5", color)} />
      {level}
    </span>
  );
}
