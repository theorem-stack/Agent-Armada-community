// context/WebSocketContext.js
import React, { createContext, useContext, useState, useEffect, useRef } from "react";

const DEFAULT_DATA = {
  agents: {},
  targets: {},
  obstacles: {},
  agent_detections: {},
  new_detections: [],
  tracks: [],
  spawn: null,
  map_objects: null,
  plan_progress: {},
  plan: null,
  events: [],
  session_status: "idle",
  error: null,
};

const WebSocketContext = createContext({ ...DEFAULT_DATA, sessionId: null });

function wsUrl(sessionId) {
  const base = process.env.NEXT_PUBLIC_WS_URL || "ws://127.0.0.1:8000";
  return `${base.replace(/\/$/, "")}/ws/sessions/${sessionId}`;
}

export const WebSocketProvider = ({ sessionId, children }) => {
  const [data, setData] = useState(DEFAULT_DATA);
  const retryRef = useRef(0);
  const socketRef = useRef(null);

  useEffect(() => {
    if (!sessionId) return undefined;

    let cancelled = false;
    let timer = null;

    const connect = () => {
      if (cancelled) return;
      const socket = new WebSocket(wsUrl(sessionId));
      socketRef.current = socket;

      socket.onopen = () => {
        retryRef.current = 0;
      };

      socket.onmessage = (event) => {
        try {
          const messageData = JSON.parse(event.data);
          setData({ ...DEFAULT_DATA, ...messageData });
        } catch (err) {
          console.error("WS parse error", err);
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        const delay = Math.min(8000, 500 * 2 ** retryRef.current);
        retryRef.current += 1;
        timer = setTimeout(connect, delay);
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.close();
      }
    };
  }, [sessionId]);

  return (
    <WebSocketContext.Provider value={{ ...data, sessionId }}>
      {children}
    </WebSocketContext.Provider>
  );
};

export const useWebSocketData = () => useContext(WebSocketContext);
