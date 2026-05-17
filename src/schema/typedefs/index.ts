// Importation des éléments du dossier
import { gql } from 'graphql-tag';
import { mergeTypeDefs } from '@graphql-tools/merge';
import { commonTypeDefs } from './common.js';
import { dimensionTypeDefs } from './dimension.js';
import { factTypeDefs } from './fact.js';
import { metadataTypeDefs } from './metadata.js';
import { selectTypeDefs } from './select.js';
import { catalogTypeDefs } from './catalog.js';
import { crossDatabaseTypeDefs } from './cross-database.js';
import type { DocumentNode } from 'graphql';

// ─── Définition de la requête de base ────────────────────────────────────────

/**
 * Root Query type required by Apollo Server before any extension.
 *
 * Declares a placeholder _empty field so that each sub-module can use
 * "extend type Query" without defining a root Query themselves (except
 * dimensionTypeDefs, which owns the root declaration).
 */
const baseTypeDefs: DocumentNode = gql`
  type Query {
    _empty: String
  }
`;

// Combinaison de toutes les définitions de types en un seul DocumentNode
/**
 * Merged GraphQL type definitions for the entire API schema.
 *
 * Combines base, common, dimension, fact, metadata, select, catalog,
 * and cross-database type definitions into a single DocumentNode passed
 * to Apollo Server.
 */
const typeDefs: DocumentNode = mergeTypeDefs([
  baseTypeDefs,
  commonTypeDefs,
  dimensionTypeDefs,
  factTypeDefs,
  metadataTypeDefs,
  selectTypeDefs,
  catalogTypeDefs,
  crossDatabaseTypeDefs,
]);

// Réexportation du schéma fusionné
export { typeDefs };
