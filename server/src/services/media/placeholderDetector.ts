export function isDefaultPlaceholder(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return /(?:^|[/=?&#])(?:al-0|ar-0|default[-_]?(?:cover|album|avatar|artwork)|(?:album[-_])?placeholder)(?:$|[/?.&#=_-])/i.test(decoded);
}
