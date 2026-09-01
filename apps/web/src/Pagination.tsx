import { formatCount } from './format';

export const LIST_PAGE_SIZE = 10;

export function pageSlice<T>(
  items: readonly T[],
  page: number,
  pageSize: number = LIST_PAGE_SIZE,
): { rows: T[]; page: number; pageCount: number; total: number } {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, page), pageCount);
  const start = (safePage - 1) * pageSize;
  return {
    rows: items.slice(start, start + pageSize),
    page: safePage,
    pageCount,
    total: items.length,
  };
}

export function Pagination({
  page,
  pageCount,
  onPage,
  label,
  testId,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  label: string;
  testId: string;
}) {
  return (
    <nav className="pagination" aria-label={label}>
      <button
        className="button"
        type="button"
        data-testid={`${testId}-prev`}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        Previous page
      </button>
      <span data-testid={`${testId}-status`}>
        Page {formatCount(page)} of {formatCount(pageCount)}
      </span>
      <button
        className="button"
        type="button"
        data-testid={`${testId}-next`}
        disabled={page >= pageCount}
        onClick={() => onPage(page + 1)}
      >
        Next page
      </button>
    </nav>
  );
}
