/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Search state slice
 *
 * Inline-toolbar search bar state — query string, popover visibility,
 * keyboard-navigation index, plus the per-model Tier-1 search indexes
 * built post-load. The actual scan results are derived in SearchInline
 * via useMemo; keeping derived results out of the store avoids needless
 * re-renders elsewhere.
 *
 * Tier hierarchy:
 *   Tier-0 — linear scan over already-cached EntityTable columns
 *            (zero build cost; fallback while Tier-1 is building)
 *   Tier-1 — per-model inverted token index built after load
 *            (zero load hot-path cost; yielded in chunks)
 *   Tier-3 — DuckDB SQL (handled in the modal, layered on top)
 */

import type { StateCreator } from 'zustand';
import type { Tier1Index } from '@/lib/search/tier1-index';

/** Index lifecycle state for a single model. */
export type Tier1IndexStatus = 'pending' | 'building' | 'ready' | 'error';

export interface Tier1IndexRecord {
  status: Tier1IndexStatus;
  /** Only present when status === 'ready'. */
  index?: Tier1Index;
  /** Progress in [0, 1] while status === 'building'. */
  progress?: number;
  /** Diagnostic message when status === 'error'. */
  error?: string;
}

export interface SearchSlice {
  /** Current input value (debounced consumers may stage their own copy). */
  searchQuery: string;
  /** Popover open below the inline field. */
  searchOpen: boolean;
  /** Currently highlighted result index in the popover (arrow-key nav). */
  searchHighlightIndex: number;
  /** Per-model Tier-1 index lifecycle (modelId → record). */
  searchIndexes: Map<string, Tier1IndexRecord>;

  setSearchQuery: (query: string) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchHighlightIndex: (index: number) => void;
  /** Convenience: close popover and reset highlight (preserves query). */
  closeSearch: () => void;
  /** Convenience: clear query and close popover. */
  resetSearch: () => void;

  /** Replace (or insert) the index record for a model. */
  setSearchIndexRecord: (modelId: string, record: Tier1IndexRecord) => void;
  /** Drop the index record for a model (called when a model is removed). */
  removeSearchIndexRecord: (modelId: string) => void;
}

export const createSearchSlice: StateCreator<SearchSlice, [], [], SearchSlice> = (set) => ({
  searchQuery: '',
  searchOpen: false,
  searchHighlightIndex: 0,
  searchIndexes: new Map(),

  setSearchQuery: (searchQuery) => set({ searchQuery, searchHighlightIndex: 0 }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSearchHighlightIndex: (searchHighlightIndex) => set({ searchHighlightIndex }),

  closeSearch: () => set({ searchOpen: false, searchHighlightIndex: 0 }),
  resetSearch: () => set({ searchQuery: '', searchOpen: false, searchHighlightIndex: 0 }),

  setSearchIndexRecord: (modelId, record) =>
    set((state) => {
      const next = new Map(state.searchIndexes);
      next.set(modelId, record);
      return { searchIndexes: next };
    }),

  removeSearchIndexRecord: (modelId) =>
    set((state) => {
      if (!state.searchIndexes.has(modelId)) return {};
      const next = new Map(state.searchIndexes);
      next.delete(modelId);
      return { searchIndexes: next };
    }),
});
