export function toggleDocumentSelection(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectVisibleDocuments(current: ReadonlySet<string>, visibleIds: readonly string[]): Set<string> {
  const next = new Set(current);
  visibleIds.forEach((id) => next.add(id));
  return next;
}

export function deselectVisibleDocuments(
  current: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  const visible = new Set(visibleIds);
  return new Set([...current].filter((id) => !visible.has(id)));
}

export function pruneDocumentSelection(current: ReadonlySet<string>, existingIds: ReadonlySet<string>): Set<string> {
  return new Set([...current].filter((id) => existingIds.has(id)));
}
