/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Search state slice
 *
 * Inline-toolbar search bar state — query string, popover visibility,
 * keyboard-navigation index. The actual scan results are derived in
 * SearchInline via useMemo over the federated `models` map; keeping
 * derived results out of the store avoids needless re-renders elsewhere.
 *
 * P0 covers Tier-0 (already-cached EntityTable columns: type, name,
 * GlobalId, description, objectType). Tier-1 worker index and Tier-3
 * DuckDB SQL extend this slice in later phases.
 */

import type { StateCreator } from 'zustand';

export interface SearchSlice {
  /** Current input value (debounced consumers may stage their own copy). */
  searchQuery: string;
  /** Popover open below the inline field. */
  searchOpen: boolean;
  /** Currently highlighted result index in the popover (arrow-key nav). */
  searchHighlightIndex: number;

  setSearchQuery: (query: string) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchHighlightIndex: (index: number) => void;
  /** Convenience: close popover and reset highlight (preserves query). */
  closeSearch: () => void;
  /** Convenience: clear query and close popover. */
  resetSearch: () => void;
}

export const createSearchSlice: StateCreator<SearchSlice, [], [], SearchSlice> = (set) => ({
  searchQuery: '',
  searchOpen: false,
  searchHighlightIndex: 0,

  setSearchQuery: (searchQuery) => set({ searchQuery, searchHighlightIndex: 0 }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSearchHighlightIndex: (searchHighlightIndex) => set({ searchHighlightIndex }),

  closeSearch: () => set({ searchOpen: false, searchHighlightIndex: 0 }),
  resetSearch: () => set({ searchQuery: '', searchOpen: false, searchHighlightIndex: 0 }),
});
