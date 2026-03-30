---
"@ifc-lite/geometry": patch
"@ifc-lite/renderer": patch
"@ifc-lite/viewer": patch
"@ifc-lite/wasm": patch
---

Switch local IFC loading to a zero-copy GPU upload path that batches geometry by color in WASM, uploads directly from WASM memory into renderer-owned GPU buffers, and keeps viewer state metadata-first instead of rebuilding large JS mesh arrays.
