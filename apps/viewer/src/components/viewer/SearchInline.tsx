/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchInline — always-visible search field in the MainToolbar.
 *
 * P0: linear Tier-0 scan across already-cached EntityTable columns
 * (type, name, GlobalId, description, objectType). Tier-1 worker index
 * and SQL mode arrive in later phases on top of this same UI shell.
 *
 * Keyboard:
 *   • `/` or ⌘F / Ctrl+F  → focus the field (focus-suppressed when an
 *     input/textarea/CodeMirror editor already has focus)
 *   • ↑ / ↓               → navigate result rows in the popover
 *   • Enter               → select + frame the highlighted result
 *   • ⇧Enter              → add to multi-selection (no frame)
 *   • Esc                 → close popover; second Esc blurs the field
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Input } from '@/components/ui/input';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cn } from '@/lib/utils';
import { runTier0Scan, type SearchResult, type ScanModel } from '@/lib/search/tier0-scan';

const DEBOUNCE_MS = 80;
const RESULT_LIMIT = 50;

/** True when an editable surface has focus and should swallow `/` keystrokes. */
function isEditableFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // CodeMirror 6 editor — its content host wears `.cm-content`.
  if (el.closest?.('.cm-editor')) return true;
  return false;
}

export function SearchInline() {
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const {
    searchQuery,
    searchOpen,
    searchHighlightIndex,
    setSearchQuery,
    setSearchOpen,
    setSearchHighlightIndex,
    closeSearch,
    models,
    setSelectedEntity,
    setSelectedEntityId,
    addEntityToSelection,
    cameraCallbacks,
  } = useViewerStore(
    useShallow((s) => ({
      searchQuery: s.searchQuery,
      searchOpen: s.searchOpen,
      searchHighlightIndex: s.searchHighlightIndex,
      setSearchQuery: s.setSearchQuery,
      setSearchOpen: s.setSearchOpen,
      setSearchHighlightIndex: s.setSearchHighlightIndex,
      closeSearch: s.closeSearch,
      models: s.models,
      setSelectedEntity: s.setSelectedEntity,
      setSelectedEntityId: s.setSelectedEntityId,
      addEntityToSelection: s.addEntityToSelection,
      cameraCallbacks: s.cameraCallbacks,
    })),
  );

  // Debounce the query so each keystroke doesn't trigger a 4M-entity scan.
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(searchQuery), DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  // Snapshot the federated models into the shape the scanner needs.
  // Memoized on the `models` Map identity (Zustand returns a new Map on
  // every mutation), so the scanner's input array is stable between
  // unrelated renders.
  const scanModels = useMemo<ScanModel[]>(() => {
    const out: ScanModel[] = [];
    for (const m of models.values()) {
      if (m.ifcDataStore) out.push({ id: m.id, ifcDataStore: m.ifcDataStore });
    }
    return out;
  }, [models]);

  const results = useMemo<SearchResult[]>(() => {
    if (!debouncedQuery.trim() || scanModels.length === 0) return [];
    return runTier0Scan(scanModels, debouncedQuery, { limit: RESULT_LIMIT });
  }, [scanModels, debouncedQuery]);

  // Keep the highlight index in range as results change.
  useEffect(() => {
    if (results.length === 0) {
      if (searchHighlightIndex !== 0) setSearchHighlightIndex(0);
      return;
    }
    if (searchHighlightIndex >= results.length) {
      setSearchHighlightIndex(Math.max(0, results.length - 1));
    }
  }, [results, searchHighlightIndex, setSearchHighlightIndex]);

  /** Drive selection + frame from a result row. */
  const selectResult = useCallback(
    (r: SearchResult, addToSelection: boolean) => {
      const ref = { modelId: r.modelId, expressId: r.expressId };
      const isLegacy = r.modelId === 'legacy' || r.modelId === '__legacy__' || models.size === 0;
      const globalId = isLegacy ? r.expressId : toGlobalIdFromModels(models, r.modelId, r.expressId);

      if (addToSelection) {
        addEntityToSelection(ref);
        setSelectedEntityId(globalId);
      } else {
        setSelectedEntityId(globalId);
        setSelectedEntity(ref);
        // Frame after the selection state has flushed so the renderer
        // is targeting the freshly-selected entity, not the previous one.
        if (cameraCallbacks.frameSelection) {
          window.setTimeout(() => cameraCallbacks.frameSelection?.(), 50);
        }
      }
      closeSearch();
    },
    [
      addEntityToSelection,
      cameraCallbacks,
      closeSearch,
      models,
      setSelectedEntity,
      setSelectedEntityId,
    ],
  );

  /** Global `/` and ⌘F / Ctrl+F shortcuts to focus the field. */
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      // ⌘F / Ctrl+F focuses regardless of what else has focus — we want
      // to override the browser's native Find inside the viewer.
      const isFindShortcut = (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey;
      if (isFindShortcut) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setSearchOpen(true);
        return;
      }

      // `/` only when no other input is focused — vim-style search summon.
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableFocused()) {
        e.preventDefault();
        inputRef.current?.focus();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setSearchOpen]);

  /** Click-outside closes the popover (but doesn't blur the field). */
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [searchOpen, setSearchOpen]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Esc: first press closes popover, second blurs the field.
      if (e.key === 'Escape') {
        if (searchOpen) {
          e.preventDefault();
          setSearchOpen(false);
        } else {
          inputRef.current?.blur();
        }
        return;
      }

      if (!searchOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
        // Re-open the popover if the user is interacting with results.
        if (results.length > 0) setSearchOpen(true);
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (results.length === 0) return;
        const next = (searchHighlightIndex + 1) % results.length;
        setSearchHighlightIndex(next);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (results.length === 0) return;
        const next = (searchHighlightIndex - 1 + results.length) % results.length;
        setSearchHighlightIndex(next);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const target = results[searchHighlightIndex];
        if (target) selectResult(target, e.shiftKey);
      }
    },
    [results, searchHighlightIndex, searchOpen, selectResult, setSearchHighlightIndex, setSearchOpen],
  );

  const showPopover = searchOpen && (results.length > 0 || searchQuery.trim().length > 0);

  return (
    <div ref={containerRef} className="relative w-72">
      <Input
        ref={inputRef}
        type="text"
        placeholder="Search GUID, name, type… ( / )"
        value={searchQuery}
        leftIcon={<Search className="h-4 w-4" />}
        onChange={(e) => {
          setSearchQuery(e.target.value);
          if (!searchOpen) setSearchOpen(true);
        }}
        onFocus={() => {
          if (searchQuery.trim().length > 0) setSearchOpen(true);
        }}
        onKeyDown={handleInputKeyDown}
        aria-label="Search entities"
        aria-autocomplete="list"
        aria-expanded={showPopover}
        aria-controls="search-inline-popover"
      />
      {showPopover && (
        <SearchPopover
          results={results}
          highlightIndex={searchHighlightIndex}
          modelsCount={models.size}
          onSelect={(r, additive) => selectResult(r, additive)}
          onHover={(i) => setSearchHighlightIndex(i)}
        />
      )}
    </div>
  );
}

interface SearchPopoverProps {
  results: SearchResult[];
  highlightIndex: number;
  modelsCount: number;
  onSelect: (r: SearchResult, additive: boolean) => void;
  onHover: (index: number) => void;
}

function SearchPopover({ results, highlightIndex, modelsCount, onSelect, onHover }: SearchPopoverProps) {
  if (results.length === 0) {
    return (
      <div
        id="search-inline-popover"
        role="listbox"
        className="absolute left-0 right-0 top-full mt-1 rounded-md border border-zinc-200 bg-white px-3 py-4 text-xs text-muted-foreground shadow-lg dark:border-zinc-800 dark:bg-zinc-950 z-50"
      >
        No results — try a name, IFC type, or full GlobalId.
      </div>
    );
  }

  return (
    <div
      id="search-inline-popover"
      role="listbox"
      className="absolute left-0 right-0 top-full mt-1 max-h-96 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 z-50"
    >
      {results.map((r, i) => (
        <button
          key={`${r.modelId}:${r.expressId}`}
          type="button"
          role="option"
          aria-selected={i === highlightIndex}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown so the input doesn't blur first and tear down the popover.
            e.preventDefault();
            onSelect(r, e.shiftKey);
          }}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
            i === highlightIndex
              ? 'bg-zinc-100 dark:bg-zinc-800'
              : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
          )}
        >
          <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {r.typeName}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {r.name || <span className="italic text-muted-foreground">unnamed</span>}
          </span>
          {r.globalId && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {r.globalId.slice(0, 8)}…
            </span>
          )}
          {modelsCount > 1 && (
            <span className="shrink-0 rounded border border-zinc-300 px-1 py-0.5 text-[10px] text-muted-foreground dark:border-zinc-700">
              {r.modelId.slice(0, 6)}
            </span>
          )}
        </button>
      ))}
      <div className="border-t border-zinc-200 px-3 py-1 text-[10px] text-muted-foreground dark:border-zinc-800">
        {results.length} result{results.length === 1 ? '' : 's'} · ↑↓ nav · ↵ select · ⇧↵ multi · Esc close
      </div>
    </div>
  );
}
