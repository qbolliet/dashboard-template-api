import { gql } from 'graphql-tag';

const crossDatabaseTypeDefs = gql`
    "Comparaison d'une valeur entre deux catalogues sur une clé commune"
    type ComparedFact {
        "Valeur de la clé commune (dimension de jointure)"
        key: String!
        "Label lisible de la clé (si dimension catégorielle)"
        keyLabel: String
        "Valeur dans le catalogue A"
        valueA: Float
        "Valeur dans le catalogue B"
        valueB: Float
        "Différence absolue (valueB - valueA)"
        delta: Float
        "Différence relative en % ((valueB - valueA) / valueA * 100)"
        deltaPercent: Float
    }

    extend type Query {
        "Compare les faits de deux catalogues sur des champs de jointure communs"
        compareFacts(
            "Premier catalogue (référence)"
            databaseA: String!
            "Second catalogue (comparaison)"
            databaseB: String!
            "Champs utilisés pour la jointure (doivent exister dans les deux catalogues)"
            joinFields: [String!]!
            limit: Int! = 100
            offset: Int! = 0
            sort: [SortInput!]
        ): [ComparedFact!]!

        "Compare les faits agrégés de deux catalogues sur un groupBy commun"
        compareAggregatedFacts(
            databaseA: String!
            databaseB: String!
            "Champ de regroupement commun aux deux catalogues"
            groupBy: String!
            aggregation: Aggregation! = SUM
            limit: Int! = 100
            offset: Int! = 0
        ): [ComparedFact!]!

        "Retourne les options de sélection communes à plusieurs catalogues"
        crossDatabaseSelectOptions(
            "Nom du champ à intersecter"
            fieldName: String!
            "Liste des catalogues à croiser (minimum 2)"
            databases: [String!]!
            limit: Int! = 50
        ): [SelectOption!]!
    }
`;

export { crossDatabaseTypeDefs };
