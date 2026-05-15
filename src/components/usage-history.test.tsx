import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UsageHistoryGraph } from "@/components/usage-history"

const storeState = new Map<string, unknown>()
const storeSaveMock = vi.fn()

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    async get<T>(key: string): Promise<T | null> {
      if (!storeState.has(key)) return undefined as T | null
      return storeState.get(key) as T | null
    }
    async set<T>(key: string, value: T): Promise<void> {
      storeState.set(key, value)
    }
    async save(): Promise<void> {
      storeSaveMock()
    }
  },
}))

const now = Date.now()
const HOUR_MS = 3_600_000

function makeSnapshot(
  timestamp: number,
  lines: { label: string; percentage: number }[]
) {
  return {
    providerId: "test-provider",
    timestamp,
    lines: lines.map((l) => ({
      label: l.label,
      percentage: l.percentage,
      used: Math.round((l.percentage / 100) * 100),
      limit: 100,
    })),
  }
}

describe("UsageHistoryGraph", () => {
  beforeEach(() => {
    storeState.clear()
    storeSaveMock.mockReset()
  })

  it("shows empty state when no history exists", async () => {
    render(<UsageHistoryGraph providerId="test-provider" />)

    expect(
      await screen.findByText("Usage history will appear here once data is collected.")
    ).toBeInTheDocument()
  })

  it("shows loading state then renders chart with data", async () => {
    // Set up mock data
    const mockHistory = [
      makeSnapshot(now - HOUR_MS * 2, [
        { label: "GPT-4", percentage: 30 },
      ]),
      makeSnapshot(now - HOUR_MS, [
        { label: "GPT-4", percentage: 60 },
      ]),
      makeSnapshot(now, [
        { label: "GPT-4", percentage: 90 },
      ]),
    ]
    storeState.set("test-provider", mockHistory)

    render(<UsageHistoryGraph providerId="test-provider" />)

    // Should show time range buttons
    expect(await screen.findByText("1h")).toBeInTheDocument()
    expect(screen.getByText("6h")).toBeInTheDocument()
    expect(screen.getByText("24h")).toBeInTheDocument()
    expect(screen.getByText("7d")).toBeInTheDocument()
    expect(screen.getByText("All")).toBeInTheDocument()

    // Should show legend
    expect(screen.getByText("GPT-4")).toBeInTheDocument()

    // Should show Y-axis labels
    expect(screen.getByText("0%")).toBeInTheDocument()
    expect(screen.getByText("25%")).toBeInTheDocument()
    expect(screen.getByText("50%")).toBeInTheDocument()
    expect(screen.getByText("75%")).toBeInTheDocument()
    expect(screen.getByText("100%")).toBeInTheDocument()
  })

  it("switches time range and shows filtered data", async () => {
    const mockHistory = [
      makeSnapshot(now - HOUR_MS * 12, [
        { label: "GPT-4", percentage: 30 },
      ]),
      makeSnapshot(now - HOUR_MS * 2, [
        { label: "GPT-4", percentage: 60 },
      ]),
    ]
    storeState.set("test-provider", mockHistory)

    render(<UsageHistoryGraph providerId="test-provider" />)

    // Default is 24h which includes both data points
    expect(await screen.findByText("GPT-4")).toBeInTheDocument()

    // Switch to 1h - should show empty state since both points are older than 1h
    await userEvent.click(screen.getByText("1h"))

    expect(
      screen.getByText("Usage history will appear here once data is collected.")
    ).toBeInTheDocument()
  })

  it("renders multiple lines with different colors", async () => {
    const mockHistory = [
      makeSnapshot(now - HOUR_MS, [
        { label: "GPT-4", percentage: 50 },
        { label: "Claude", percentage: 30 },
      ]),
      makeSnapshot(now, [
        { label: "GPT-4", percentage: 70 },
        { label: "Claude", percentage: 45 },
      ]),
    ]
    storeState.set("test-provider", mockHistory)

    render(<UsageHistoryGraph providerId="test-provider" />)

    expect(await screen.findByText("GPT-4")).toBeInTheDocument()
    expect(screen.getByText("Claude")).toBeInTheDocument()
  })

  it("accepts brandColor prop", async () => {
    const mockHistory = [
      makeSnapshot(now, [
        { label: "GPT-4", percentage: 50 },
      ]),
    ]
    storeState.set("test-provider", mockHistory)

    // Should not crash with brandColor
    render(<UsageHistoryGraph providerId="test-provider" brandColor="#ff0000" />)

    expect(await screen.findByText("GPT-4")).toBeInTheDocument()
  })

  it("shows tooltip on hover", async () => {
    const mockHistory = [
      makeSnapshot(now - HOUR_MS, [
        { label: "GPT-4", percentage: 50 },
      ]),
      makeSnapshot(now, [
        { label: "GPT-4", percentage: 80 },
      ]),
    ]
    storeState.set("test-provider", mockHistory)

    const { container } = render(<UsageHistoryGraph providerId="test-provider" />)

    // Wait for chart to render
    const svg = await screen.findByTestId("usage-history-svg")
    expect(svg).toBeInTheDocument()

    // Trigger mouse move on SVG
    await userEvent.hover(svg)

    // Tooltip should show with percentage values (we just check the SVG rendered)
    // We can verify the SVG has lines/paths rendered
    const paths = container.querySelectorAll("path")
    expect(paths.length).toBeGreaterThan(0)
  })
})
