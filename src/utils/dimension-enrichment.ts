// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Détail d'une valeur de dimension catégorielle chargée depuis le loader. */
interface DimensionDetail {
    name: string;
    value: unknown;
    label: unknown;
}

/** Métadonnées d'un champ issues du loader de métadonnées. */
interface FieldMetadata {
    is_categorical?: boolean;
    [key: string]: unknown;
}

/** Requête de chargement d'une valeur de dimension. */
interface DimensionLoadRequest {
    dimensionName: string;
    value: unknown;
}

/** Ensemble des loaders DataLoader disponibles dans le contexte GraphQL. */
interface Loaders {
    metadata: {
        load: (fieldName: string) => Promise<FieldMetadata | null>;
    };
    dimensionValue: {
        load: (request: DimensionLoadRequest) => Promise<DimensionDetail | null>;
    };
}

/** Fait brut — objet dont les clés sont des noms de dimensions ou des valeurs. */
type Fact = Record<string, unknown>;

/** Fait agrégé avec une clé de regroupement et une valeur numérique agrégée. */
export interface AggregatedFact {
    key: unknown;
    value?: unknown;
    keyLabel?: unknown;
    _groupByField?: string;
    [key: string]: unknown;
}

// ─── Fonctions d'enrichissement ──────────────────────────────────────────────

/**
 * Enriches an array of facts with their categorical dimension details.
 *
 * Pre-loads all unique dimension values in bulk to avoid N+1 loader calls,
 * then attaches a `dimensionDetails` array to each fact.
 *
 * Note: An alternative would be to JOIN dimensions in the SQL query itself,
 * which would be more efficient but would reduce GraphQL flexibility.
 *
 * Args:
 *     facts: Array of raw fact objects to enrich.
 *     loaders: GraphQL DataLoader collection.
 *
 * Returns:
 *     Facts enriched with a `dimensionDetails` array on each item.
 */
// Enrichissement en masse des faits avec les détails de leurs dimensions catégorielles
export async function enrichFactsWithDimensions(
    facts: Fact[],
    loaders: Loaders
): Promise<(Fact & { dimensionDetails: (DimensionDetail | Fact)[] })[]> {
    if (!facts || facts.length === 0) {
        return facts as (Fact & { dimensionDetails: (DimensionDetail | Fact)[] })[];
    }

    // Champs exclus de l'enrichissement dimensionnel
    const excludedFields = ['value', '_groupByField'];

    // Collecte des champs de dimension uniques et de leurs valeurs
    const dimensionFieldsSet = new Set<string>();
    const dimensionValuesMap = new Map<string, Set<unknown>>();

    facts.forEach((fact) => {
        if (!fact || typeof fact !== 'object') return;

        Object.keys(fact).forEach((key) => {
            if (!excludedFields.includes(key) && fact[key] !== null) {
                dimensionFieldsSet.add(key);

                if (!dimensionValuesMap.has(key)) {
                    dimensionValuesMap.set(key, new Set());
                }
                dimensionValuesMap.get(key)!.add(fact[key]);
            }
        });
    });

    if (dimensionFieldsSet.size === 0) {
        return facts.map((fact) => ({ ...fact, dimensionDetails: [] }));
    }

    const dimensionFields = Array.from(dimensionFieldsSet);

    // Chargement des métadonnées pour identifier les champs catégoriels
    const metadataResults = await Promise.all(
        dimensionFields.map((fieldName) => loaders.metadata.load(fieldName))
    );

    // Indexation des métadonnées par nom de champ pour un accès en O(1)
    const metadataMap = new Map<string, FieldMetadata | null>();
    dimensionFields.forEach((fieldName, index) => {
        metadataMap.set(fieldName, metadataResults[index]);
    });

    // Construction de la liste des requêtes de chargement pour les dimensions catégorielles
    const dimensionLoadRequests: DimensionLoadRequest[] = [];

    dimensionFields.forEach((fieldName) => {
        const metadata = metadataMap.get(fieldName);
        const values = dimensionValuesMap.get(fieldName);

        if (metadata && metadata.is_categorical && values && values.size > 0) {
            values.forEach((value) => {
                dimensionLoadRequests.push({ dimensionName: fieldName, value });
            });
        }
    });

    // Chargement en masse de tous les détails de dimension
    const dimensionDetailsMap = new Map<string, DimensionDetail | null>();

    if (dimensionLoadRequests.length > 0) {
        const dimensionResults = await Promise.all(
            dimensionLoadRequests.map((request) => loaders.dimensionValue.load(request))
        );

        // Indexation des résultats par clé composite "champ:valeur"
        dimensionLoadRequests.forEach((request, index) => {
            const key = `${request.dimensionName}:${request.value}`;
            dimensionDetailsMap.set(key, dimensionResults[index]);
        });
    }

    // Enrichissement de chaque fait avec ses détails dimensionnels
    return facts.map((fact) => {
        if (!fact || typeof fact !== 'object') {
            return { ...fact, dimensionDetails: [] };
        }

        const factDimensionFields = Object.keys(fact).filter(
            (key) => !excludedFields.includes(key) && fact[key] !== null
        );

        if (factDimensionFields.length === 0) {
            return { ...fact, dimensionDetails: [] };
        }

        const dimensionDetails = factDimensionFields.map((fieldName) => {
            const value = fact[fieldName];
            const metadata = metadataMap.get(fieldName);

            if (metadata && metadata.is_categorical) {
                const key = `${fieldName}:${value}`;
                const dimensionDetail = dimensionDetailsMap.get(key);

                if (dimensionDetail) {
                    return dimensionDetail;
                }
            }

            // Valeur brute pour les champs non catégoriels ou introuvables
            return { name: fieldName, value, label: value };
        });

        return { ...fact, dimensionDetails };
    });
}

/**
 * Enriches aggregated facts with human-readable labels for their group-by key.
 *
 * Loads labels in bulk and attaches `keyLabel` to each aggregated fact.
 *
 * Args:
 *     aggregatedFacts: Array of aggregated fact objects.
 *     groupByField: The field used for grouping (determines label source).
 *     loaders: GraphQL DataLoader collection.
 *
 * Returns:
 *     Aggregated facts enriched with `keyLabel` and `_groupByField`.
 */
// Enrichissement des faits agrégés avec les labels de la dimension de regroupement
export async function enrichAggregatedFactsWithLabels(
    aggregatedFacts: AggregatedFact[],
    groupByField: string,
    loaders: Loaders
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
            _groupByField: groupByField
        }));
    }

    // Collecte des valeurs de clé uniques pour le chargement en masse
    const uniqueKeys = [...new Set(aggregatedFacts.map((fact) => fact.key))];

    // Chargement en masse des labels de dimension
    const labelResults = await Promise.all(
        uniqueKeys.map((key) =>
            loaders.dimensionValue.load({ dimensionName: groupByField, value: key })
        )
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
        _groupByField: groupByField
    }));
}
