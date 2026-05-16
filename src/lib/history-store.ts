import { LazyStore } from "@tauri-apps/plugin-store"
import type { MetricLine } from "@/lib/plugin-types"
import { clamp01 } from "@/lib/utils"

export type HistoryEntry = {
  timestamp: number // epoch ms
  percentage: number // 0-100
  used: number
  limit: number
}

export type HistorySnapshot = {
  providerId: string
  timestamp: number
  lines: { label: string; percentage: number; used: number; limit: number }[]
}

const HISTORY_STORE_PATH = "usage-history.json"
const DEDUP_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
const MAX_ENTRIES_PER_PROVIDER = 2000

let _store: LazyStore | null = null

function getStore(): LazyStore {
  if (!_store) {
    _store = new LazyStore(HISTORY_STORE_PATH)
  }
  return _store
}

// In-memory dedup tracker: providerId -> last recorded timestamp
const lastRecordedTimestamps = new Map<string, number>()

function extractProgressLines(
  lines: MetricLine[]
): { label: string; percentage: number; used: number; limit: number }[] {
  const result: { label: string; percentage: number; used: number; limit: number }[] = []
  for (const line of lines) {
    if (line.type === "progress" && line.format?.kind !== "count") {
      result.push({
        label: line.label,
        percentage: clamp01(line.used / line.limit) * 100,
        used: line.used,
        limit: line.limit,
      })
    }
  }
  return result
}

export async function recordSnapshot(
  providerId: string,
  lines: MetricLine[]
): Promise<void> {
  const progressLines = extractProgressLines(lines)
  if (progressLines.length === 0) return

  // Deduplication: skip if within 5 minutes of last recorded snapshot
  const now = Date.now()
  const lastTs = lastRecordedTimestamps.get(providerId) ?? 0
  if (now - lastTs < DEDUP_WINDOW_MS) return
  lastRecordedTimestamps.set(providerId, now)

  const snapshot: HistorySnapshot = {
    providerId,
    timestamp: now,
    lines: progressLines,
  }

  const store = getStore()

  // Load existing history
  const existing = await store.get<HistorySnapshot[]>(providerId)
  const history = existing ?? []

  // Append new snapshot
  history.push(snapshot)

  // Cap at MAX_ENTRIES_PER_PROVIDER (remove oldest first)
  if (history.length > MAX_ENTRIES_PER_PROVIDER) {
    history.splice(0, history.length - MAX_ENTRIES_PER_PROVIDER)
  }

  await store.set(providerId, history)
  await store.save()
}

export async function getHistory(
  providerId: string,
  timeRange?: { since: number; until: number }
): Promise<HistorySnapshot[]> {
  const store = getStore()
  const existing = await store.get<HistorySnapshot[]>(providerId)
  if (!existing) return []

  let history = existing

  if (timeRange) {
    history = history.filter(
      (entry) => entry.timestamp >= timeRange.since && entry.timestamp <= timeRange.until
    )
  }

  // Sort by timestamp ascending
  history.sort((a, b) => a.timestamp - b.timestamp)

  return history
}

export async function clearHistory(providerId?: string): Promise<void> {
  const store = getStore()
  if (providerId) {
    await store.set(providerId, [])
    lastRecordedTimestamps.delete(providerId)
  } else {
    // No provider specified — clear all dedup state
    lastRecordedTimestamps.clear()
  }
  await store.save()
}
