// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Field metadata returned by the metadata loader. */
export interface FieldMetadata {
  is_primary_key?: boolean;
  [key: string]: unknown;
}

/** A single named column value of a fact row (type preserved as loaded). */
export interface FieldValueEntry {
  name: string;
  value: unknown;
}

/** Set of DataLoader instances required to partition facts. */
export interface Loaders {
  metadata: {
    load: (fieldName: string) => Promise<FieldMetadata | null>;
  };
}

/** Raw fact — an object whose keys are fact table column names. */
export type Fact = Record<string, unknown>;

/** Result of the partition: a fact carrying its coordinates and its measures. */
type PartitionedFact = Fact & {
  keys: FieldValueEntry[];
  measures: FieldValueEntry[];
};

// ─── Partition des colonnes d'un fait ────────────────────────────────────────

// Champs internes ajoutés par l'API, jamais des colonnes de la base
const INTERNAL_FIELDS = ['_groupByField', 'keys', 'measures'];

/**
 * Partitions the columns of each fact into coordinates and measures.
 *
 * Classification is driven solely by `metadata.is_primary_key`: a column with
 * `is_primary_key === false` is a measure, every other column (coordinate, or
 * one without a metadata row) is a key. Both arrays keep NULL values so that
 * every row of a result set has the same shape — in particular the levels left
 * NULL by an irregular column hierarchy.
 *
 * The fact table stores labels directly, so no label lookup is performed: one
 * metadata load per distinct column is the whole cost.
 *
 * @param facts - Array of raw fact objects to partition.
 * @param loaders - GraphQL DataLoader collection (metadata only).
 * @returns Facts carrying `keys` and `measures` arrays.
 */
// Partition des colonnes : clés (is_primary_key) contre mesures
export async function partitionFacts(facts: Fact[], loaders: Loaders): Promise<PartitionedFact[]> {
  if (!facts || facts.length === 0) {
    return facts as PartitionedFact[];
  }

  // Collecte de toutes les colonnes présentes (pour charger leur metadata)
  const columnSet = new Set<string>();
  facts.forEach((fact) => {
    if (!fact || typeof fact !== 'object') return;
    Object.keys(fact).forEach((key) => {
      if (!INTERNAL_FIELDS.includes(key)) columnSet.add(key);
    });
  });

  if (columnSet.size === 0) {
    return facts.map((fact) => ({ ...fact, keys: [], measures: [] }));
  }

  const columns = Array.from(columnSet);

  // Chargement des métadonnées de chaque colonne pour la classification
  const metadataResults = await Promise.all(columns.map((name) => loaders.metadata.load(name)));

  // Une colonne est une mesure ssi sa metadata existe et is_primary_key === false.
  // Toute autre colonne (coordonnée, ou metadata absente) est une clé.
  const measureColumns = new Set<string>();
  columns.forEach((name, index) => {
    const metadata = metadataResults[index];
    if (metadata && metadata.is_primary_key === false) measureColumns.add(name);
  });

  // Répartition de chaque fait, valeurs nulles comprises de part et d'autre
  return facts.map((fact) => {
    if (!fact || typeof fact !== 'object') {
      // Branche défensive — invariant garanti par le type Fact[]
      return { keys: [], measures: [] } as PartitionedFact;
    }

    const keys: FieldValueEntry[] = [];
    const measures: FieldValueEntry[] = [];

    Object.keys(fact).forEach((name) => {
      if (INTERNAL_FIELDS.includes(name)) return;
      const entry = { name, value: fact[name] };
      if (measureColumns.has(name)) measures.push(entry);
      else keys.push(entry);
    });

    return { ...fact, keys, measures };
  });
}
