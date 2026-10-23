"use client";

import { useWebSocketData } from "./WebSocketContext";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { OpsPanel } from "@/components/OpsPanel";

const STATUS_VARIANT = {
  pending: "warning",
  active: "warning",
  success: "success",
  fail: "destructive",
};

const STATUS_LABEL = {
  pending: "Pending",
  active: "Active",
  success: "Done",
  fail: "Fail",
};

export const PlanOverview = () => {
  const { plan, plan_progress } = useWebSocketData();
  const tasks = plan?.tasks || [];
  const taskStatus = plan?.task_status || {};

  const eventRules = plan?.on_event || [];
  const fallbackSteps = plan_progress ? Object.entries(plan_progress) : [];

  if (!tasks.length && !fallbackSteps.length) {
    return (
      <OpsPanel title="System plan" className="h-56" contentClassName="flex h-full items-center justify-center">
        <p className="ops-mono text-xs text-muted-foreground">Waiting for plan updates…</p>
      </OpsPanel>
    );
  }

  const rows = tasks.length
    ? tasks.map((task) => {
        const status = taskStatus[task.id] || "pending";
        return {
          key: task.id,
          title: task.action,
          detail: task.objective || task.id,
          status,
        };
      })
    : fallbackSteps.map(([step, data]) => ({
        key: step,
        title: data.action ? `${data.action}` : `Step ${step}`,
        detail: data.objective,
        status: data.status || (data.completed ? "success" : "pending"),
      }));

  return (
    <OpsPanel title="System plan" className="h-56" contentClassName="overflow-hidden p-0">
      <ScrollArea className="h-full">
        <div className="space-y-0 px-3 py-2">
          {eventRules.length ? (
            <p className="ops-mono pb-2 text-[11px] leading-snug text-muted-foreground">
              {eventRules
                .map(
                  (rule) =>
                    `on ${rule.when}(${rule.object_type}) → ${rule.then?.action || "task"}`
                )
                .join(" · ")}
            </p>
          ) : null}
          {rows.map((row, index) => (
            <div key={row.key}>
              <div className="flex items-start justify-between gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <h4 className="ops-mono text-xs font-medium text-foreground">
                    {row.title}
                  </h4>
                  <p className="ops-mono mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {row.detail}
                  </p>
                </div>
                <Badge variant={STATUS_VARIANT[row.status] || "warning"}>
                  {STATUS_LABEL[row.status] || row.status}
                </Badge>
              </div>
              {index < rows.length - 1 ? <Separator /> : null}
            </div>
          ))}
        </div>
      </ScrollArea>
    </OpsPanel>
  );
};
