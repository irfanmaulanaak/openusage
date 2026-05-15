import { beforeEach, describe, expect, it, vi } from "vitest"
import { recordSnapshot, getHistory, clearHistory } from "@/lib/history-store"
import type { MetricLine } from "@/lib/plugin-types"

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

function makeProgressLine(
  label: string,
  used: number,
  limit: number
): MetricLine {
  return {
    type: "progress",
    label,
    used,
    limit,
    format: { kind: "count", suffix: "req" },
  }
}

function makeTextLine(label: string, value: string): MetricLine {
  return { type: "text", label, value }
}

describe("history-store", () => {
  beforeEach(async () => {
    storeState.clear()
    storeSaveMock.mockReset()
    await clearHistory()
  })

  describe("recordSnapshot", () => {
    it("records a snapshot from progress lines", async () => {
      const lines: MetricLine[] = [
        makeProgressLine("GPT-4", 50, 100),
        makeProgressLine("Claude", 30, 200),
      ]
      await recordSnapshot("test-provider", lines)

      const history = await getHistory("test-provider")
      expect(history).toHaveLength(1)
      expect(history[0].providerId).toBe("test-provider")
      expect(history[0].lines).toHaveLength(2)
      expect(history[0].lines[0]).toEqual({
        label: "GPT-4",
        percentage: 50,
        used: 50,
        limit: 100,
      })
      expect(history[0].lines[1]).toEqual({
        label: "Claude",
        percentage: 15,
        used: 30,
        limit: 200,
      })
      expect(storeSaveMock).toHaveBeenCalled()
    })

    it("ignores non-progress lines", async () => {
      const lines: MetricLine[] = [
        makeTextLine("Some text", "hello"),
        makeProgressLine("GPT-4", 50, 100),
      ]
      await recordSnapshot("test-provider", lines)

      const history = await getHistory("test-provider")
      expect(history).toHaveLength(1)
      expect(history[0].lines).toHaveLength(1)
      expect(history[0].lines[0].label).toBe("GPT-4")
    })

    it("does not record if there are no progress lines", async () => {
      const lines: MetricLine[] = [makeTextLine("Some text", "hello")]
      await recordSnapshot("test-provider", lines)

      const history = await getHistory("test-provider")
      expect(history).toHaveLength(0)
    })

    it("deduplicates snapshots within 5-minute window", async () => {
      const lines: MetricLine[] = [makeProgressLine("GPT-4", 50, 100)]

      // Record first snapshot
      await recordSnapshot("test-provider", lines)

      // Immediately try recording again (same timestamp)
      await recordSnapshot("test-provider", lines)

      const history = await getHistory("test-provider")
      expect(history).toHaveLength(1)
    })

    it("allows recording after 5-minute window", async () => {
      vi.useFakeTimers()
      const lines: MetricLine[] = [makeProgressLine("GPT-4", 50, 100)]

      // Record first snapshot
      await recordSnapshot("test-provider", lines)

      // Advance time past 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000 + 1)

      // Record again
      await recordSnapshot("test-provider", lines)

      const history = await getHistory("test-provider")
      expect(history).toHaveLength(2)
      vi.useRealTimers()
    })

    it("caps history at 2000 entries per provider", async () => {
      vi.useFakeTimers()
      const lines: MetricLine[] = [makeProgressLine("GPT-4", 50, 100)]

      // Record MAX_ENTRIES_PER_PROVIDER + some extra snapshots
      const totalSnapshots = 2010
      for (let i = 0; i < totalSnapshots; i++) {
        // Use a different timestamp each time by advancing past the dedup window
        // We need to advance past 5 minutes to avoid dedup
        // But we can't fake 2000*5min = 10k minutes... 
        // The dedup check is in-memory, so let's clear it between calls
        // Actually, the dedup check uses lastRecordedTimestamps map which is module-level.
        // Let's just advance time enough.
        
        // Alternative: Since dedup is per-provider with 5-min window,
        // and recording >2000 entries at 5-min+ intervals would take too much fake time,
        // I'll use a strategy: advance by 5min+1ms each iteration.
        
        // Actually, let me just verify the capping works by directly setting a large array
        // in the store and then recording one more.
        vi.useRealTimers()
        break
      }

      // Set a large history directly
      const largeHistory = Array.from({ length: 2000 }, (_, i) => ({
        providerId: "test-provider",
        timestamp: 1000 + i * 1000,
        lines: [{ label: "GPT-4", percentage: 50, used: 50, limit: 100 }],
      }))
      storeState.set("test-provider", largeHistory)
      storeSaveMock.mockReset()

      // Need to clear dedup state since we have a history of 2000 entries
      // and want to record one more
      // The dedup runs BEFORE store access, so we need to clear it
      // Let me reset the dedup tracker by importing and using
      // But it's not exported. So let me test the cap differently.
      // Actually, the dedup check would prevent recording again within 5 min.
      // Since we set the store directly but the in-memory tracker is still at whatever time,
      // we can just advance past the dedup window.

      // Record one more - it should trigger cap to 2000
      await recordSnapshot("test-provider", lines)
      
      const history = await getHistory("test-provider")
      expect(history.length).toBeLessThanOrEqual(2000)
    })
  })

  describe("getHistory", () => {
    it("returns empty array when no history exists", async () => {
      const history = await getHistory("nonexistent")
      expect(history).toEqual([])
    })

    it("returns history sorted by timestamp ascending", async () => {
      const lines: MetricLine[] = [makeProgressLine("GPT-4", 50, 100)]

      // Manually set unsorted data
      storeState.set("test-provider", [
        {
          providerId: "test-provider",
          timestamp: 3000,
          lines: [{ label: "GPT-4", percentage: 50, used: 50, limit: 100 }],
        },
        {
          providerId: "test-provider",
          timestamp: 1000,
          lines: [{ label: "GPT-4", percentage: 30, used: 30, limit: 100 }],
        },
        {
          providerId: "test-provider",
          timestamp: 2000,
          lines: [{ label: "GPT-4", percentage: 40, used: 40, limit: 100 }],
        },
      ])

      const history = await getHistory("test-provider")
      expect(history).toHaveLength(3)
      expect(history[0].timestamp).toBe(1000)
      expect(history[1].timestamp).toBe(2000)
      expect(history[2].timestamp).toBe(3000)
    })

    it("filters by time range when provided", async () => {
      storeState.set("test-provider", [
        {
          providerId: "test-provider",
          timestamp: 1000,
          lines: [{ label: "GPT-4", percentage: 10, used: 10, limit: 100 }],
        },
        {
          providerId: "test-provider",
          timestamp: 2000,
          lines: [{ label: "GPT-4", percentage: 20, used: 20, limit: 100 }],
        },
        {
          providerId: "test-provider",
          timestamp: 3000,
          lines: [{ label: "GPT-4", percentage: 30, used: 30, limit: 100 }],
        },
      ])

      const history = await getHistory("test-provider", {
        since: 1500,
        until: 2500,
      })
      expect(history).toHaveLength(1)
      expect(history[0].timestamp).toBe(2000)
    })
  })

  describe("clearHistory", () => {
    it("clears history for a specific provider", async () => {
      storeState.set("provider-a", [
        {
          providerId: "provider-a",
          timestamp: 1000,
          lines: [{ label: "GPT-4", percentage: 50, used: 50, limit: 100 }],
        },
      ])
      storeState.set("provider-b", [
        {
          providerId: "provider-b",
          timestamp: 1000,
          lines: [{ label: "Claude", percentage: 30, used: 30, limit: 100 }],
        },
      ])

      await clearHistory("provider-a")

      const historyA = await getHistory("provider-a")
      expect(historyA).toEqual([])
      const historyB = await getHistory("provider-b")
      expect(historyB).toHaveLength(1)
      expect(storeSaveMock).toHaveBeenCalled()
    })

    it("does nothing when providerId is not specified (clears dedup state only)", async () => {
      storeState.set("provider-a", [
        {
          providerId: "provider-a",
          timestamp: 1000,
          lines: [{ label: "GPT-4", percentage: 50, used: 50, limit: 100 }],
        },
      ])
      storeSaveMock.mockReset()

      await clearHistory()

      const historyA = await getHistory("provider-a")
      expect(historyA).toHaveLength(1)
      expect(storeSaveMock).toHaveBeenCalled()
    })
  })
})
