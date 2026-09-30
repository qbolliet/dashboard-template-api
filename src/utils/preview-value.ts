// ─── Aperçu de valeurs fournies par le client ────────────────────────────────

/** Default maximum length of a preview, in characters (ellipsis excluded). */
const DEFAULT_PREVIEW_LENGTH = 80;

/**
 * Renders a client-supplied value for an error message, bounded in length.
 *
 * Values are bound parameters and are not size-limited, so a message that
 * echoes one must truncate it: the error is returned to the client and logged.
 * The value is written as compact JSON (a string keeps its double quotes) and
 * cut after `maxLength` characters with an ellipsis « … ».
 *
 * @param value - Value or name received from the client.
 * @param maxLength - Maximum number of characters kept before the ellipsis.
 * @returns Compact JSON of the value, truncated with « … » when too long.
 */
// Aperçu compact et tronqué d'une valeur recopiée dans un message d'erreur
function previewValue(value: unknown, maxLength: number = DEFAULT_PREVIEW_LENGTH): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    // BigInt, référence circulaire : repli sur la conversion en chaîne
    text = String(value);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export { previewValue, DEFAULT_PREVIEW_LENGTH };
