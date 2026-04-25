#!/bin/bash
set -e

# Download IFC test models from public GitHub repos into tests/models-local/
# This avoids touching the upstream LFS-tracked tests/models/ directory.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$ROOT_DIR/tests/models-local"

mkdir -p "$OUT"/{buildingsmart,ifcopenshell,ifc5}

echo "Fetching IFC test models into tests/models-local/ ..."

# Helper: download if not already present
fetch() {
  local url="$1" dest="$2"
  if [ ! -f "$dest" ]; then
    if curl -sfL "$url" -o "$dest"; then
      echo "    $(basename "$dest")"
    else
      echo "    FAILED: $(basename "$dest")"
      rm -f "$dest"
    fi
  fi
}

# --- buildingSMART Sample-Test-Files ---
BS_BASE="https://raw.githubusercontent.com/buildingSMART/Sample-Test-Files/main"
BS_REF="IFC%204.0.2.1%20(IFC%204)/ISO%20Spec%20-%20ReferenceView_V1.2"
BS_PCERT="IFC%204.0.2.1%20(IFC%204)/PCERT-Sample-Scene"

echo "  buildingSMART (ReferenceView)..."
for f in basin-tessellation column-straight-rectangle-tessellation tessellated-item tessellation-with-individual-colors wall-with-opening-and-window; do
  fetch "$BS_BASE/$BS_REF/$f.ifc" "$OUT/buildingsmart/$f.ifc"
done

echo "  buildingSMART (PCERT)..."
for f in Building-Architecture Building-Hvac Building-Landscaping Building-Structural Infra-Bridge Infra-Landscaping Infra-Plumbing Infra-Rail Infra-Road; do
  fetch "$BS_BASE/$BS_PCERT/$f.ifc" "$OUT/buildingsmart/$f.ifc"
done

# --- IfcOpenShell test files ---
IO_BASE="https://raw.githubusercontent.com/IfcOpenShell/files/master"

echo "  IfcOpenShell..."
for f in 1019-column 1030-sphere 1032-curve 928-column cylinders advanced_brep faceted_brep faceted_brep_csg single-circle-compcurve structural_analysis_curve "452--line-segment--curved" "452--line-segment-straight" "567--cylinder--wrong-geometry--augmented" "764--column--no-materials-or-surface-styles-found--augmented" "1269--Project_IfcDuctFitting"; do
  fetch "$IO_BASE/$f.ifc" "$OUT/ifcopenshell/$f.ifc"
done

# --- IFC5 samples ---
IFC5_BASE="https://raw.githubusercontent.com/buildingSMART/IFC5-development/main/examples"

echo "  IFC5..."
fetch "$IFC5_BASE/Hello%20Wall/hello-wall.ifc" "$OUT/ifc5/hello-wall.ifc"
fetch "$IFC5_BASE/Domestic%20Hot%20Water/domestic-hot-water.ifc" "$OUT/ifc5/domestic-hot-water.ifc"
fetch "$IFC5_BASE/Georeferencing/georeferenced-bridge-deck.ifc" "$OUT/ifc5/georeferenced-bridge-deck.ifc"
fetch "$IFC5_BASE/Linear%20placement%20of%20signals/linear-placement-of-signal.ifc" "$OUT/ifc5/linear-placement-of-signal.ifc"
fetch "$IFC5_BASE/Railway/Railway_project_simple_IFC4X3.ifc" "$OUT/ifc5/Railway_project_simple_IFC4X3.ifc"

# Count results
total=$(find "$OUT" -name "*.ifc" -type f | wc -l | tr -d ' ')
size=$(du -sh "$OUT" | awk '{print $1}')
echo ""
echo "Done. $total IFC files ($size) in tests/models-local/"
