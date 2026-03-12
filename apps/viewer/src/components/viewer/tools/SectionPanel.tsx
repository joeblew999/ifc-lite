/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section tool overlay — face-based clipping.
 *
 * The user clicks any face in 3D to define a cutting plane.
 * A distance slider lets them push the plane along its normal.
 * The 3D scene reflects the actual clipped model in real time.
 */

import React, { useCallback, useState } from 'react';
import { X, Slice, ChevronDown, FileImage, FlipHorizontal2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useViewerStore } from '@/store';

export function SectionOverlay() {
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const setSectionPlaneDistance = useViewerStore((s) => s.setSectionPlaneDistance);
  const toggleSectionPlane = useViewerStore((s) => s.toggleSectionPlane);
  const flipSectionPlane = useViewerStore((s) => s.flipSectionPlane);
  const resetSectionPlane = useViewerStore((s) => s.resetSectionPlane);
  const setActiveTool = useViewerStore((s) => s.setActiveTool);
  const setDrawingPanelVisible = useViewerStore((s) => s.setDrawing2DPanelVisible);
  const drawingPanelVisible = useViewerStore((s) => s.drawing2DPanelVisible);
  const clearDrawing = useViewerStore((s) => s.clearDrawing2D);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(true);

  const handleClose = useCallback(() => {
    setActiveTool('select');
  }, [setActiveTool]);

  const handleDistanceChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value);
    if (!Number.isNaN(value)) {
      setSectionPlaneDistance(value);
    }
  }, [setSectionPlaneDistance]);

  const togglePanel = useCallback(() => {
    setIsPanelCollapsed(prev => !prev);
  }, []);

  const handleView2D = useCallback(() => {
    clearDrawing();
    setDrawingPanelVisible(true);
  }, [clearDrawing, setDrawingPanelVisible]);

  // Format normal for display
  const n = sectionPlane.normal;
  const normalLabel = `(${n.x.toFixed(2)}, ${n.y.toFixed(2)}, ${n.z.toFixed(2)})`;

  return (
    <>
      {/* Compact Section Tool Panel */}
      <div className="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2 bg-background/95 backdrop-blur-sm rounded-lg border shadow-lg z-30">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 p-2">
          <button
            onClick={togglePanel}
            className="flex items-center gap-2 hover:bg-accent/50 rounded px-2 py-1 transition-colors"
          >
            <Slice className="h-4 w-4 text-primary" />
            <span className="font-medium text-sm">Section</span>
            {sectionPlane.enabled && (
              <span className="text-xs text-primary font-mono truncate max-w-[140px]">
                d={sectionPlane.distance.toFixed(2)}
              </span>
            )}
            <ChevronDown className={`h-3 w-3 transition-transform ${isPanelCollapsed ? '-rotate-90' : ''}`} />
          </button>
          <div className="flex items-center gap-1">
            {!drawingPanelVisible && sectionPlane.enabled && (
              <Button variant="ghost" size="icon-sm" onClick={handleView2D} title="Open 2D Drawing Panel">
                <FileImage className="h-3 w-3" />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={handleClose} title="Close">
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Expandable content */}
        {!isPanelCollapsed && (
          <div className="border-t px-3 pb-3 min-w-64">
            {!sectionPlane.enabled ? (
              /* No plane set yet */
              <div className="mt-3 text-xs text-muted-foreground text-center py-2">
                Click any face in 3D to define a cutting plane
              </div>
            ) : (
              <>
                {/* Normal info */}
                <div className="mt-3">
                  <label className="text-xs text-muted-foreground mb-1 block">Plane Normal</label>
                  <div className="text-xs font-mono bg-muted px-2 py-1 rounded">{normalLabel}</div>
                </div>

                {/* Distance Slider */}
                <div className="mt-3">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-muted-foreground">Distance</label>
                    <input
                      type="number"
                      step="0.1"
                      value={sectionPlane.distance}
                      onChange={handleDistanceChange}
                      className="w-20 text-xs font-mono bg-muted px-1.5 py-0.5 rounded border-none text-right [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                  </div>
                  <input
                    type="range"
                    min={sectionPlane.distance - 20}
                    max={sectionPlane.distance + 20}
                    step="0.05"
                    value={sectionPlane.distance}
                    onChange={handleDistanceChange}
                    className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>

                {/* Action buttons */}
                <div className="mt-3 flex gap-1">
                  <Button variant="outline" size="sm" className="flex-1" onClick={flipSectionPlane} title="Flip cutting direction">
                    <FlipHorizontal2 className="h-3.5 w-3.5 mr-1" />
                    Flip
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1" onClick={resetSectionPlane} title="Clear section plane">
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    Clear
                  </Button>
                </div>

                {/* Show 2D panel button */}
                {!drawingPanelVisible && (
                  <div className="mt-3 pt-3 border-t">
                    <Button variant="outline" size="sm" className="w-full" onClick={handleView2D}>
                      <FileImage className="h-4 w-4 mr-2" />
                      Open 2D Drawing
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Instruction hint */}
      <div
        className="pointer-events-auto absolute bottom-16 left-1/2 -translate-x-1/2 z-30 bg-zinc-900 dark:bg-zinc-100 text-zinc-100 dark:text-zinc-900 px-3 py-1.5 border-2 border-zinc-900 dark:border-zinc-100 transition-shadow duration-150"
        style={{
          boxShadow: sectionPlane.enabled
            ? '4px 4px 0px 0px #03A9F4'
            : '3px 3px 0px 0px rgba(0,0,0,0.3)'
        }}
      >
        <span className="font-mono text-xs uppercase tracking-wide">
          {sectionPlane.enabled
            ? `Cutting at d=${sectionPlane.distance.toFixed(2)}`
            : 'Click a face to cut'}
        </span>
      </div>

      {/* Enable toggle */}
      {sectionPlane.enabled && (
        <div className="pointer-events-auto absolute bottom-4 left-1/2 -translate-x-1/2 z-30">
          <button
            onClick={toggleSectionPlane}
            className={`px-2 py-1 font-mono text-[10px] uppercase tracking-wider border-2 transition-colors ${
              sectionPlane.enabled
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-zinc-100 dark:bg-zinc-900 text-zinc-500 border-zinc-300 dark:border-zinc-700'
            }`}
            title="Toggle section plane"
          >
            {sectionPlane.enabled ? 'Cutting' : 'Preview'}
          </button>
        </div>
      )}
    </>
  );
}
