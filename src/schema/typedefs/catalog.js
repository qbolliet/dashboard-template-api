import { gql } from 'graphql-tag';

const catalogTypeDefs = gql`
    "Informations sur un catalogue DuckLake disponible"
    type DatabaseInfo {
        "Identifiant du catalogue"
        id: String!
        "Liste de tous les champs et leurs métadonnées"
        fields: [Metadata!]!
        "Noms des dimensions catégorielles disponibles"
        dimensionNames: [String!]!
    }

    extend type Query {
        "Liste tous les catalogues disponibles avec leurs champs et dimensions"
        getDatabases: [DatabaseInfo!]!

        "Retourne tous les champs (métadonnées) d'un catalogue"
        getDatabaseSchema(database: String): [Metadata!]!

        "Retourne les dimensions communes à plusieurs catalogues (utile pour les requêtes cross-database)"
        getSharedDimensions(databases: [String!]!): [String!]!
    }
`;

export { catalogTypeDefs };
