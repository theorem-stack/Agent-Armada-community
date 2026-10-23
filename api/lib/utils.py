import numpy as np
import math

from ..config import TERRAIN_HEIGHT_MAP, ENV_WIDTH, ENV_HEIGHT, MAP_WIDTH, MAP_HEIGHT

def get_height_at_position(x, y):
    """Fetch the height using bilinear interpolation at the given screen position (x, y)."""
    # Normalize to the height map grid
    # Scale X, Y to the height map size
    map_x = (x / ENV_WIDTH) * (MAP_WIDTH - 1)
    map_y = (y / ENV_HEIGHT) * (MAP_HEIGHT - 1)
    
    # Get the floor and ceil indices
    x0 = int(np.floor(map_x))
    x1 = min(x0 + 1, MAP_WIDTH - 1)
    y0 = int(np.floor(map_y))
    y1 = min(y0 + 1, MAP_HEIGHT - 1)

    # Get the heights at the corners of the square
    h00 = TERRAIN_HEIGHT_MAP[y0, x0]  # Bottom left
    h01 = TERRAIN_HEIGHT_MAP[y0, x1]  # Bottom right
    h10 = TERRAIN_HEIGHT_MAP[y1, x0]  # Top left
    h11 = TERRAIN_HEIGHT_MAP[y1, x1]  # Top right

    # Calculate the weights for interpolation
    tx = map_x - x0  # Weight in x-direction
    ty = map_y - y0  # Weight in y-direction

    # Perform bilinear interpolation
    height = (h00 * (1 - tx) * (1 - ty) +
              h01 * tx * (1 - ty) +
              h10 * (1 - tx) * ty +
              h11 * tx * ty)

    return height

def get_gradient_at_position(x, y):
        """Calculate the gradient (slope) at the given position from the height map."""
        grid_x = int(min(max(x / ENV_WIDTH * MAP_WIDTH, 1), MAP_WIDTH - 2))
        grid_y = int(min(max(y / ENV_HEIGHT * MAP_HEIGHT, 1), MAP_HEIGHT - 2))
        
        # Compute finite differences for gradient
        dx = TERRAIN_HEIGHT_MAP[grid_y, grid_x + 1] - TERRAIN_HEIGHT_MAP[grid_y, grid_x - 1]
        dy = TERRAIN_HEIGHT_MAP[grid_y + 1, grid_x] - TERRAIN_HEIGHT_MAP[grid_y - 1, grid_x]
    
        # Return gradient vector (influence on X and Y)
        return np.array([dx, dy], dtype=float)

def _to_xy(point) -> tuple[float, float]:
    """Coerce a point (tuple, list, or numpy array) to an (x, y) pair."""
    if point is None:
        raise ValueError("Coordinate point is None")
    return float(point[0]), float(point[1])


def evaluate_coordinates(target_coordinates,
                         current_coordinates,
                         tolerance: float) -> bool:
    """
    Compares a set of target coordinates to the current coordinates with a given tolerance.

    Args:
        target_coordinates: list of target (x, y) coordinates.
        current_coordinates: list of current (x, y) coordinates to compare.
        tolerance (float): Allowed maximum distance between target and current points.

    Returns:
        bool: True if all corresponding coordinates are within the tolerance, False otherwise.
    """
    if not target_coordinates or not current_coordinates:
        raise ValueError("Target and current coordinates must be non-empty.")

    if len(target_coordinates) != len(current_coordinates):
        raise ValueError("The number of target and current coordinates must match.")

    for i in range(len(target_coordinates)):
        target_x, target_y = _to_xy(target_coordinates[i])
        current_x, current_y = _to_xy(current_coordinates[i])

        distance = math.sqrt((target_x - current_x)**2 + (target_y - current_y)**2)

        if distance > tolerance:
            return False

    return True
