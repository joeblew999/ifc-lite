---
"@ifc-lite/wasm": patch
---

Route non-box IfcOpeningElement geometry through CSG instead of AABB clipping (#547). Low-tessellation openings whose profile isn't a rectangle — trapezoids, chamfered rectangles, beveled windows, coarse arcs — used to slip under the 100-vertex rectangular-path threshold and get cut as their axis-aligned bounding box, removing wall material outside the actual opening. `classify_openings` now checks per-representation-item whether every vertex lies on an AABB corner; items that don't are routed to CSG so the cut matches the real shape.
