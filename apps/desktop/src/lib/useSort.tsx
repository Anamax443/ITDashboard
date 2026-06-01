import React, { useState, useMemo } from 'react';

export type SortDir = 'asc' | 'desc';

export interface SortState<T> {
  col: keyof T;
  dir: SortDir;
}

export function useSort<T>(initial?: SortState<T>) {
  const [sort, setSort] = useState<SortState<T> | null>(initial ?? null);

  const toggle = (col: keyof T) => {
    setSort((s) => (s?.col === col ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' }));
  };

  const apply = (items: T[]): T[] => {
    if (!sort) return items;
    const arr = [...items];
    arr.sort((a, b) => {
      const av = a[sort.col];
      const bv = b[sort.col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  };

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
  return useMemo(() => {
    if (!sort) return items;
    const arr = [...items];
    arr.sort((a, b) => {
      const av = a[sort.col];
      const bv = b[sort.col];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
    return arr;
  }, [items, sort]);
}
