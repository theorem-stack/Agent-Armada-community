from __future__ import annotations

from typing import Optional

from .session import Session


class SessionStore:
    def __init__(self):
        self._sessions: dict[str, Session] = {}

    def add(self, session: Session) -> Session:
        self._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> Optional[Session]:
        return self._sessions.get(session_id)

    def remove(self, session_id: str) -> Optional[Session]:
        return self._sessions.pop(session_id, None)

    def __contains__(self, session_id: str) -> bool:
        return session_id in self._sessions
