import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { getHistory, type HistorySnapshot } from "@/lib/history-store"
import type { DisplayMode } from "@/lib/settings"

interface UsageHistoryGraphProps {
  providerId: string
  brandColor?: string
  displayMode?: DisplayMode
}

const TIME_RANGES = [
  { label: "1h", ms: 3_600_000 },
  { label: "6h", ms: 21_600_000 },
  { label: "24h", ms: 86_400_000 },
  { label: "7d", ms: 604_800_000 },
  { label: "All", ms: Infinity },
] as const

const SVG_W = 400
const SVG_H = 180
const PAD = { top: 10, right: 10, bottom: 28, left: 36 }
const PLOT_W = SVG_W - PAD.left - PAD.right
const PLOT_H = SVG_H - PAD.top - PAD.bottom

const Y_TICKS = [0, 25, 50, 75, 100]

const LINE_COLORS = [
  "#60a5fa", // blue-400
  "#a78bfa", // violet-400
  "#34d399", // emerald-400
  "#f97316", // orange-400
  "#f472b6", // pink-400
  "#22d3ee", // cyan-400
]

function formatTimeLabel(ts: number, rangeMs: number): string {
  const d = new Date(ts)
  if (rangeMs <= 86_400_000) {
    // 24h or less: show HH:MM
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }
  if (rangeMs <= 604_800_000) {
    // 7d: show day + HH
    return d.toLocaleDateString([], { weekday: "short", hour: "2-digit" }) // e.g. "Mon 14"
  }
  // All: show date
  return d.toLocaleDateString([], { month: "short", day: "numeric" })
}

function buildSmoothPath(
  points: { x: number; y: number }[]
): string {
  if (points.length === 0) return ""
  if (points.length === 1) {
    return `M ${points[0].x} ${points[0].y}`
  }

  // Catmull-Rom to cubic bezier
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]

    const tension = 0.3
    const cp1x = p1.x + (p2.x - p0.x) * tension
    const cp1y = p1.y + (p2.y - p0.y) * tension
    const cp2x = p2.x - (p3.x - p1.x) * tension
    const cp2y = p2.y - (p3.y - p1.y) * tension

    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`
  }
  return d
}

export function UsageHistoryGraph({ providerId, displayMode = "used" }: UsageHistoryGraphProps) {
  const [rangeIndex, setRangeIndex] = useState(2) // Default: 24h (index 2)
  const [history, setHistory] = useState<HistorySnapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [hoverX, setHoverX] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  const rangeMs = TIME_RANGES[rangeIndex].ms

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getHistory(providerId).then((data) => {
      if (cancelled) return
      setHistory(data)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [providerId])

  // Filter by time range
  const filtered = useMemo(() => {
    if (rangeMs === Infinity) return history
    const since = Date.now() - rangeMs
    return history.filter((s) => s.timestamp >= since)
  }, [history, rangeMs])

  // Aggregate series: find unique labels and map timestamps
  const { series, allTimestamps, allPercentages } = useMemo(() => {
    if (filtered.length === 0) {
      return { series: [], allTimestamps: [], allPercentages: [] }
    }

    // Collect all unique labels across snapshots (skip count-based like Credits)
    const labels = new Set<string>()
    for (const snap of filtered) {
      for (const line of snap.lines) {
        if (line.label !== "Credits") {
          labels.add(line.label)
        }
      }
    }
    const labelList = Array.from(labels)

    // Build time series for each label
    const seriesData = labelList.map((label, idx) => {
      const points: { x: number; y: number }[] = []
      for (const snap of filtered) {
        const line = snap.lines.find((l) => l.label === label)
        if (line) {
          const y = displayMode === "left" ? 100 - line.percentage : line.percentage
          points.push({ x: snap.timestamp, y })
        }
      }
      return {
        label,
        points,
        color: LINE_COLORS[idx % LINE_COLORS.length],
      }
    })

    const timestamps = filtered.map((s) => s.timestamp)
    const allPcts = seriesData.flatMap((s) => s.points.map((p) => p.y))

    return { series: seriesData, allTimestamps: timestamps, allPercentages: allPcts }
  }, [filtered])

  // Compute SVG coordinates
  const coords = useMemo(() => {
    if (allTimestamps.length === 0 || allPercentages.length === 0) {
      return { xScale: 1, yScale: 1, minX: 0, maxX: 0, mappedSeries: [] as never[] }
    }

    const minX = Math.min(...allTimestamps)
    const maxX = Math.max(...allTimestamps)
    const rangeX = maxX - minX || 1
    const xScale = PLOT_W / rangeX

    const yScale = PLOT_H / 100 // 0-100 range

    const mappedSeries = series.map((s) => ({
      ...s,
      points: s.points.map((p) => ({
        x: PAD.left + (p.x - minX) * xScale,
        y: PAD.top + PLOT_H - p.y * yScale,
      })),
    }))

    return { xScale, yScale, minX, maxX, mappedSeries }
  }, [series, allTimestamps, allPercentages])

  // X-axis labels
  const xLabels = useMemo(() => {
    if (allTimestamps.length < 2) return []
    const minX = Math.min(...allTimestamps)
    const maxX = Math.max(...allTimestamps)
    const count = 5
    const labels: { x: number; label: string }[] = []
    for (let i = 0; i < count; i++) {
      const ts = minX + ((maxX - minX) * i) / (count - 1)
      labels.push({
        x: PAD.left + (PLOT_W * i) / (count - 1),
        label: formatTimeLabel(ts, rangeMs),
      })
    }
    return labels
  }, [allTimestamps, rangeMs])

  // Tooltip data
  const tooltipData = useMemo(() => {
    if (hoverX === null || !coords.mappedSeries.length) return null

    // Find the nearest data point x position
    const allPoints = coords.mappedSeries.flatMap((s) => s.points)
    if (allPoints.length === 0) return null

    // Find closest x-coordinate among all points
    const closest = allPoints.reduce((best, p) =>
      Math.abs(p.x - hoverX) < Math.abs(best.x - hoverX) ? p : best
    )

    // Get values at this x for all series
    // We need to find snapshots close to this time
    const closestTs = coords.minX + (closest.x - PAD.left) / coords.xScale

    const values = coords.mappedSeries.map((s) => {
      // Find the closest point in this series
      const closestPoint = s.points.reduce((best, p) =>
        Math.abs(p.x - closest.x) < Math.abs(best.x - closest.x) ? p : best
      , s.points[0])
      const yVal = 100 - (closestPoint.y - PAD.top) / (PLOT_H / 100)
      return {
        label: s.label,
        value: Math.round(yVal),
        color: s.color,
      }
    })

    return {
      x: closest.x,
      ts: new Date(closestTs),
      values,
    }
  }, [hoverX, coords])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const scaleX = SVG_W / rect.width
      const svgX = (e.clientX - rect.left) * scaleX
      setHoverX(Math.max(PAD.left, Math.min(PAD.left + PLOT_W, svgX)))
    },
    []
  )

  const handleMouseLeave = useCallback(() => {
    setHoverX(null)
  }, [])

  if (loading) {
    return (
      <div className="mt-6">
        <div className="h-[180px] flex items-center justify-center">
          <div className="text-xs text-muted-foreground animate-pulse">Loading history...</div>
        </div>
      </div>
    )
  }

  if (filtered.length === 0) {
    return (
      <div className="mt-6">
        <div className="flex gap-1 mb-2">
          {TIME_RANGES.map((r, i) => (
            <button
              key={r.label}
              onClick={() => setRangeIndex(i)}
              className={`text-xs px-2 py-0.5 rounded ${
                i === rangeIndex
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="h-[180px] flex items-center justify-center rounded-lg border border-dashed border-muted-foreground/20">
          <p className="text-xs text-muted-foreground text-center px-4">
            Usage history will appear here once data is collected.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-6">
      {/* Time range selector */}
      <div className="flex gap-1 mb-2">
        {TIME_RANGES.map((r, i) => (
          <button
            key={r.label}
            onClick={() => setRangeIndex(i)}
            className={`text-xs px-2 py-0.5 rounded ${
              i === rangeIndex
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* SVG Chart */}
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${SVG_W} ${SVG_H}`}
          className="w-full h-auto"
          style={{ height: "auto", maxHeight: `${SVG_H}px` }}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          data-testid="usage-history-svg"
        >
          {/* Grid lines (horizontal at Y ticks) */}
          {Y_TICKS.map((y) => {
            const yPos = PAD.top + PLOT_H - (y / 100) * PLOT_H
            return (
              <g key={y}>
                <line
                  x1={PAD.left}
                  y1={yPos}
                  x2={PAD.left + PLOT_W}
                  y2={yPos}
                  stroke="currentColor"
                  className="text-border/30"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 4}
                  y={yPos + 3}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  fontSize={9}
                >
                  {y}%
                </text>
              </g>
            )
          })}

          {/* X-axis labels */}
          {xLabels.map((xl, i) => (
            <text
              key={i}
              x={xl.x}
              y={SVG_H - 4}
              textAnchor="middle"
              className="fill-muted-foreground"
              fontSize={8}
            >
              {xl.label}
            </text>
          ))}

          {/* Data lines */}
          {coords.mappedSeries.map((s) => (
            <path
              key={s.label}
              d={buildSmoothPath(s.points)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* Tooltip vertical line */}
          {tooltipData && (
            <line
              x1={tooltipData.x}
              y1={PAD.top}
              x2={tooltipData.x}
              y2={PAD.top + PLOT_H}
              stroke="currentColor"
              className="text-foreground/40"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}

          {/* Tooltip dots */}
          {tooltipData &&
            coords.mappedSeries.map((s) => {
              const closestPoint = s.points.reduce((best, p) =>
                Math.abs(p.x - tooltipData.x) < Math.abs(best.x - tooltipData.x) ? p : best
              , s.points[0])
              return (
                <circle
                  key={s.label}
                  cx={closestPoint.x}
                  cy={closestPoint.y}
                  r={3}
                  fill={s.color}
                  stroke="background"
                  strokeWidth={1.5}
                />
              )
            })}
        </svg>

        {/* Tooltip floating box */}
        {tooltipData && (
          <div
            className="absolute pointer-events-none z-10 bg-popover border border-border rounded-md px-2 py-1.5 text-xs shadow-md"
            style={{
              left: `calc(${((tooltipData.x - 40) / SVG_W) * 100}% + 8px)`,
              top: "-4px",
              transform: tooltipData.x > SVG_W * 0.7 ? "translateX(-100%)" : "none",
            }}
          >
            <div className="text-muted-foreground mb-1">
              {tooltipData.ts.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </div>
            {tooltipData.values.map((v) => (
              <div key={v.label} className="flex items-center gap-1.5 whitespace-nowrap">
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: v.color }}
                />
                <span className="text-foreground/80">{v.label}:</span>
                <span className="font-medium text-foreground">{v.value}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
        {coords.mappedSeries.map((s) => (
          <div key={s.label} className="flex items-center gap-1">
            <span
              className="inline-block w-2 h-2 rounded-full flex-shrink-0"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-[10px] text-muted-foreground">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
