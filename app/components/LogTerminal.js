"use client";

import React, { useMemo } from "react";
import { useWebSocketData } from "./WebSocketContext";
import { ScrollArea } from "@/components/ui/scroll-area";
import { OpsPanel } from "@/components/OpsPanel";

function formatEvent(event) {
  const type = event.type || "event";
  if (type === "detection") {
    return `A${event.agent_id} · detected · ${event.object}`;
  }
  if (type === "plan") {
    return `plan v${event.version} published`;
  }
  if (type === "task_success") {
    return `${event.task_id} · success`;
  }
  if (type === "task_fail") {
    return `${event.task_id} · fail · ${event.reason || "timeout"}`;
  }
  if (type === "stall") {
    return `${event.task_id} · stalled`;
  }
  if (type === "plan_error") {
    return `plan error · ${event.error}`;
  }
  if (type === "on_event") {
    return `queued ${event.action} ${event.object}`;
  }
  if (type === "plan_metrics") {
    const ms = event.elapsed_ms != null ? `${event.elapsed_ms}ms` : "";
    const repairs = event.repairs != null ? ` repairs ${event.repairs}` : "";
    return `plan metrics · ${ms}${repairs}`;
  }
  if (type === "abort") {
    return "session aborted";
  }
  if (type === "complete") {
    return `plan v${event.version} complete`;
  }
  return type;
}

export const LogTerminal = () => {
  const { events, agent_detections } = useWebSocketData();
  const entries = useMemo(() => {
    if (Array.isArray(events) && events.length) {
      return events.map((event) => ({
        key: event.id || `${event.t}-${event.type}`,
        text: formatEvent(event),
      }));
    }
    if (agent_detections && typeof agent_detections === "object") {
      return Object.entries(agent_detections).map(([agentId, objectName]) => ({
        key: `det-${agentId}-${objectName}`,
        text: `A${agentId} · detected · ${objectName}`,
      }));
    }
    return [];
  }, [events, agent_detections]);

  return (
    <OpsPanel title="System log" fill contentClassName="p-0">
      <ScrollArea className="h-full">
        <ul className="ops-mono space-y-1.5 p-3 text-[11px] leading-relaxed text-muted-foreground">
          {entries.length === 0 ? (
            <li className="text-muted-foreground/80">No events yet.</li>
          ) : (
            entries.map((entry) => (
              <li key={entry.key}>
                <span className="text-foreground">{entry.text}</span>
              </li>
            ))
          )}
        </ul>
      </ScrollArea>
    </OpsPanel>
  );
};
