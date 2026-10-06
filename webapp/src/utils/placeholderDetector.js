export function isDefaultPlaceholder(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return /(?:^|[/=?&#])(?:al-0|ar-0|default[-_]?(?:cover|album|avatar|artwork)|(?:album[-_])?placeholder)(?:$|[/?.&#=_-])/i.test(decoded);
}
