"use client";

import Image from "next/image";
import { SetStateAction, useEffect, useState } from "react";

import ThreeScene from "./components/ThreeScene";
import MissionInput from "./components/MissionInput";
import { WebSocketProvider } from "./components/WebSocketContext";
import { PlanOverview } from "./components/PlanOverview";
import { LogTerminal } from "./components/LogTerminal";
import IndicatorGroup from "./components/IndicatorGroup";
import { Card } from "@/components/ui/card";

const MAP_NAME = "hurricane_map";

export default function Home() {
  const [selectedIndicator, setSelectedIndicator] = useState("crosshair");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const create = async () => {
      try {
        const response = await fetch("/api/py/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ map_name: MAP_NAME }),
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.detail || result.error || "Failed to create session");
        }
        if (!cancelled) setSessionId(result.session_id);
      } catch (err: any) {
        if (!cancelled) setSessionError(err?.message || "Failed to create session");
      }
    };
    create();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectIndicator = (option: SetStateAction<string>) => {
    setSelectedIndicator(option);
  };

  if (!sessionId) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="ops-mono text-xs text-muted-foreground">
          {sessionError || "Creating session…"}
        </p>
      </div>
    );
  }

  return (
    <WebSocketProvider sessionId={sessionId}>
      <div className="flex h-screen overflow-hidden bg-background">
        <aside className="flex w-[380px] min-w-[320px] max-w-[420px] shrink-0 flex-col gap-3 border-r border-border bg-gradient-to-b from-tac-bg via-background to-tac-elevated/40 p-3">
          <Card className="flex items-center gap-3 border-primary/20 bg-tac-panel px-3 py-2 shadow-sm">
            <Image
              src="/images/logo.jpg"
              alt="Agent Armada"
              width={36}
              height={36}
              className="rounded-sm ring-1 ring-primary/25"
            />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold tracking-wide text-tac-text">
                Agent Armada
              </h1>
              <p className="ops-mono text-[10px] uppercase tracking-[0.14em] text-primary">
                COP · Multi-agent
              </p>
            </div>
          </Card>

          <PlanOverview />
          <MissionInput />
          <IndicatorGroup selected={selectedIndicator} onSelect={handleSelectIndicator} />
          <LogTerminal />
        </aside>

        <main className="relative min-w-0 flex-1 bg-background">
          <ThreeScene mapName={MAP_NAME} selectedIndicator={selectedIndicator} />
        </main>
      </div>
    </WebSocketProvider>
  );
}
