import numpy as np

from api.simulation.agent import Agent
from api.simulation.environment import build_agent_payload
from api.config import DEFAULT_Z


def test_agent_payload_uses_z_position_key():
    agent = Agent(0, np.array([10.0, 20.0]), target_id=0, z_position=DEFAULT_Z)
    payload = build_agent_payload(agent)

    assert "z_position" in payload
    assert "z_positon" not in payload
    assert payload["z_position"] == DEFAULT_Z
    assert payload["position"] == [10.0, 20.0]
    assert "heading" in payload
    assert payload["role"] is None
    assert payload["group"] is None
