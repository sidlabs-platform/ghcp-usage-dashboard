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
  const isSorted = sortField === field;
  const indicator = isSorted ? (sortAsc ? " ↑" : " ↓") : "";
  const ariaSort = isSorted ? (sortAsc ? "ascending" : "descending") : "none";

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      className={`pb-3 font-medium transition-colors ${
        align === "right" ? "text-right" : "text-left"
      } ${last ? "" : "pr-4"}`}
    >
      <button
        type="button"
        className={`w-full inline-flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))] rounded-sm px-1 -ml-1 cursor-pointer select-none hover:text-[hsl(var(--foreground))] ${
          align === "right" ? "flex-row-reverse justify-start" : "justify-start"
        }`}
        onClick={() => onSort(field)}
      >
        <span>{label}</span>
        {isSorted && (
          <span className="text-[hsl(var(--primary))] text-xs">{indicator}</span>
        )}
      </button>
    </th>
  );
}
