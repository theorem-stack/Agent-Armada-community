def map_to_dict(map_objects):
    return [obj.convert_to_dict() for obj in map_objects]

def map_to_string(map_objects):
    """
    Converts a list of mapObject instances into a string where each object is on a new line.

    Parameters:
    - map_objects: List of mapObject instances.

    Returns:
    - A string representation of all mapObjects, each on a new line.
    """
    # Use a list comprehension to create a list of string representations of each mapObject
    map_objects_lines = [obj.__repr__() for obj in map_objects]
    
    # Join the list into a single string with new lines
    map_objects_string = "\n".join(map_objects_lines)
    
    return map_objects_string

def calculate_area(bounding_box):
    """Calculate the area of a bounding box given by two points ((x1, y1), (x2, y2))."""
    (x1, y1), (x2, y2) = bounding_box
    width = abs(x2 - x1)
    height = abs(y2 - y1)
    return width * height

def detected_objects_filter(objects, start_types):
    """
    Mark known COP types detected at spawn. Contacts stay hidden until sensed.
    """
    known = {str(kind).lower() for kind in start_types}
    for obj in objects:
        if str(getattr(obj, "object_type", "")).lower() in known:
            obj.detected = True
    return objects

def update_map_detections(map, new_detections):
    for detection in new_detections:
        # Find the object in the map that has the same name as the current detection
        for obj in map:
            if obj.name == detection["name"]:
                # Mark the object as detected
                obj.detected = True
                break

    return map