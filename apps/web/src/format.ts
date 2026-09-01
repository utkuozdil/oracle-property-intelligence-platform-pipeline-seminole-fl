/** Rendered wherever the source data has no value. Never an empty cell. */
export const MISSING = '—';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const decimal = new Intl.NumberFormat('en-US');

export function formatCurrency(value: number | null | undefined): string {
  return value === null || value === undefined ? MISSING : currency.format(value);
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? MISSING : decimal.format(value);
}

export function formatCount(value: number): string {
  return decimal.format(value);
}

/** Years are rendered bare: `1985`, never `1,985`. */
export function formatYear(value: number | null | undefined): string {
  return value === null || value === undefined ? MISSING : String(value);
}

export function formatDate(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? MISSING : value;
}

export function formatBoolean(value: boolean): string {
  return value ? 'Yes' : 'No';
}

export function formatCoordinate(value: number | null | undefined): string {
  return value === null || value === undefined ? MISSING : value.toFixed(6);
}

/** Timestamps render as `YYYY-MM-DD HH:MM:SS UTC`; a missing one is never blank. */
export function formatTimestamp(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return MISSING;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return MISSING;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Deltas always carry their sign, so "no change" reads as `0` and not as an empty cell. */
export function formatSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${decimal.format(Math.abs(value))}`;
}

export function formatMiles(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  if (value < 0.1) return `${(value * 5280).toFixed(0)} ft`;
  return `${value.toFixed(2)} mi`;
}

/** Empty string means "filter not set", which is different from zero. */
export function toOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
