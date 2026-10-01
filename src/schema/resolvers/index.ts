// Importation des modules d'intérêt
import { metadataResolvers } from './metadata.js';
import { factResolvers } from './fact.js';
import { aggregatesResolvers } from './aggregates.js';
import { selectOptionsResolvers } from './select-options.js';
import { fieldResolvers } from './field-resolvers.js';
import { catalogResolvers } from './catalog.js';
import { fieldStatsResolvers } from './field-stats.js';
import { crossDatabaseResolvers } from './cross-database.js';
import { JSONScalar } from '../scalars.js';

// Combinaison des différents resolvers
/**
 * Combined GraphQL resolvers for the entire API.
 *
 * Merges Query resolvers from every sub-module and attaches the field
 * resolvers exposing the key/measure partition of a Fact.
 */
const resolvers = {
  Query: {
    ...metadataResolvers.Query,
    ...factResolvers.Query,
    ...aggregatesResolvers.Query,
    ...selectOptionsResolvers.Query,
    ...catalogResolvers.Query,
    ...fieldStatsResolvers.Query,
    ...crossDatabaseResolvers.Query,
  },
  // Scalaire JSON
  JSON: JSONScalar,
  // Field resolvers : partition clés/mesures de Fact + cascade lazy sur CatalogSchemaInfo
  ...fieldResolvers,
  DatasetWithMetadata: factResolvers.DatasetWithMetadata,
  CatalogSchemaInfo: catalogResolvers.CatalogSchemaInfo,
  // Type Metadata : champ lazy `stats`, typeFamily et filterOperations dérivés de sqlType
  Metadata: { ...fieldStatsResolvers.Metadata, ...metadataResolvers.Metadata },
};

// Ré-exportation de la combinaison
export { resolvers };
