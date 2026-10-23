import numpy as np
from pathlib import Path

# Define the base directory
BASE_DIR = Path(__file__).resolve().parent

# SIMULATION ENVIRONMENT PARAMETERS
ENV_WIDTH, ENV_HEIGHT = 800, 600
# Known COP at spawn. People / vehicles stay hidden until a drone senses them.
START_DETECTED_TYPES = ("building", "flood", "tree", "container")
# Walk X-ray: detected contacts of these types, when occluded from the operator.
OBJECTS_OF_INTEREST = ("person",)
# Search succeeds on a detection of these types (not start-detected landmarks).
SEARCH_FIND_TYPES = ("person", "vehicle")
# Editor stamps: env-unit footprints centered on the drop point.
OBJECT_CATALOG = {
    "building": {
        "label": "Building",
        "prefix": "Building",
        "footprint": (20.0, 20.0),
        "condition": "intact",
    },
    "tree": {
        "label": "Tree",
        "prefix": "Tree",
        "footprint": (20.0, 20.0),
        "condition": "intact",
    },
    "container": {
        "label": "Container",
        "prefix": "Container",
        "footprint": (64.0, 24.0),
        "condition": "intact",
    },
    "person": {
        "label": "Person",
        "prefix": "Person",
        "footprint": (20.0, 20.0),
        "condition": "uninjured",
    },
    "vehicle": {
        "label": "Vehicle",
        "prefix": "Vehicle",
        "footprint": (20.0, 20.0),
        "condition": "intact",
    },
    "flood": {
        "label": "Flood",
        "prefix": "Flood",
        "footprint": (80.0, 80.0),
        "condition": "flooded",
    },
}
# Rally point for the swarm (env XY). North of the container on hurricane_map.
DEFAULT_SPAWN = (50.0, 180.0)
SPAWN_RADIUS = 30.0

# Clocks (original loop was ~100 Hz with sleep(0.01))
ORIGINAL_TICK_S = 0.01
PHYSICS_HZ = 30
PHYSICS_DT = 1.0 / PHYSICS_HZ
ASSESS_HZ = 10
ASSESS_DT = 1.0 / ASSESS_HZ
_TICK_SCALE = PHYSICS_DT / ORIGINAL_TICK_S

# Agent parameters
NUM_AGENTS = 20
MAX_SPEED = 2.5 * _TICK_SCALE  # units per physics tick (preserves 100 Hz feel)
MAX_FORCE = 0.1 * _TICK_SCALE
INIT_VELOCITY_SCALE = _TICK_SCALE
RADIUS = 100  # Perception radius for alignment, cohesion, separation
SENSOR_RANGE = RADIUS  # Downward cone max range (sim units)
SENSOR_HALF_ANGLE = 50.0  # Circular cone half-angle from nadir (degrees)
DEFAULT_Z = 50  # Default cruise altitude (sim units)
OBJECT_HEIGHTS = {
    "tree": 28.0,
    "building": 22.0,
    "container": 16.0,
    "person": 2.0,
    "vehicle": 2.0,
}
OCCLUDER_TYPES = ("tree", "building", "container")
COVERAGE_CELL_SIZE = RADIUS / 2
INVESTIGATE_STANDOFF = 30.0
INVESTIGATE_COUNT = 4
CONTACT_SPEED = 8.0  # People patrol speed (env units / second)
LOST_TICKS = 3  # Consecutive assess ticks with no observers
MOVE_THRESHOLD = 15.0  # Displacement that fires Moved

# AGENT BEHAVIOR PARAMETERS
ALIGNMENT_WEIGHT = 0
COHESION_WEIGHT = 0
SEPARATION_WEIGHT = 0.15
TARGET_WEIGHT = 1.5
OBSTACLE_WEIGHT = 0
TERRAIN_WEIGHT = 0.13

# DEBUG: Temporary, will be replaced by the LLM identified target and obstacle positions
NUM_TARGETS = 4
TARGET_RADIUS = 10
NUM_OBSTACLES = 3
OBSTACLE_RADIUS = 30

# DEBUG: Example height map (can be loaded from an external source)
TERRAIN_HEIGHT_MAP = np.array([
    [0, 0, 0, 0, 6],
    [2, 4, 0, 0, 0],
    [2, 0, 8, 0, 0],
    [0, 0, 0, 2, 0],
    [6, 0, 4, 4, 4]
])
MAP_WIDTH, MAP_HEIGHT = TERRAIN_HEIGHT_MAP.shape

# EVALUATION PARAMETERS
EVAL_TOLERANCE = 10
SEARCH_COVER_MIN = 0.95  # Search AOI coverage that counts as done without a find

# LLM PARAMETERS
LLM_PROMPT_SYSTEM_RESPONSE = "Hello World."
OPENAI_MODEL = "gpt-4o-mini"
MAX_TOKENS = 2000
TEMPERATURE = 0.2
PLAN_REPAIR_ATTEMPTS = 2