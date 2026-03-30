---
 '@ifc-lite/geometry': patch
 '@ifc-lite/renderer': patch
---

Add the first metadata-first geometry foundation for progressive viewer loading.

This introduces huge-geometry metadata and stats types in `@ifc-lite/geometry`, plus renderer-owned huge-batch ingestion and metadata/bounds registries in `@ifc-lite/renderer`. The viewer now has shared geometry summary helpers and store state for huge-geometry metadata so hierarchy, toolbar, status, overlay, basket visibility, and IDS color flows no longer depend solely on `geometryResult.meshes.length`.
