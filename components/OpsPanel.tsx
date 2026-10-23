import * as React from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type OpsPanelProps = {
  title?: string;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  headerClassName?: string;
  /** Stretch to fill remaining column height (log panel). */
  fill?: boolean;
};

/**
 * Shared ops-column shell so plan / mission / indicators / log share one chrome.
 */
export function OpsPanel({
  title,
  children,
  className,
  contentClassName,
  headerClassName,
  fill = false,
}: OpsPanelProps) {
  return (
    <Card
      className={cn(
        "flex flex-col overflow-hidden",
        fill && "min-h-0 flex-1",
        className
      )}
    >
      {title ? (
        <CardHeader
          className={cn(
            "relative border-b border-border/70 bg-tac-panel px-3 py-2",
            "before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary",
            fill && "sticky top-0 z-10",
            headerClassName
          )}
        >
          <CardTitle className="pl-1.5 text-tac-muted">{title}</CardTitle>
        </CardHeader>
      ) : null}
      <CardContent
        className={cn(
          "min-h-0 flex-1",
          title ? "pt-3" : undefined,
          fill && "overflow-hidden p-0",
          contentClassName
        )}
      >
        {children}
      </CardContent>
    </Card>
  );
}
