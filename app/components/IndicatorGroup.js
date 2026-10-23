"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { OpsPanel } from "@/components/OpsPanel";

const OPTIONS = [
  { value: "crosshair", label: "Crosshair" },
  { value: "box", label: "Box" },
  { value: "radius", label: "Radius" },
];

const IndicatorGroup = ({ selected, onSelect }) => {
  return (
    <OpsPanel title="Agent indicator">
      <ToggleGroup
        type="single"
        value={selected}
        onValueChange={(value) => {
          if (value) onSelect?.(value);
        }}
        className="grid w-full grid-cols-3 gap-1 rounded-full bg-muted p-1"
      >
        {OPTIONS.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            size="sm"
            className="rounded-full data-[state=on]:bg-card data-[state=on]:text-primary data-[state=on]:shadow-sm"
            aria-label={option.label}
          >
            {option.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </OpsPanel>
  );
};

export default IndicatorGroup;
