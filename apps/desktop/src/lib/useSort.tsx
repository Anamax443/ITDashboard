import React, { useState, useMemo } from 'react';

export type SortDir = 'asc' | 'desc';

export interface SortState<T> {
  col: keyof T;
  dir: SortDir;
}

// Compare two non-null cell values. Numbers compare numerically, booleans
// false→true, and everything else via locale-aware comparison with `numeric`
// chunking + case/diacritics-insensitivity. That makes IPs ("10.8.2.9" <
// "10.8.2.10"), hostnames ("PC2" < "PC10") and accented text sort naturally,
// while ISO date strings still compare chronologically.
export function compareValues(av: unknown, bv: unknown): number {
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  if (typeof av === 'boolean' && typeof bv === 'boolean') return av === bv ? 0 : av ? 1 : -1;
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
}

function sortItems<T>(items: T[], sort: SortState<T> | null): T[] {
  if (!sort) return items;
  const arr = [...items];
  arr.sort((a, b) => {
    const av = a[sort.col];
    const bv = b[sort.col];
    // Empty values always sink to the bottom, regardless of sort direction.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    const c = compareValues(av, bv);
    return sort.dir === 'asc' ? c : -c;
  });
  return arr;
}

export function useSort<T>(initial?: SortState<T>) {
  const [sort, setSort] = useState<SortState<T> | null>(initial ?? null);

  const toggle = (col: keyof T) => {
    setSort((s) => (s?.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  };

  const apply = (items: T[]): T[] => sortItems(items, sort);

  return { sort, toggle, apply };
}

export function SortHeader<T>({ col, label, sort, toggle, width }: {
  col: keyof T;
  label: string;
  sort: SortState<T> | null;
  toggle: (col: keyof T) => void;
  width?: number;
}) {
  const active = sort?.col === col;
  const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      onClick={() => toggle(col)}
      style={{ width, cursor: 'pointer', userSelect: 'none' }}
      title="Click to sort"
    >
      {label}{arrow}
    </th>
  );
}

// Re-export so JSX can use it (Vite needs React import in same module)
export function useSortedItems<T>(items: T[], sort: SortState<T> | null): T[] {
  return useMemo(() => sortItems(items, sort), [items, sort]);
}
