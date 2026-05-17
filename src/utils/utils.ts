/** Structured filter used to build a SQL WHERE clause. */
interface StructuredFilter {
  key: string;
  operator: string;
  value?: string | null;
  values?: (string | null | undefined)[];
}

/**
 * Validates a SQL identifier against safe naming rules.
 *
 * Rejects anything that starts with a digit or contains characters outside
 * the set [a-zA-Z0-9_] to prevent SQL injection via identifier names.
 *
 * @param name - The candidate identifier to validate.
 * @param context - Label used in the error message to describe the identifier type.
 * @returns The validated identifier, unchanged.
 * @throws {Error} When the identifier contains unsafe characters or is not a string.
 */
// Validation d'un identifiant SQL — protection contre les injections par nom de champ
const validateIdentifier = (name: unknown, context: string = 'field'): string => {
  if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      `Invalid ${context} name: "${name}". Only alphanumeric characters and underscores are allowed.`,
    );
  }
  return name;
};

/**
 * Builds a SQL WHERE clause from raw and structured filters.
 *
 * Handles IN / NOT IN operators with arrays, single-value comparisons, and
 * value-less operators such as IS NULL. String values are automatically
 * quoted and single-quote characters are escaped.
 *
 * @param filters - Raw SQL predicate string (trusted upstream).
 * @param structuredFilters - Typed filter objects to convert to SQL predicates.
 * @returns A complete WHERE clause string, or an empty string when no filters exist.
 */
// Construction de la clause WHERE à partir des filtres bruts et structurés
const buildWhereClause = (
  filters: string | null | undefined,
  structuredFilters: StructuredFilter[] | null | undefined,
): string => {
  let whereClause = '';

  if (filters) {
    whereClause += `(${filters})`;
  }

  if (structuredFilters && structuredFilters.length > 0) {
    const structuredClause = structuredFilters
      .map((filter) => {
        const { key, operator, value, values } = filter;
        validateIdentifier(key, 'filter key');

        // Gestion des opérateurs IN et NOT IN avec des tableaux de valeurs
        if ((operator === 'IN' || operator === 'NOT IN') && values && values.length > 0) {
          // Formatage des valeurs pour les opérateurs IN / NOT IN
          const formattedValues = values
            .map((val) => {
              if (val === null || val === undefined) {
                return 'NULL';
              }
              // Détection automatique du type de données
              if (!isNaN(Number(val)) && !isNaN(parseFloat(val))) {
                return val;
              }
              if (val === 'true' || val === 'false') {
                return val;
              }
              // Échappement des quotes simples pour les chaînes
              return `'${val.replace(/'/g, "''")}'`;
            })
            .join(', ');

          return `${key} ${operator} (${formattedValues})`;
        }

        // Gestion des opérateurs à valeur unique
        if (value !== undefined && value !== null) {
          // Détection automatique du type de données
          if (!isNaN(Number(value)) && !isNaN(parseFloat(value))) {
            return `${key} ${operator} ${value}`;
          }
          if (value === 'true' || value === 'false') {
            return `${key} ${operator} ${value}`;
          }
          // Échappement des quotes simples pour les chaînes
          return `${key} ${operator} '${value.replace(/'/g, "''")}'`;
        }

        // Opérateurs sans valeur (ex. IS NULL, IS NOT NULL)
        return `${key} ${operator}`;
      })
      .join(' AND ');

    whereClause += filters ? ` AND (${structuredClause})` : structuredClause;
  }

  return whereClause ? `WHERE ${whereClause}` : '';
};

export { buildWhereClause, validateIdentifier };
export type { StructuredFilter };
