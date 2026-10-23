import numpy as np
import pytest

from api.lib.utils import evaluate_coordinates


def test_evaluate_coordinates_within_tolerance():
    targets = [(0, 0), (10, 10)]
    current = [(1, 1), (9, 11)]
    assert evaluate_coordinates(targets, current, tolerance=2) is True


def test_evaluate_coordinates_outside_tolerance():
    targets = [(0, 0)]
    current = [(20, 0)]
    assert evaluate_coordinates(targets, current, tolerance=5) is False


def test_evaluate_coordinates_numpy_and_tuple():
    targets = [(5, 5), (1, 1)]
    current = [np.array([5.5, 4.5]), np.array([1.0, 1.2])]
    assert evaluate_coordinates(targets, current, tolerance=1.0) is True


def test_evaluate_coordinates_length_mismatch():
    with pytest.raises(ValueError):
        evaluate_coordinates([(0, 0)], [(0, 0), (1, 1)], tolerance=1)


def test_evaluate_coordinates_empty():
    with pytest.raises(ValueError):
        evaluate_coordinates([], [], tolerance=1)
