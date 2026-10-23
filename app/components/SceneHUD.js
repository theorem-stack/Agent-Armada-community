"use client";

import {
  Box,
  Car,
  CircleDot,
  Compass,
  Container,
  House,
  Map,
  MapPin,
  Move,
  Pencil,
  PersonStanding,
  RotateCcw,
  RotateCw,
  Trash2,
  TreePine,
  User,
  Waves,
  X,
} from "lucide-react";
import { OBJECT_CATALOG } from "../data/globalVars";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { readoutAccentFor, readoutKindLabel } from "./visuals/palette";

function formatCoord(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return Number(n).toFixed(0);
}

function formatAlt(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return Number(n).toFixed(1);
}

const STAMP_ICONS = {
  building: House,
  tree: TreePine,
  container: Container,
  person: User,
  vehicle: Car,
  flood: Waves,
};

function displayId(entity) {
  if (!entity) return "";
  if (entity.type === "agent") return `A${entity.id}`;
  return String(entity.id ?? "");
}

function Section({ title, children }) {
  if (!children) return null;
  return (
    <div className="space-y-0.5">
      <p className="ops-mono text-[9px] font-medium uppercase tracking-[0.12em] text-tac-dim">
        {title}
      </p>
      <div className="ops-mono text-[10px] leading-snug text-tac-text tabular-nums">
        {children}
      </div>
    </div>
  );
}

/**
 * Fixed-position entity inspector — compact sections, no side strip.
 * Hover is a dimmer preview; selection is full opacity with dismiss.
 */
function EntityInspector({ entity, selected, onClear, onDeleteSelected, onRotateSelected }) {
  if (!entity) return null;

  const accent = readoutAccentFor(entity);
  const kind = readoutKindLabel(entity);
  const posX = formatCoord(entity.envX);
  const posY = formatCoord(entity.envY);
  const pos =
    posX != null && posY != null ? `${posX} · ${posY}` : null;
  const alt = formatAlt(entity.alt);
  const swarm = entity.swarm != null ? String(entity.swarm) : null;

  const headingDeg =
    entity.heading != null && Number.isFinite(Number(entity.heading))
      ? `${((Number(entity.heading) * 180) / Math.PI).toFixed(0)}°`
      : null;
  const locationLine = [pos, alt != null ? `alt ${alt}` : null, headingDeg]
    .filter(Boolean)
    .join("  ·  ");

  return (
    <div
      className={cn(
        "map-glass w-[188px] rounded-xl",
        selected ? "opacity-100" : "opacity-70"
      )}
    >
      <div className="space-y-2 px-2.5 py-2">
        <div className="flex items-start justify-between gap-1.5">
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span
                className="ops-mono shrink-0 text-[9px] font-medium uppercase tracking-[0.12em]"
                style={{ color: accent }}
              >
                {kind}
              </span>
              <span className="ops-mono truncate text-[13px] font-semibold tracking-wide text-tac-text">
                {displayId(entity)}
              </span>
            </div>
          </div>
          {selected ? (
            <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-0.5">
              {onRotateSelected ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 rounded-full text-tac-dim hover:text-tac-text"
                    aria-label="Rotate left"
                    onClick={() => onRotateSelected(-Math.PI / 12)}
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="h-6 w-6 rounded-full text-tac-dim hover:text-tac-text"
                    aria-label="Rotate right"
                    onClick={() => onRotateSelected(Math.PI / 12)}
                  >
                    <RotateCw className="size-3.5" />
                  </Button>
                </>
              ) : null}
              {onDeleteSelected ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-6 w-6 rounded-full text-tac-dim hover:text-tac-text"
                  aria-label="Delete object"
                  onClick={() => onDeleteSelected?.()}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="h-6 w-6 rounded-full text-tac-dim hover:text-tac-text"
                aria-label="Clear selection"
                onClick={() => onClear?.()}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </div>

        {locationLine ? (
          <>
            <div className="border-t border-border/60" />
            <Section title="Location">{locationLine}</Section>
          </>
        ) : null}

        {swarm != null ? (
          <>
            <div className="border-t border-border/60" />
            <Section title="Assignment">swarm {swarm}</Section>
          </>
        ) : null}

        {entity.detail ? (
          <>
            <div className="border-t border-border/60" />
            <Section title="Detail">{entity.detail}</Section>
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Floating map chrome: compass + tools cluster, entity readout.
 */
export default function SceneHUD({
  mapYaw = 0,
  interactionMode = "pan",
  viewMode = "map",
  reticleIntensity = "normal",
  selectedEntity,
  hoverEntity,
  onResetYaw,
  onInteractionModeChange,
  onViewModeChange,
  onReticleIntensityChange,
  onClearSelection,
  placingSpawn = false,
  onPlacingSpawnChange,
  stampType = null,
  onStampTypeChange,
  onDeleteSelected,
  onRotateSelected,
  editMode = false,
  onEditModeChange,
}) {
  const readout = selectedEntity || hoverEntity;
  const isSelected = Boolean(selectedEntity);
  const compassDeg = (-mapYaw * 180) / Math.PI;
  const reticleFaint = reticleIntensity === "faint";
  const inspect = viewMode === "inspect";
  const walk = viewMode === "walk";
  const elevated = inspect || walk;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="pointer-events-none absolute inset-0 z-30 select-none">
        <div className="pointer-events-auto absolute right-3 top-3">
          <div
            role="toolbar"
            aria-label="Map tools"
            className="map-glass flex flex-col items-center gap-0.5 rounded-2xl p-1"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-muted-foreground hover:text-foreground"
                  aria-label="Reset map north"
                  onClick={() => onResetYaw?.()}
                >
                  <Compass
                    className="transition-transform duration-75"
                    style={{ transform: `rotate(${compassDeg}deg)` }}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Reset north</TooltipContent>
            </Tooltip>

            <Separator className="my-0.5 w-6" />

            <ToggleGroup
              type="single"
              value={elevated ? "" : interactionMode}
              onValueChange={(value) => {
                if (value) onInteractionModeChange?.(value);
              }}
              className="flex flex-col gap-0.5"
              aria-label="Interaction mode"
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <ToggleGroupItem
                    value="pan"
                    size="icon-sm"
                    aria-label="Pan mode"
                    className="rounded-full data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
                    disabled={elevated}
                  >
                    <Move />
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent side="left">Pan</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <ToggleGroupItem
                    value="rotate"
                    size="icon-sm"
                    aria-label="Rotate mode"
                    className="rounded-full data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
                    disabled={elevated}
                  >
                    <RotateCw />
                  </ToggleGroupItem>
                </TooltipTrigger>
                <TooltipContent side="left">Rotate</TooltipContent>
              </Tooltip>
            </ToggleGroup>

            <Separator className="my-0.5 w-6" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  size="icon-sm"
                  pressed={placingSpawn}
                  onPressedChange={(pressed) => onPlacingSpawnChange?.(Boolean(pressed))}
                  aria-label="Place spawn point"
                  className="rounded-full data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
                >
                  <MapPin />
                </Toggle>
              </TooltipTrigger>
              <TooltipContent side="left">
                {placingSpawn ? "Click the map to spawn" : "Place spawn"}
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  size="icon-sm"
                  pressed={editMode}
                  onPressedChange={(pressed) => onEditModeChange?.(Boolean(pressed))}
                  aria-label="Edit map objects"
                  disabled={elevated}
                  className="rounded-full data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
                >
                  <Pencil />
                </Toggle>
              </TooltipTrigger>
              <TooltipContent side="left">
                {editMode ? "Exit edit mode" : "Edit map"}
              </TooltipContent>
            </Tooltip>

            <Separator className="my-0.5 w-6" />

            <div className="flex flex-col gap-0.5" role="group" aria-label="View mode">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="2D map"
                    aria-pressed={viewMode === "map"}
                    className={cn(
                      "rounded-full",
                      viewMode === "map" && "bg-primary/15 text-primary"
                    )}
                    onClick={() => onViewModeChange?.("map")}
                  >
                    <Map />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">View: 2D</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="3D inspect"
                    aria-pressed={viewMode === "inspect"}
                    className={cn(
                      "rounded-full",
                      viewMode === "inspect" && "bg-primary/15 text-primary"
                    )}
                    onClick={() => onViewModeChange?.("inspect")}
                  >
                    <Box />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">View: 3D</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="First-person walk"
                    aria-pressed={viewMode === "walk"}
                    className={cn(
                      "rounded-full",
                      viewMode === "walk" && "bg-primary/15 text-primary"
                    )}
                    onClick={() => onViewModeChange?.("walk")}
                  >
                    <PersonStanding />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">View: walk</TooltipContent>
              </Tooltip>
            </div>

            <Separator className="my-0.5 w-6" />

            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  size="icon-sm"
                  pressed={reticleFaint}
                  onPressedChange={(pressed) =>
                    onReticleIntensityChange?.(pressed ? "faint" : "normal")
                  }
                  aria-label={
                    reticleFaint ? "Switch to normal reticle" : "Switch to faint reticle"
                  }
                  className="rounded-full data-[state=on]:bg-primary/15 data-[state=on]:text-primary"
                >
                  <CircleDot className={cn(reticleFaint && "opacity-50")} />
                </Toggle>
              </TooltipTrigger>
              <TooltipContent side="left">
                {reticleFaint ? "Reticle: faint" : "Reticle: normal"}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {readout && (
          <div className="pointer-events-auto absolute left-3 top-3">
            <EntityInspector
              entity={readout}
              selected={isSelected}
              onClear={onClearSelection}
              onDeleteSelected={
                editMode &&
                isSelected &&
                (readout?.type === "map" || readout?.type === "detection")
                  ? onDeleteSelected
                  : undefined
              }
              onRotateSelected={
                editMode &&
                isSelected &&
                (readout?.type === "map" || readout?.type === "detection")
                  ? onRotateSelected
                  : undefined
              }
            />
          </div>
        )}

        {viewMode === "map" && editMode && (
          <div className="pointer-events-auto absolute bottom-3 left-1/2 -translate-x-1/2">
            <div
              role="toolbar"
              aria-label="Place objects"
              className="map-glass flex items-center gap-0.5 rounded-2xl p-1"
            >
              {OBJECT_CATALOG.map((stamp) => {
                const Icon = STAMP_ICONS[stamp.object_type] || Box;
                const active = stampType === stamp.object_type;
                return (
                  <Tooltip key={stamp.object_type}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        draggable
                        aria-label={`Drag ${stamp.label} onto the map`}
                        className={cn(
                          "flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover:text-foreground",
                          active && "bg-primary/15 text-primary"
                        )}
                        onDragStart={(event) => {
                          event.dataTransfer.setData(
                            "application/x-vanguard-stamp",
                            stamp.object_type
                          );
                          event.dataTransfer.effectAllowed = "copy";
                          onStampTypeChange?.(stamp.object_type);
                        }}
                        onDragEnd={() => onStampTypeChange?.(null)}
                      >
                        <Icon className="size-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Drag {stamp.label} onto the map</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        )}

        {(walk || placingSpawn || editMode) && (
          <div
            className={cn(
              "pointer-events-none absolute left-1/2 -translate-x-1/2",
              viewMode === "map" && (editMode || placingSpawn) ? "bottom-14" : "bottom-3"
            )}
          >
            <p className="map-glass ops-mono rounded-full px-3 py-1 text-[10px] tracking-wide text-tac-dim">
              {placingSpawn
                ? "Click the map to set spawn"
                : editMode
                  ? stampType
                    ? "Drop on the map to place"
                    : "Drag a stamp to place · drag object to move · drag ring to rotate"
                  : "WASD move · drag look"}
            </p>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
