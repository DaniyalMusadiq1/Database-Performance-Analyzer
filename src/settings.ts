export function settingNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const bounded = Math.max(min, Math.min(max, number));
  return integer ? Math.floor(bounded) : bounded;
}
