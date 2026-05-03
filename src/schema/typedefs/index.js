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


// Initialisation de la requête
const baseTypeDefs = gql`
  type Query {
    _empty: String
  }
`;

// Combinaison de toutes les définitions
const typeDefs = mergeTypeDefs([
  baseTypeDefs,
  commonTypeDefs,
  dimensionTypeDefs,
  factTypeDefs,
  metadataTypeDefs,
  selectTypeDefs,
  catalogTypeDefs,
  crossDatabaseTypeDefs
]);

// Réexportation des éléments d'intérêt
export { typeDefs };