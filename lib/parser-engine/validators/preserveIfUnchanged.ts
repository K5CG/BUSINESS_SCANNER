export function preserveIfUnchanged<T>(original: T, transformed: T): T {
  // Simple deep equality check via JSON stringify; for objects without functions.
  // If the transformed value is falsy or identical (ignoring case/whitespace for strings), return original.
  if (!transformed) return original;
  // Handle string comparison case-insensitively and trimmed.
  if (typeof original === 'string' && typeof transformed === 'string') {
    if (original.trim().toLowerCase() === transformed.trim().toLowerCase()) {
      return original as any;
    }
  }
  // General deep equality check.
  if (JSON.stringify(original) === JSON.stringify(transformed)) {
    return original;
  }
  return transformed;
}
