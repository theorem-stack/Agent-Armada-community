"use client";

import { labelColorForType } from "./visuals/palette";

/** Arc span (world radians) centered on NE for ring distance labels. */
const ARC_HALF = (18 * Math.PI) / 180;
const ARC_MID = Math.PI / 4;

function rangeArcPath(cx, cy, r) {
  // Sit just outside the stroke so the glyphs hug the ring instead of cutting it.
  const rr = r + 1.5;
  const a0 = ARC_MID + ARC_HALF;
  const a1 = ARC_MID - ARC_HALF;
  const x0 = cx + rr * Math.cos(a0);
  const y0 = cy - rr * Math.sin(a0);
  const x1 = cx + rr * Math.cos(a1);
  const y1 = cy - rr * Math.sin(a1);
  // Sweep=1 is clockwise in SVG (Y-down), matching decreasing world angle.
  return `M ${x0} ${y0} A ${rr} ${rr} 0 0 1 ${x1} ${y1}`;
}

const RANGE_LABEL_FILL = {
  normal: "rgba(15,163,184,0.62)",
  faint: "rgba(15,163,184,0.22)",
};

/**
 * Constant-size DOM callouts projected over the canvas.
 * Range labels follow the reticle as arc text; map tags are a one-word chip.
 */
export default function SceneLabels({ labels, reticleIntensity = "normal" }) {
  if (!labels?.length) return null;

  const rangeLabels = labels.filter((l) => l.type === "range" && l.r > 12);
  const otherLabels = labels.filter((l) => l.type !== "range");
  const rangeFill = RANGE_LABEL_FILL[reticleIntensity] || RANGE_LABEL_FILL.normal;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {rangeLabels.length > 0 && (
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          aria-hidden="true"
        >
          <defs>
            {rangeLabels.map((label) => (
              <path
                key={`${label.id}-path`}
                id={`${label.id}-arc`}
                d={rangeArcPath(label.cx, label.cy, label.r)}
                fill="none"
              />
            ))}
          </defs>
          {rangeLabels.map((label) => (
            <text
              key={label.id}
              className="ops-mono"
              fill={rangeFill}
              fontSize="10"
              letterSpacing="0.1em"
            >
              <textPath href={`#${label.id}-arc`} startOffset="50%" textAnchor="middle">
                {label.title}
              </textPath>
            </text>
          ))}
        </svg>
      )}

      {otherLabels.map((label) => {
        if (label.type === "contour") {
          return (
            <div
              key={label.id}
              className="ops-mono absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-tac-panel/90 px-1 py-px text-[9px] font-medium tracking-wide shadow-sm"
              style={{
                left: label.x,
                top: label.y,
                color: label.color || "var(--tac-text-muted)",
                boxShadow: `inset 0 0 0 1px ${label.color || "transparent"}40`,
              }}
            >
              {label.title}
            </div>
          );
        }

        const accent = labelColorForType(label.objectType);
        return (
          <div
            key={label.id}
            className="ops-mono absolute -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-tac-panel/90 px-1 py-px text-[9px] font-medium tracking-wide"
            style={{
              left: label.x,
              top: label.y,
              color: accent,
              boxShadow: `inset 0 0 0 1px ${accent}40`,
            }}
          >
            {label.title}
          </div>
        );
      })}
    </div>
  );
}
