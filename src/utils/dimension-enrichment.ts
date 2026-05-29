// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Detail of a categorical dimension value loaded from the dimension loader. */
export interface DimensionDetail {
  name: string;
  value: unknown;
  label: unknown;
}

/** Field metadata returned by the metadata loader. */
export interface FieldMetadata {
  is_categorical?: boolean;
  is_primary_key?: boolean;
  [key: string]: unknown;
}

/** A single measure of a fact row (name + value with its original type preserved). */
export interface MeasureEntry {
  name: string;
  value: unknown;
}

/** Load request for a single dimension value. */
export interface DimensionLoadRequest {
  dimensionName: string;
  value: unknown;
}

/** Set of DataLoader instances available in the GraphQL context. */
export interface Loaders {
  metadata: {
    load: (fieldName: string) => Promise<FieldMetadata | null>;
  };
  dimensionValue: {
    load: (request: DimensionLoadRequest) => Promise<DimensionDetail | null>;
  };
}

/** Raw fact — an object whose keys are dimension names or measure values. */
export type Fact = Record<string, unknown>;

/** Aggregated fact with a group-by key and an aggregated numeric value. */
export interface AggregatedFact {
  key: unknown;
  value?: unknown;
  keyLabel?: unknown;
  _groupByField?: string;
  [key: string]: unknown;
}

// ─── Fonctions d'enrichissement ──────────────────────────────────────────────

/** Result of enrichment: a fact carrying its measures and dimension details. */
type EnrichedFact = Fact & {
  dimensionDetails: (DimensionDetail | Fact)[];
  measures: MeasureEntry[];
};

/**
 * Enriches an array of facts by splitting their columns into measures and
 * categorical dimension details.
 *
 * Each column is classified via its metadata: a column with
 * `is_primary_key === false` is a measure (its raw, type-preserved value is
 * pushed to `measures`); every other column (primary-key / coordinate, or one
 * without a metadata row) is treated as a dimension detail. Categorical
 * dimension values are resolved to labels in bulk to avoid N+1 loader calls.
 *
 * Note: An alternative would be to JOIN dimensions in the SQL query itself,
 * which would be more efficient but would reduce GraphQL flexibility.
 *
 * @param facts - Array of raw fact objects to enrich.
 * @param loaders - GraphQL DataLoader collection.
 * @returns Facts enriched with `measures` and `dimensionDetails` arrays.
 */
// Enrichissement en masse : partition des colonnes en mesures / dimensions
export async function enrichFactsWithDimensions(
  facts: Fact[],
  loaders: Loaders,
): Promise<EnrichedFact[]> {
  if (!facts || facts.length === 0) {
    return facts as EnrichedFact[];
  }

  // Champs internes ajoutés par l'API, jamais des colonnes de la base
  const internalFields = ['_groupByField', 'dimensionDetails', 'measures'];

  // Collecte de toutes les colonnes présentes (pour charger leur metadata)
  const columnSet = new Set<string>();
  facts.forEach((fact) => {
    if (!fact || typeof fact !== 'object') return;
    Object.keys(fact).forEach((key) => {
      if (!internalFields.includes(key)) columnSet.add(key);
    });
  });

  if (columnSet.size === 0) {
    return facts.map((fact) => ({ ...fact, dimensionDetails: [], measures: [] }));
  }

  const columns = Array.from(columnSet);

  // Chargement des métadonnées de chaque colonne pour la classification
  const metadataResults = await Promise.all(columns.map((name) => loaders.metadata.load(name)));

  // Indexation des métadonnées par nom de colonne pour un accès en O(1)
  const metadataMap = new Map<string, FieldMetadata | null>();
  columns.forEach((name, index) => {
    metadataMap.set(name, metadataResults[index]);
  });

  // Une colonne est une mesure ssi sa metadata existe et is_primary_key === false.
  // Toute autre colonne (clé/coordonnée, ou metadata absente) → dimensionDetails.
  const isMeasure = (name: string): boolean => {
    const meta = metadataMap.get(name);
    return !!meta && meta.is_primary_key === false;
  };

  // Construction des requêtes de labels pour les colonnes-clés catégorielles (valeurs non nulles)
  const dimensionLoadRequests: DimensionLoadRequest[] = [];
  const requestedKeys = new Set<string>();

  facts.forEach((fact) => {
    if (!fact || typeof fact !== 'object') return;
    Object.keys(fact).forEach((name) => {
      if (internalFields.includes(name) || isMeasure(name)) return;
      const metadata = metadataMap.get(name);
      const value = fact[name];
      if (metadata && metadata.is_categorical && value !== null && value !== undefined) {
        const key = `${name}:${value}`;
        if (!requestedKeys.has(key)) {
          requestedKeys.add(key);
          dimensionLoadRequests.push({ dimensionName: name, value });
        }
      }
    });
  });

  // Chargement en masse de tous les détails de dimension
  const dimensionDetailsMap = new Map<string, DimensionDetail | null>();

  if (dimensionLoadRequests.length > 0) {
    const dimensionResults = await Promise.all(
      dimensionLoadRequests.map((request) => loaders.dimensionValue.load(request)),
    );

    // Indexation des résultats par clé composite "champ:valeur"
    dimensionLoadRequests.forEach((request, index) => {
      const key = `${request.dimensionName}:${request.value}`;
      dimensionDetailsMap.set(key, dimensionResults[index]);
    });
  }

  // Enrichissement de chaque fait : séparation mesures / dimensions
  return facts.map((fact) => {
    if (!fact || typeof fact !== 'object') {
      // Branche défensive — invariant garanti par le type Fact[]
      return { dimensionDetails: [], measures: [] } as EnrichedFact;
    }

    const dimensionDetails: (DimensionDetail | Fact)[] = [];
    const measures: MeasureEntry[] = [];

    Object.keys(fact).forEach((name) => {
      if (internalFields.includes(name)) return;

      // Colonne mesure → valeur brute (type préservé), incluse même si null
      if (isMeasure(name)) {
        measures.push({ name, value: fact[name] });
        return;
      }

      // Colonne-clé / dimension — les valeurs nulles sont ignorées
      const value = fact[name];
      if (value === null || value === undefined) return;

      const metadata = metadataMap.get(name);
      if (metadata && metadata.is_categorical) {
        const dimensionDetail = dimensionDetailsMap.get(`${name}:${value}`);
        if (dimensionDetail) {
          dimensionDetails.push(dimensionDetail);
          return;
        }
      }

      // Valeur brute pour les champs non catégoriels ou introuvables
      dimensionDetails.push({ name, value, label: value });
    });

    return { ...fact, dimensionDetails, measures };
  });
}

/**
 * Enriches aggregated facts with human-readable labels for their group-by key.
 *
 * Loads labels in bulk and attaches `keyLabel` to each aggregated fact.
 *
 * @param aggregatedFacts - Array of aggregated fact objects.
 * @param groupByField - The field used for grouping (determines label source).
 * @param loaders - GraphQL DataLoader collection.
 * @returns Aggregated facts enriched with `keyLabel` and `_groupByField`.
 */
// Enrichissement des faits agrégés avec les labels de la dimension de regroupement
export async function enrichAggregatedFactsWithLabels(
  aggregatedFacts: AggregatedFact[],
  groupByField: string,
  loaders: Loaders,
): Promise<(AggregatedFact & { keyLabel: unknown; _groupByField: string })[]> {
  if (!aggregatedFacts || aggregatedFacts.length === 0 || !groupByField) {
    return aggregatedFacts as (AggregatedFact & { keyLabel: unknown; _groupByField: string })[];
  }

  // Vérification si le champ de regroupement est catégoriel
  const metadata = await loaders.metadata.load(groupByField);

  if (!metadata || !metadata.is_categorical) {
    // Pas catégoriel — utilisation directe de la clé comme label
    return aggregatedFacts.map((fact) => ({
      ...fact,
      keyLabel: fact.key,
      _groupByField: groupByField,
    }));
  }

  // Collecte des valeurs de clé uniques pour le chargement en masse
  const uniqueKeys = [...new Set(aggregatedFacts.map((fact) => fact.key))];

  // Chargement en masse des labels de dimension
  const labelResults = await Promise.all(
    uniqueKeys.map((key) =>
      loaders.dimensionValue.load({ dimensionName: groupByField, value: key }),
    ),
  );

  // Indexation des labels par clé pour un accès en O(1)
  const labelMap = new Map<unknown, unknown>();
  uniqueKeys.forEach((key, index) => {
    labelMap.set(key, labelResults[index]?.label ?? key);
  });

  // Enrichissement des faits agrégés avec leurs labels
  return aggregatedFacts.map((fact) => ({
    ...fact,
    keyLabel: labelMap.get(fact.key),
    _groupByField: groupByField,
  }));
}
