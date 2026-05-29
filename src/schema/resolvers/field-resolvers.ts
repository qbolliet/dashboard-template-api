// Importation des modules
import type { GraphQLContext } from './types.js';
import type { MeasureEntry } from '../../utils/dimension-enrichment.js';

// ─── Interfaces des objets parent ─────────────────────────────────────────────

/** Detail of a dimension resolved on a fact record. */
interface DimensionDetail {
  name: string;
  value: unknown;
  label: unknown;
}

/** Fact object that serves as the parent for the Fact field resolvers. */
export interface FactParent extends Record<string, unknown> {
  dimensionDetails?: DimensionDetail[];
  measures?: MeasureEntry[];
}

/** Aggregated fact object that serves as the parent for AggregatedFact field resolvers. */
interface AggregatedFactParent {
  key: unknown;
  keyLabel?: unknown;
  _groupByField?: string;
  [key: string]: unknown;
}

/** Aggregated fact enriched with a guaranteed groupBy field. */
interface AggregatedFactWithGroupBy extends AggregatedFactParent {
  _groupByField: string;
}

// Construction d'un resolver pour associer un label à une dimension
/**
 * Field resolvers for resolving dimension labels in fact data.
 *
 * These resolvers are called for each fact record to resolve dimension
 * details. Pre-loading via bulk enrichment is preferred to avoid N+1 calls.
 */
const fieldResolvers = {
  Fact: {
    /**
     * Resolves the measures of a fact record.
     *
     * Returns the pre-loaded `measures` array attached by bulk enrichment.
     * Falls back to an empty array when enrichment did not run (it always
     * does on the standard fact query paths).
     *
     * @param parent - The fact record, potentially already enriched.
     * @returns Array of measures with name and type-preserved value.
     */
    // Résolution des mesures d'une ligne de fait
    measures: (parent: FactParent): MeasureEntry[] => {
      return parent && Array.isArray(parent.measures) ? parent.measures : [];
    },

    /**
     * Resolves dimension details including labels for a fact record.
     *
     * Returns pre-loaded dimension details when bulk enrichment has
     * already occurred, otherwise falls back to raw field values.
     *
     * @param parent - The fact record, potentially already enriched.
     * @param _args - Field arguments (none used).
     * @param context - GraphQL context with loaders.
     * @returns Array of dimension details with name, value and label.
     */
    // Résolution des détails des dimensions pour inclure un label dans la table des faits
    dimensionDetails: async (
      parent: FactParent,
      _args: Record<string, never>,
      { loaders: _loaders }: GraphQLContext,
    ): Promise<DimensionDetail[]> => {
      // Retour des dimensionDetails pré-chargées si disponibles
      if (parent && parent.dimensionDetails) {
        return parent.dimensionDetails;
      }

      // Fallback pour les cas où l'enrichissement n'a pas eu lieu
      // (ne devrait normalement pas arriver avec la nouvelle implémentation)
      if (!parent || typeof parent !== 'object') {
        return [];
      }

      // Extraction de tous les champs qui pourraient être des dimensions
      const excludedFields = ['_groupByField', 'dimensionDetails', 'measures'];
      const dimensionFields = Object.keys(parent).filter(
        (key) => !excludedFields.includes(key) && parent[key] !== null,
      );

      if (dimensionFields.length === 0) {
        return [];
      }

      // Fallback: génération des détails sans chargement de base de données
      // Pour éviter les requêtes N+1 en cas de problème avec l'enrichissement
      return dimensionFields.map((fieldName) => ({
        name: fieldName,
        value: parent[fieldName],
        label: parent[fieldName], // Utilisation de la valeur brute comme label
      }));
    },
  },

  AggregatedFact: {
    /**
     * Resolves the human-readable label for an aggregated fact key.
     *
     * Returns the pre-loaded keyLabel when bulk enrichment has already
     * occurred. Falls back to a single loader call when the groupBy field
     * is categorical and the label has not been pre-loaded.
     *
     * @param parent - The aggregated fact record.
     * @param _args - Field arguments (none used).
     * @param context - GraphQL context with loaders.
     * @returns Label string for the key, or the raw key value as fallback.
     */
    // Résolution du label pour les clés de faits agrégés
    keyLabel: async (
      parent: AggregatedFactParent,
      _args: Record<string, never>,
      { loaders }: GraphQLContext,
    ): Promise<unknown> => {
      // Retour de la valeur pré-chargée si l'enrichissement bulk a déjà eu lieu
      if (parent.keyLabel !== undefined) {
        return parent.keyLabel;
      }

      // Absence du champ de regroupement — utilisation directe de la clé
      if (!parent._groupByField) {
        return parent.key;
      }

      // Vérification si le champ de regroupement est catégoriel
      const metadata = await loaders.metadata.load(parent._groupByField);

      if (metadata && metadata.is_categorical) {
        const dimensionData = await loaders.dimensionValue.load({
          dimensionName: parent._groupByField,
          value: parent.key,
        });
        return dimensionData?.label;
      }

      return parent.key;
    },
  },
};

// Fonction auxiliaire pour associer des labels aux variables sur lesquelles agréger
/**
 * Enriches aggregated facts with groupBy field information.
 *
 * Attaches the groupBy field name to each result so that field resolvers
 * can resolve labels without requiring a separate argument.
 *
 * @param results - Raw aggregated results from the loader.
 * @param groupByField - Field used for grouping.
 * @returns Enriched results with _groupByField set on every item.
 */
const enrichAggregatedFacts = (
  results: AggregatedFactParent[],
  groupByField: string,
): AggregatedFactWithGroupBy[] => {
  return results.map((result) => ({
    ...result,
    _groupByField: groupByField,
  }));
};

export { fieldResolvers, enrichAggregatedFacts };
export type { AggregatedFactParent, AggregatedFactWithGroupBy, DimensionDetail };
