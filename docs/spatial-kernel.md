# Spatial kernel

The LLM compiles mission text into swarm skills. It does not walk graphs, emit waypoints, or do coordinate math. Spatial questions are answered by a **kernel in code**. Skills are verbs on that kernel.

Slices 1–21 below are implemented. Where two slices disagree, the later slice is the current behavior. The skill catalog is seven (Slice 16 adds Follow). Search completion follows Slice 19, not the person-only rule written in Slice 18.

This document is the design log for that kernel. Do not add ReAct geometry tools, live `query_objects` loops, or a scene graph in the planner prompt.

## Contract

```
operator text
    → planner (symbols + counts only)
    → Plan IR skills
    → handlers call SpatialKernel
    → setpoints / paths
    → physics
```

| Layer | Owns | Does not own |
|---|---|---|
| Planner | Intent → skills, symbol names | Coordinates, adjacency, coverage paths |
| Kernel | Bind, query, generate, believe | Prompts, plan sequencing |
| Skills | Verbs (`Search`, `Investigate`, …) | Inventing geometry |

The compiler’s world view stays small: bbox, agent count, groups, known place names, detected person/vehicle contacts, undetected type counts. Metric detail stays in the kernel.

## Kernel surface

Grow this API. Do not leak raw `map_objects` scans into new handler code.

1. **Bind** — name → pose, region, type, detected.
2. **Query** — nearest, in-region, line-of-sight / frustum (Slice 9).
3. **Generate** — lawnmower, formations, standoff (already in `api/geometry/generators.py`).
4. **Believe** — binary coverage plus log-odds occupancy; sector information later.
5. **Decompose** — 2×2 sector graph with 4-adjacency; `assign_sectors` is Voronoi on group/agent sites.

Graphs are an *index the runtime queries*, not a structure the model reasons over.

## Math (what we will use, and what we will not)

**Use**

- Computational geometry: regions, point-in, distances, coverage paths.
- Occupancy / log-odds or Beta-Bernoulli per cell when Search must maximize information, not paint 80% of cells.
- Voronoi or greedy set cover to split sectors across groups.
- Linear assignment (Hungarian or k-nearest) so Investigate takes a subset and Search continues.

**Do not use here**

- Geometric algebra, Lie groups, sheaves (attitude / sensor fusion, not SAR compile).
- Knowledge graphs or case-based memory as a substitute for the kernel.
- A scene graph in the LLM context.

## Current code

Already kernel-shaped, but not yet one facade:

- [`api/geometry/regions.py`](../api/geometry/regions.py) — `Region`, point-in, clip.
- [`api/geometry/coverage.py`](../api/geometry/coverage.py) — binary `CoverageGrid` and log-odds `OccupancyGrid`.
- [`api/geometry/generators.py`](../api/geometry/generators.py) — formations, lawnmower.
- [`api/session/world.py`](../api/session/world.py) — linear `object_by_name`.
- [`api/planner/summary.py`](../api/planner/summary.py) — compact compile context (no undetected names).

`SpatialKernel` lives in [`api/geometry/kernel.py`](../api/geometry/kernel.py) and is attached as `WorldState.space`.

## Slices

Do these in order. Each slice must keep the planner one-shot JSON and must not put metric graphs in the prompt.

### Slice 1 — Bind and query facade (done)

`SpatialKernel` owns a name index and answers `bind`, `nearest`, `in_region`, `standoff`. `WorldState.object_by_name` and Investigate/GoTo `object_id` go through it.

**Done when:** handlers do not scan `map_objects`; tests cover bind / miss / nearest / in-region / standoff-in-bbox.

### Slice 2 — Occupancy field (done)

Keep `CoverageGrid.visited` for paint. `OccupancyGrid` stores log-odds on the same cells. Search (`runtime.mode == "search"`) calls `observe_free` along agent paths. Investigate and new detections call `observe_occupied`. Search success is still coverage-fraction.

`compact_world_summary` reports scalar `uncovered_mass` (mean occupancy / prior). It does not include the grid.

**Done when:** Search paints belief; compact summary can report uncovered mass without listing cells.

### Slice 3 — Sector graph (runtime only) (done)

`SectorGraph` partitions the bbox into a 2×2 grid with 4-neighbor edges. `world.space.assign_sectors(sites)` is Voronoi (nearest sector center), then fills empty sites from a richer neighbor.

Search with no `region` decomposes in the handler: group centroids if `world.groups` is set, otherwise one site per agent. Each site gets a concatenated lawnmower over its sectors. An explicit Search region is unchanged. The planner prompt and `compact_world_summary` do not include the graph.

**Done when:** a Search with no region can be decomposed across groups in code; no graph JSON in `compact_world_summary`.

### Slice 4 — Subset Investigate (done)

`Investigate` takes `INVESTIGATE_COUNT` (4) nearest agents from the resolved pool via `world.space.nearest_ids`. Those agents get the standoff setpoint. Everyone else is put back on sector Search paths (`_resume_search`). `assigned_ids` is only the investigators, so success is arrival of that subset.

`advance_search` runs whenever an agent has a path, including during Investigate. Coverage/belief paint also runs while paths exist.

**Done when:** a person detection does not send all 20 agents to Person1; Search coverage keeps increasing.

### Slice 5 — Summary from the kernel (done)

`compact_world_summary` is a projection of kernel queries: `detected()`, `undetected_counts()`, and `uncovered_mass()`. It does not scan `map_objects`. Still no undetected names, no adjacency lists, no occupancy grid, no detected positions, no `sector_uncovered` in the planner projection (`sector_uncovered()` stays on the kernel).

The planner system prompt does not include a scene graph.

**Done when:** summary tests stay name-free for undetected objects; planner prompt does not grow.

### Slice 6 — Symbolic compile (done)

Places in the compile IR are symbols: `target` (`bbox_center`, `sw_corner`, `se_corner`, `nw_corner`, `ne_corner`) or `object_id`. `SpatialKernel.anchor` resolves both. Raw metric fields (`GoTo.x/y/poses`, `Form.center/region`, `Search.region`, `Hold.region`) are not on the IR.

`Search` with an object/target lawnmowers the bound region. `Search` with neither still sector-splits the bbox. Form size and search spacing default in the handler.

Live compiles append `logs/compile.jsonl` (statement, task actions + symbols, repairs). Catalog stays six skills.

**Done when:** a Search of the flood binds by name; metric fields cannot parse; summary stays name-free for undetected objects.

### Slice 7 — 3D inspect camera (done)

Presentation only. 2D ortho map stays the default COP. HUD toggles `2D` / `3D`. 3D uses a `PerspectiveCamera` and a Z-up orbit controller (not Y-up `OrbitControls`). Leaving 3D or Reset north snaps to nadir. Distance reticle is hidden in 3D.

**Done when:** operator can tilt around the AOI and return to the map view without breaking pan/zoom/labels/picking.

### Slice 8 — Volumes (done)

Buildings extrude, people are short capsules, trees have canopy height. Flood stays a ground plane. Type heights live in `OBJECT_HEIGHTS`. `hurricane_map` places a shipping container north of Person1 so a horizontal look can occlude; Person1 stays at `(50, 50)` with a clear overhead path.

**Done when:** orbiting a building/tree, the mesh hides what is behind it.

### Slice 9 — Sensor query (frustum + LOS) (done)

`SpatialKernel.visible` / `occluded` / `observers`. Circular downward cone (`SENSOR_RANGE`, `SENSOR_HALF_ANGLE`). LOS is a ray vs extruded tree/building AABBs. Session `assess_tick` uses the kernel; flocking `RADIUS` is unchanged. Planner prompt does not grow.

**Done when:** a person behind a building is not auto-detected; a person in the open still is; kernel tests cover in-cone, out of range, occluded, and overhead miss.

### Slice 10 — Fused tracks (done)

Kernel holds per detected object: `observers`, `last_seen_tick`, `confidence`. Session snapshot adds `tracks`. Not in `compact_world_summary`. Occupancy stays search paint.

**Done when:** snapshot has one track per detected person with observer ids; summary tests stay name-free for undetected objects.

### Slice 11 — Cones + X-ray (done)

3D inspect draws downward cones per agent. X-ray ghosts are **walk-only**, person contacts with observers, and a depth-fail pass (`GreaterDepth`) so only fragments behind cover draw. Visible people stay solid with no overlay.

**Done when:** tilt to the tree side and the person is a ghost outline; tilt to the open side and they render solid.

### Slice 12 — Walk camera (done)

Third view mode: ground-level first-person (WASD + drag look). Same fused tracks; X-ray uses the walk camera as the operator eye. Cones stay inspect-only. Planner prompt does not grow.

**Done when:** standing north of the shipping container, a detected person is a ghost; walking south of it they render solid.

### Slice 13 — Scripted contacts + track velocity (done)

People (`OBJECTS_OF_INTEREST`) patrol inside the bbox each physics tick (`WorldState.step_contacts`). `SpatialKernel.record_motion` stores pose delta as velocity. `fused_tracks` includes `velocity` for the COP snapshot only. `compact_world_summary` does not.

**Done when:** a person pose changes over ticks; tracks expose velocity; summary tests stay track-free.

### Slice 14 — Tick-time rebind (done)

`TaskRuntime` holds `object_id` and `standoff`. Investigate (and Follow) recompute `world.space.standoff` each physics tick for the assigned subset. Searchers keep `_resume_search` paths. Investigate success is still subset arrival.

**Done when:** relocating Person1 during Investigate moves investigator setpoints; search coverage still increases.

### Slice 15 — Event vocabulary (done)

`EventRule.when` is `Detected | Lost | Moved | Reacquired`. Assess edge-triggers Lost (no observers for `LOST_TICKS`), Moved (`MOVE_THRESHOLD`), and Reacquired. Runtime binds the contact name onto `then` and queues like Detected. LLM replan stays Detected-only for unmatched person/flood. Investigate/Follow fail on Lost of their contact.

**Done when:** Lost/Moved/Reacquired queue without calling the planner; Search Detected(person) still does not replan.

### Slice 16 — Follow skill (done)

`Follow` keeps `INVESTIGATE_COUNT` nearest agents at standoff and never succeeds until Lost/timeout/abort. Search default adds `Detected(vehicle)→Follow`. People stay `Detected(person)→Investigate` with rebind. Planner prompt grows only by the generated Follow line.

**Done when:** Follow peels a subset while Search continues; `"stay with Person1"` compiles; unknown names fail validate; summary tests stay name-free for undetected objects.

### Slice 17 — Runtime contact bind (done)

Later tasks query the kernel instead of baking undetected names at compile time. `SpatialKernel.note_contact` records detection order; `resolve_object` binds omitted `object_id`, type names (`person`, `vehicle`), or `last_contact`. Investigate/Follow write the resolved name onto the task so the published plan shows who they locked. GoTo/Form/Hold/Search still treat a missing place as bbox/loiter.

**Done when:** Search then Investigate with no name binds Person1 after a detection; `object_id: person` resolves to the latest detected person; summary stays name-free for undetected objects.

### Slice 18 — Search stop (done)

Search succeeds if a person (`OBJECTS_OF_INTEREST`) is detected **while this Search is active**, or the bound Search place (else the bbox) reaches `SEARCH_COVER_MIN` coverage. Timeout remains fail. Start-detected landmarks (flood, buildings) are not a find. Vehicle detections still queue Follow and do not complete Search. Same-tick `on_event` still queues Investigate before Search advances.

**Done when:** a person detection completes Search and activates Investigate; covering Flooded Area succeeds without painting the whole map; 80% of the map does not complete a flood Search; timeout fails.

### Slice 19 — Search find types + Form surround (done)

`person` and `vehicle` on Search are **find types**, not places. Search lawnmowers the bbox until that type is detected (or AOI coverage / timeout). Default Search treats either type as a find. A later compiled Form/Investigate/Follow with `object_id` of that type (or `last_contact`) is not preempted by Search's default Detected→Follow/Investigate. Form around a bound contact uses at least `INVESTIGATE_STANDOFF` so a vehicle surround is a real circle, not a 5-unit pile-up. The hurricane Car AABB is centered on its pose.

**Done when:** `Search(vehicle)` then `Form(circle, vehicle)` detects Car, completes Search, and forms around Car with no Follow inserted; Search-only vehicle detection still queues Follow; person detection does not complete a vehicle Search.

### Slice 20 — Compiled policy, no skill defaults (done)

Search does not inject `on_event`. Investigate and Follow stay skills. Sequential tasks are the happy path (`Search` then `Investigate` / `Form` / `Follow`). `on_event` is only what the compiled JSON includes (extra contacts, Lost, Moved, Reacquired). Unmatched person/flood detections can still replan.

**Done when:** Search-only has empty `on_event` and does not queue Investigate or Follow; explicit `on_event` still queues; Search then Investigate still binds Person1.

### Slice 21 — Compile doctrine (done)

Planner summary splits **places** (start-detected landmarks) from **detected** (person/vehicle contacts). Investigate/Follow reject landmarks and `Detected(...)` as `object_id`. After a Search, undetected person/vehicle names are illegal; use the type or omit. LLM `Search(target: bbox_center)` is stripped to a whole-map Search. Fake test compiles do not append to `logs/compile.jsonl`; live records include `on_event`.

**Done when:** summary tests keep undetected names out; Investigate(Home1) and Investigate(Detected(person)) fail validate; Search then Investigate(Person1) fails; Search then Investigate with no name still compiles; fake model does not write the default compile log.

## Non-goals

- ReAct / tool-calling geometry (`query_objects` in the planner loop).
- Per-agent `move_agent(id, x, y)` as the LLM ISA.
- GIS / OSM, Redis, websocket deltas (separate from the kernel).
- Model swap before compile metrics (`repairs == 0` on golden missions).
- Parallel task IR unless Slice 4 proves a second active skill is required.

## How to iterate

1. Slices 1–21 are done. A new change should keep the planner one-shot JSON.
2. Route new spatial access through `world.space` (or generators the kernel already wraps).
3. Add tests in `api/tests/test_geometry.py` / `test_kernel.py` with no live OpenAI.
4. Record the slice in this document when tests pass.
