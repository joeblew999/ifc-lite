/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane visual indicator — face-based cutting.
 * Shows a small SVG badge when a section is active.
 */

interface SectionPlaneVisualizationProps {
  enabled: boolean;
}

export function SectionPlaneVisualization({ enabled }: SectionPlaneVisualizationProps) {
  if (!enabled) return null;

  const color = '#03A9F4'; // Light blue

  return (
    <svg
      className="absolute inset-0 pointer-events-none z-20"
      style={{ overflow: 'visible', pointerEvents: 'none' }}
    >
      <defs>
        <filter id="section-glow">
          <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>
      <g transform="translate(24, 24)">
        <circle cx="20" cy="20" r="18" fill={color} fillOpacity={0.2} stroke={color} strokeWidth={3} filter="url(#section-glow)"/>
        <text
          x="20" y="17"
          textAnchor="middle" dominantBaseline="central"
          fill={color} fontFamily="monospace" fontSize="9" fontWeight="bold"
        >
          CUT
        </text>
        <text
          x="20" y="27"
          textAnchor="middle" dominantBaseline="central"
          fill={color} fontFamily="monospace" fontSize="7" fontWeight="bold" opacity={0.7}
        >
          FACE
        </text>
      </g>
    </svg>
  );
}
