---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
"@ifc-lite/wasm": patch
---

Add a "Merge Wall Layers" import toggle for multilayer walls. When enabled, IfcWall elements decomposed via IfcRelAggregates into IfcBuildingElementPart children merge into a single solid per wall, reducing draw calls and memory usage for large models.

- New optional `mergeLayers` field on `GeometryProcessorOptions` (default `false`).
- New WASM bindings `parseMeshesMergeLayers` and `parseMeshesSubsetMergeLayers`.
- Toggle persists across reloads via localStorage (`ifc-lite-merge-wall-layers`) and is included in the cache key so cached geometry does not leak between modes.
- The server path is skipped when the toggle is on since remote parsing does not yet honour it.
- Class-visibility / merge toggles in the toolbar are accessible before any model is loaded, and type-visibility preferences (spaces / openings / site) also persist across reloads.
