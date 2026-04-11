interface SortableHeaderProps<K extends string> {
  label: string;
  field: K;
  sortField: K;
  sortAsc: boolean;
  onSort: (field: K) => void;
  align?: "left" | "right";
  /** If true, this is the last column (no right padding) */
  last?: boolean;
}

export function SortableHeader<K extends string>({
  label,
  field,
  sortField,
  sortAsc,
  onSort,
  align = "left",
  last = false,
}: SortableHeaderProps<K>) {
  const indicator = sortField === field ? (sortAsc ? " ↑" : " ↓") : "";
  return (
    <th
      className={`pb-3 font-medium cursor-pointer select-none hover:text-[hsl(var(--foreground))] transition-colors ${
        align === "right" ? "text-right" : "text-left"
      } ${last ? "" : "pr-4"}`}
      onClick={() => onSort(field)}
    >
      {label}{indicator}
    </th>
  );
}
