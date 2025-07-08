// Tests unitaires pour l'API GraphQL avec Jest
// Imortation des modules
import { ApolloServer } from 'apollo-server-express';
import { schema } from '../src/schema/index.js';
import { createLoaders } from '../src/loaders/index.js';
import { setupTestData } from './setup-test-data.js';
import { closeConnections } from '../src/db/index.js';
import { redis } from '../src/cache/index.js';
import { v4 as uuidv4 } from 'uuid';

// Créer un serveur de test
const createTestServer = () => {
  return new ApolloServer({
    schema,
    context: () => ({
      requestId: uuidv4(),
      loaders: createLoaders()
    })
  });
};

// Configuration globale
let server;

beforeAll(async () => {
  // Configurer les données de test
  await setupTestData();
  // Créer le serveur
  server = createTestServer();
});

afterAll(async () => {
  // Nettoyer les connexions
  await closeConnections();
  await redis.quit();
});

describe('API GraphQL DuckDB Tests', () => {
  
  // ============================================
  // 1. TESTS DES MÉTADONNÉES
  // ============================================
  
  describe('Metadata Queries', () => {
    test('devrait récupérer les métadonnées d\'un champ catégoriel', async () => {
      const query = `
        query {
          getMetaData(name: "country") {
            name
            label
            python_type
            sql_type
            is_categorical
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getMetaData).toBeDefined();
      expect(result.data.getMetaData.name).toBe('country');
      expect(result.data.getMetaData.is_categorical).toBe(true);
    });

    test('devrait récupérer les métadonnées d\'un champ numérique', async () => {
      const query = `
        query {
          getMetaData(name: "value") {
            name
            label
            is_categorical
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getMetaData).toBeDefined();
      expect(result.data.getMetaData.is_categorical).toBe(false);
    });

    test('devrait retourner null pour un champ inexistant', async () => {
      const query = `
        query {
          getMetaData(name: "inexistant") {
            name
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getMetaData).toBeNull();
    });
  });

  // ============================================
  // 2. TESTS DES DIMENSIONS
  // ============================================
  
  describe('Dimension Queries', () => {
    test('devrait récupérer une table de dimension', async () => {
      const query = `
        query {
          getDimensionTable(name: "country") {
            value
            label
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getDimensionTable).toBeDefined();
      expect(Array.isArray(result.data.getDimensionTable)).toBe(true);
      expect(result.data.getDimensionTable.length).toBeGreaterThan(0);
      expect(result.data.getDimensionTable[0]).toHaveProperty('value');
      expect(result.data.getDimensionTable[0]).toHaveProperty('label');
    });

    test('devrait retourner un tableau vide pour une dimension inexistante', async () => {
      const query = `
        query {
          getDimensionTable(name: "inexistant") {
            value
            label
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getDimensionTable).toEqual([]);
    });
  });

  // ============================================
  // 3. TESTS DE LA TABLE DES FAITS
  // ============================================
  
  describe('Fact Table Queries', () => {
    test('devrait récupérer des faits avec pagination', async () => {
      const query = `
        query {
          getFactTable(limit: 10, offset: 0) {
            data {
              value
            }
            total
            hasNextPage
            currentPage
            totalPages
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getFactTable).toBeDefined();
      expect(result.data.getFactTable.data).toBeDefined();
      expect(Array.isArray(result.data.getFactTable.data)).toBe(true);
      expect(result.data.getFactTable.total).toBeGreaterThan(0);
      expect(result.data.getFactTable.currentPage).toBe(1);
    });

    test('devrait appliquer des filtres structurés', async () => {
      const query = `
        query {
          getFactTable(
            structuredFilters: [
              { key: "country", operator: "=", value: "1" }
            ]
            limit: 10
            offset: 0
          ) {
            data {
              value
            }
            total
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getFactTable).toBeDefined();
      expect(result.data.getFactTable.data).toBeDefined();
    });

    test('devrait trier les résultats', async () => {
      const query = `
        query {
          getFactTable(
            sort: [{ field: "value", order: DESC }]
            limit: 5
            offset: 0
          ) {
            data {
              value
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      const values = result.data.getFactTable.data.map(d => d.value);
      
      // Vérifier que les valeurs sont triées en ordre décroissant
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
      }
    });

    test('devrait récupérer les détails des dimensions', async () => {
      const query = `
        query {
          getFactTable(limit: 2, offset: 0) {
            data {
              value
              dimensionDetails {
                name
                value
                label
              }
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getFactTable.data[0].dimensionDetails).toBeDefined();
      expect(Array.isArray(result.data.getFactTable.data[0].dimensionDetails)).toBe(true);
      
      // Vérifier que les dimensions catégorielles ont des labels
      const countryDetail = result.data.getFactTable.data[0].dimensionDetails
        .find(d => d.name === 'country');
      expect(countryDetail).toBeDefined();
      expect(countryDetail.label).toBeDefined();
    });

    test('devrait rejeter une limite excessive', async () => {
      const query = `
        query {
          getFactTable(limit: 1001, offset: 0) {
            data {
              value
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Limit cannot exceed 1000');
    });
  });

  // ============================================
  // 4. TESTS DES FAITS AVEC MÉTADONNÉES
  // ============================================
  
  describe('Fact Table with Metadata', () => {
    test('devrait récupérer les faits avec métadonnées D3', async () => {
      const query = `
        query {
          getFactTableWithMetadata(limit: 50, offset: 0) {
            columns
            data
            metadata {
              count
              extents
              total
              hasNextPage
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getFactTableWithMetadata).toBeDefined();
      expect(result.data.getFactTableWithMetadata.columns).toBeDefined();
      expect(Array.isArray(result.data.getFactTableWithMetadata.columns)).toBe(true);
      expect(result.data.getFactTableWithMetadata.data).toBeDefined();
      expect(result.data.getFactTableWithMetadata.metadata).toBeDefined();
      expect(result.data.getFactTableWithMetadata.metadata.extents).toBeDefined();
    });
  });

  // ============================================
  // 5. TESTS DES AGRÉGATIONS
  // ============================================
  
  describe('Aggregated Facts Queries', () => {
    test('devrait agréger avec SUM', async () => {
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "country"
            aggregation: SUM
            limit: 10
            offset: 0
          ) {
            key
            aggregatedValue
            count
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getAggregatedFacts).toBeDefined();
      expect(Array.isArray(result.data.getAggregatedFacts)).toBe(true);
      expect(result.data.getAggregatedFacts[0]).toHaveProperty('key');
      expect(result.data.getAggregatedFacts[0]).toHaveProperty('aggregatedValue');
      expect(result.data.getAggregatedFacts[0]).toHaveProperty('count');
    });

    test('devrait supporter différentes fonctions d\'agrégation', async () => {
      const aggregations = ['SUM', 'AVG', 'MAX', 'MIN', 'COUNT'];
      
      for (const agg of aggregations) {
        const query = `
          query {
            getAggregatedFacts(
              groupBy: "indicator"
              aggregation: ${agg}
              limit: 5
              offset: 0
            ) {
              aggregatedValue
            }
          }
        `;

        const result = await server.executeOperation({ query });
        expect(result.errors).toBeUndefined();
        expect(result.data.getAggregatedFacts).toBeDefined();
      }
    });

    test('devrait récupérer les labels des clés agrégées', async () => {
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "country"
            aggregation: SUM
            limit: 3
            offset: 0
          ) {
            key
            keyLabel
            aggregatedValue
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getAggregatedFacts[0].keyLabel).toBeDefined();
      expect(result.data.getAggregatedFacts[0].keyLabel).not.toBe(
        result.data.getAggregatedFacts[0].key
      );
    });

    test('devrait rejeter une agrégation sans groupBy', async () => {
      const query = `
        query {
          getAggregatedFacts(
            aggregation: SUM
            limit: 10
            offset: 0
          ) {
            aggregatedValue
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeDefined();
    });
  });

  // ============================================
  // 6. TESTS DES AGRÉGATIONS AVEC MÉTADONNÉES
  // ============================================
  
  describe('Aggregated Facts with Metadata', () => {
    test('devrait récupérer les agrégations avec métadonnées complètes', async () => {
      const query = `
        query {
          getAggregatedFactsWithMetadata(
            groupBy: "indicator"
            aggregation: AVG
            limit: 10
            offset: 0
          ) {
            data {
              key
              keyLabel
              aggregatedValue
              count
            }
            metadata {
              count
              keyExtent
              valueExtent
              statistics {
                mean
                median
                stdDev
                quartiles
              }
              groupByFieldInfo {
                name
                label
                is_categorical
              }
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getAggregatedFactsWithMetadata).toBeDefined();
      expect(result.data.getAggregatedFactsWithMetadata.data).toBeDefined();
      expect(result.data.getAggregatedFactsWithMetadata.metadata).toBeDefined();
      expect(result.data.getAggregatedFactsWithMetadata.metadata.statistics).toBeDefined();
      expect(result.data.getAggregatedFactsWithMetadata.metadata.statistics.mean).toBeDefined();
      expect(result.data.getAggregatedFactsWithMetadata.metadata.groupByFieldInfo).toBeDefined();
    });
  });

  // ============================================
  // 7. TESTS DES OPTIONS DE SÉLECTION
  // ============================================
  
  describe('Select Options Queries', () => {
    test('devrait récupérer les options pour un champ catégoriel', async () => {
      const query = `
        query {
          getSelectOptions(fieldName: "country", limit: 10) {
            value
            label
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getSelectOptions).toBeDefined();
      expect(Array.isArray(result.data.getSelectOptions)).toBe(true);
      expect(result.data.getSelectOptions[0]).toHaveProperty('value');
      expect(result.data.getSelectOptions[0]).toHaveProperty('label');
    });

    test('devrait filtrer les options avec searchTerm', async () => {
      const query = `
        query {
          getSelectOptions(
            fieldName: "country"
            searchTerm: "Fra"
            limit: 5
          ) {
            value
            label
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getSelectOptions).toBeDefined();
      // Vérifier que les résultats contiennent "Fra"
      if (result.data.getSelectOptions.length > 0) {
        expect(result.data.getSelectOptions[0].label.toLowerCase())
          .toContain('fra');
      }
    });

    test('devrait récupérer les options groupées', async () => {
      const query = `
        query {
          getGroupedSelectOptions(
            groupField: "country"
            optionsField: "indicator"
            limit: 10
          ) {
            group {
              value
              label
            }
            options {
              value
              label
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getGroupedSelectOptions).toBeDefined();
      expect(result.data.getGroupedSelectOptions.group).toBeDefined();
      expect(result.data.getGroupedSelectOptions.options).toBeDefined();
    });
  });

  // ============================================
  // 8. TESTS DE PERFORMANCE ET LIMITES
  // ============================================
  
  describe('Performance and Limits', () => {
    test('devrait gérer des requêtes volumineuses', async () => {
      const query = `
        query {
          getFactTable(limit: 1000, offset: 0) {
            data {
              value
            }
            total
          }
        }
      `;

      const startTime = Date.now();
      const result = await server.executeOperation({ query });
      const duration = Date.now() - startTime;
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getFactTable.data.length).toBeLessThanOrEqual(1000);
      
      // La requête devrait s'exécuter en moins de 5 secondes
      expect(duration).toBeLessThan(5000);
    });

    test('devrait respecter le timeout', async () => {
      // Cette requête devrait timeout si elle prend trop de temps
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "date"
            aggregation: AVG
            limit: 1000
            offset: 0
          ) {
            key
            aggregatedValue
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      // Le test devrait passer sans timeout
      expect(result.errors).toBeUndefined();
    });
  });

  // ============================================
  // 9. TESTS DE CACHE
  // ============================================
  
  describe('Caching Behavior', () => {
    test('devrait utiliser le cache pour les requêtes répétées', async () => {
      const query = `
        query {
          getMetaData(name: "country") {
            name
            label
          }
        }
      `;

      // Première requête
      const startTime1 = Date.now();
      const result1 = await server.executeOperation({ query });
      const duration1 = Date.now() - startTime1;
      
      // Deuxième requête (devrait être plus rapide grâce au cache)
      const startTime2 = Date.now();
      const result2 = await server.executeOperation({ query });
      const duration2 = Date.now() - startTime2;
      
      expect(result1.data).toEqual(result2.data);
      // La deuxième requête devrait être significativement plus rapide
      expect(duration2).toBeLessThan(duration1 * 0.5);
    });
  });

  // ============================================
  // 10. TESTS D'ERREURS ET VALIDATION
  // ============================================
  
  describe('Error Handling', () => {
    test('devrait valider les types d\'agrégation', async () => {
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "country"
            aggregation: INVALID_AGG
            limit: 10
            offset: 0
          ) {
            aggregatedValue
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeDefined();
    });

    test('devrait valider l\'ordre de tri', async () => {
      const query = `
        query {
          getFactTable(
            sort: [{ field: "value", order: INVALID }]
            limit: 10
            offset: 0
          ) {
            data {
              value
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeDefined();
    });
  });
});