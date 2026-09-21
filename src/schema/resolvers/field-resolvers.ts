// Importation des modules
import type { FieldValueEntry } from '../../utils/fact-partition.js';

// ─── Interfaces des objets parent ─────────────────────────────────────────────

/** Fact object that serves as the parent for the Fact field resolvers. */
export interface FactParent extends Record<string, unknown> {
  keys?: FieldValueEntry[];
  measures?: FieldValueEntry[];
}

// Exposition de la partition pré-calculée d'une ligne de faits
/**
 * Field resolvers for fact records.
 *
 * The fact table stores labels directly, so a row needs no lookup: its columns
 * are split once, in bulk, by partitionFacts (driven by metadata.isPrimaryKey)
 * and these resolvers only expose the result.
 */
const fieldResolvers = {
  Fact: {
    /**
     * Resolves the coordinates of a fact record.
     *
     * Returns the pre-computed `keys` array attached by the bulk partition.
     * Falls back to an empty array when the partition did not run (it always
     * does on the standard fact query paths).
     *
     * @param parent - The fact record, already partitioned.
     * @returns Array of key columns with name and type-preserved value.
     */
    // Résolution des coordonnées d'une ligne de fait
    keys: (parent: FactParent): FieldValueEntry[] => {
      return parent && Array.isArray(parent.keys) ? parent.keys : [];
    },

    /**
     * Resolves the measures of a fact record.
     *
     * Returns the pre-computed `measures` array attached by the bulk partition.
     *
     * @param parent - The fact record, already partitioned.
     * @returns Array of measures with name and type-preserved value.
     */
    // Résolution des mesures d'une ligne de fait
    measures: (parent: FactParent): FieldValueEntry[] => {
      return parent && Array.isArray(parent.measures) ? parent.measures : [];
    },
  },
};

export { fieldResolvers };
