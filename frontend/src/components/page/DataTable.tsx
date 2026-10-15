import type { CSSProperties, JSX, ReactNode } from 'react';
import { joinClasses } from './Layout';
import { EmptyState } from './EmptyState';

export interface DataColumn<Row> {
  key: string;
  /** Header text; also the cell label when rows stack into cards at 600 px and below. */
  label: string;
  /** Right-aligned mono tabular figures (counts, bytes, ms, Hz). */
  numeric?: boolean;
  /** Mono text such as a path, key or code. */
  code?: boolean;
  /** CSS width of the column, e.g. '96px' or '20%'. */
  width?: string;
  /** Header tooltip. */
  title?: string;
  /** Cell content; without it the row's value at `key` is shown when it is a string or number. */
  render?: (row: Row, index: number) => ReactNode;
  /** Extra class for the cells of this column. */
  className?: string;
}

function defaultCell(row: unknown, key: string): ReactNode {
  const value = row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' || typeof value === 'number' ? value : '—';
}

/**
 * A dense table: sticky header (inside its own scroll box when maxHeight is
 * set), 36 px rows, numeric columns right-aligned in mono. At 600 px and
 * below each row becomes a two-column card (`stack`, default on), so the
 * page never scrolls sideways. With no rows and `empty`, a one-line
 * EmptyState replaces the table.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  rowClassName,
  label,
  empty,
  stack = true,
  maxHeight,
  minWidth,
  className,
}: {
  columns: ReadonlyArray<DataColumn<Row>>;
  rows: ReadonlyArray<Row>;
  rowKey?: (row: Row, index: number) => string;
  rowClassName?: (row: Row, index: number) => string | undefined;
  /** Accessible name; also makes the scroll box a focusable region. */
  label?: string;
  /** One short line shown instead of the table when there are no rows. */
  empty?: string;
  stack?: boolean;
  /** Max height of the scroll box, e.g. '320px'; the header stays visible while rows scroll. */
  maxHeight?: string;
  /** Min table width before the box scrolls sideways (only above 600 px when stacking). */
  minWidth?: string;
  className?: string;
}): JSX.Element {
  if (!rows.length && empty !== undefined) return <EmptyState label={empty} />;
  const style: CSSProperties & Record<string, string> = {};
  if (maxHeight) style['--pg-table-max'] = maxHeight;
  if (minWidth) style['--pg-table-min'] = minWidth;
  return (
    <div
      className={joinClasses('pg-table-wrap', className)}
      style={Object.keys(style).length ? style : undefined}
      role={label ? 'region' : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
    >
      <table className={joinClasses('pg-table', stack && 'is-stack')}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={joinClasses(column.numeric && 'is-num', column.className) || undefined} style={column.width ? { width: column.width } : undefined} title={column.title}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey ? rowKey(row, index) : index} className={rowClassName?.(row, index)}>
              {columns.map((column) => (
                <td key={column.key} data-label={column.label} className={joinClasses(column.numeric && 'is-num', column.code && 'is-code', column.className) || undefined}>
                  {column.render ? column.render(row, index) : defaultCell(row, column.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
