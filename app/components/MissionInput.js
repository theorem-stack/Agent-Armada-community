"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { OpsPanel } from "@/components/OpsPanel";
import { useWebSocketData } from "./WebSocketContext";

const MissionInput = () => {
  const { sessionId, session_status, error: sessionError } = useWebSocketData();
  const [missionStatement, setMissionStatement] = useState("");
  const [responseMessage, setResponseMessage] = useState(null);
  const [responseOk, setResponseOk] = useState(true);

  const planning = session_status === "planning";

  const handleSubmit = async () => {
    if (!missionStatement.trim()) {
      setResponseOk(false);
      setResponseMessage("Mission statement cannot be empty.");
      return;
    }
    if (!sessionId) {
      setResponseOk(false);
      setResponseMessage("Session is not ready.");
      return;
    }

    setResponseMessage(null);

    try {
      const response = await fetch(`/api/py/sessions/${sessionId}/mission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_mission_statement: missionStatement }),
      });
      const result = await response.json();
      if (response.ok && result.ok !== false) {
        setResponseOk(true);
        setResponseMessage(result.status || "Planning");
      } else {
        setResponseOk(false);
        setResponseMessage(result.error || result.status || "Failed to send mission input.");
      }
    } catch (error) {
      console.error("Error:", error);
      setResponseOk(false);
      setResponseMessage("An error occurred while submitting.");
    }
  };

  const handleAbort = async () => {
    if (!sessionId) return;
    try {
      const response = await fetch(`/api/py/sessions/${sessionId}/abort`, {
        method: "POST",
      });
      const result = await response.json();
      if (response.ok) {
        setResponseOk(true);
        setResponseMessage(result.status || "Session aborted.");
      } else {
        setResponseOk(false);
        setResponseMessage(result.error || "Failed to abort.");
      }
    } catch (error) {
      setResponseOk(false);
      setResponseMessage("An error occurred while aborting.");
    }
  };

  const displayError = sessionError || (!responseOk ? responseMessage : null);
  const displayOkMessage = !displayError && (planning ? "Planning" : responseMessage);

  return (
    <OpsPanel title="Mission statement">
      <p className="ops-mono mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {session_status || "idle"}
      </p>
      <Textarea
        id="mission"
        value={missionStatement}
        onChange={(e) => setMissionStatement(e.target.value)}
        placeholder="Enter mission objectives…"
        rows={3}
        className="ops-mono resize-none text-xs"
      />
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={planning}
          className="w-full uppercase tracking-wider"
          size="sm"
        >
          {planning ? (
            <>
              <Loader2 className="animate-spin" />
              Planning…
            </>
          ) : (
            "Send mission"
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handleAbort}
          className="uppercase tracking-wider"
          size="sm"
        >
          Abort
        </Button>
      </div>
      {(displayError || displayOkMessage) && (
        <p
          className={`ops-mono mt-2 text-center text-[11px] ${
            displayError ? "text-destructive" : "text-success"
          }`}
        >
          {displayError || displayOkMessage}
        </p>
      )}
    </OpsPanel>
  );
};

export default MissionInput;
