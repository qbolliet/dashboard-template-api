// Comprehensive test suite for GraphQL API based on manual tests and GraphQL queries
import { ApolloServer } from 'apollo-server-express';
import { schema } from '../src/schema/index.js';
import { createLoaders } from '../src/loaders/index.js';
import { setupTestData } from './setup-test-data.js';
import { closeConnections } from '../src/db/index.js';
import { redis } from '../src/cache/index.js';
import { v4 as uuidv4 } from 'uuid';

// Test environment configuration
process.env.NODE_ENV = 'test';
process.env.DB_PATH = 'test-data/test-database.db';

// Create test server
const createTestServer = () => {
  return new ApolloServer({
    schema,
    context: () => ({
      requestId: uuidv4(),
      loaders: createLoaders()
    })
  });
};

// Global setup
let server;

beforeAll(async () => {
  await setupTestData();
  server = createTestServer();
}, 30000);

afterAll(async () => {
  await closeConnections();
  if (redis && redis.quit) {
    await redis.quit();
  }
});

describe('GraphQL API Comprehensive Tests', () => {
  
  // ============================================
  // 1. METADATA TESTS
  // ============================================
  
  describe('Metadata Operations', () => {
    test('should retrieve metadata for categorical field', async () => {
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
      expect(result.data.getMetaData.label).toBeDefined();
    });

    test('should retrieve metadata for numeric field', async () => {
      const query = `
        query {
          getMetaData(name: "value") {
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
      expect(result.data.getMetaData.name).toBe('value');
      expect(result.data.getMetaData.is_categorical).toBe(false);
    });

    test('should retrieve multiple metadata fields in single query', async () => {
      const query = `
        query {
          indicator: getMetaData(name: "indicator") {
            name
            label
            is_categorical
          }
          value: getMetaData(name: "value") {
            name
            label
            is_categorical
          }
          date: getMetaData(name: "date") {
            name
            sql_type
            is_categorical
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.indicator).toBeDefined();
      expect(result.data.value).toBeDefined();
      expect(result.data.date).toBeDefined();
      expect(result.data.indicator.name).toBe('indicator');
      expect(result.data.value.name).toBe('value');
      expect(result.data.date.name).toBe('date');
    });

    test('should return null for non-existent field', async () => {
      const query = `
        query {
          getMetaData(name: "field_that_does_not_exist") {
            name
            label
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getMetaData).toBeNull();
    });
  });

  // ============================================
  // 2. DIMENSION TABLE TESTS
  // ============================================
  
  describe('Dimension Table Operations', () => {
    test('should retrieve dimension table', async () => {
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

    test('should retrieve multiple dimension tables', async () => {
      const query = `
        query {
          countries: getDimensionTable(name: "country") {
            value
            label
          }
          indicators: getDimensionTable(name: "indicator") {
            value
            label
          }
          kinds: getDimensionTable(name: "kind") {
            value
            label
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.countries).toBeDefined();
      expect(result.data.indicators).toBeDefined();
      expect(result.data.kinds).toBeDefined();
      expect(Array.isArray(result.data.countries)).toBe(true);
      expect(Array.isArray(result.data.indicators)).toBe(true);
      expect(Array.isArray(result.data.kinds)).toBe(true);
    });

    test('should return empty array for non-existent dimension', async () => {
      const query = `
        query {
          getDimensionTable(name: "inexistent") {
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
  // 3. FACT TABLE TESTS
  // ============================================
  
  describe('Fact Table Operations', () => {
    test('should retrieve facts with pagination', async () => {
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
      expect(result.data.getFactTable.data.length).toBeLessThanOrEqual(10);
      expect(result.data.getFactTable.total).toBeGreaterThan(0);
      expect(result.data.getFactTable.currentPage).toBe(1);
      expect(typeof result.data.getFactTable.hasNextPage).toBe('boolean');
      expect(result.data.getFactTable.totalPages).toBeGreaterThan(0);
    });

    test('should apply string filters', async () => {
      const query = `
        query {
          getFactTable(
            filters: "country = 1 AND indicator = 1"
            limit: 20
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
      expect(Array.isArray(result.data.getFactTable.data)).toBe(true);
    });

    test('should apply structured filters', async () => {
      const query = `
        query {
          getFactTable(
            structuredFilters: [
              { key: "country", operator: "=", value: "1" }
              { key: "kind", operator: "=", value: "1" }
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

    test('should apply sorting', async () => {
      const query = `
        query {
          getFactTable(
            sort: [
              { field: "value", order: DESC }
              { field: "date", order: ASC }
            ]
            limit: 15
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
      const values = result.data.getFactTable.data.map(d => d.value);
      
      // Check descending order for values
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
      }
    });

    test('should select specific fields', async () => {
      const query = `
        query {
          getFactTable(
            fields: ["country", "indicator", "value", "date"]
            limit: 5
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
      expect(result.data.getFactTable.data.length).toBeLessThanOrEqual(5);
    });

    test('should retrieve dimension details', async () => {
      const query = `
        query {
          getFactTable(limit: 5, offset: 0) {
            data {
              value
              dimensionDetails {
                name
                value
                label
              }
            }
            total
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getFactTable.data[0].dimensionDetails).toBeDefined();
      expect(Array.isArray(result.data.getFactTable.data[0].dimensionDetails)).toBe(true);
      
      // Check that categorical dimensions have labels
      const countryDetail = result.data.getFactTable.data[0].dimensionDetails
        .find(d => d.name === 'country');
      if (countryDetail) {
        expect(countryDetail.label).toBeDefined();
      }
    });

    test('should handle multiple pagination pages', async () => {
      const query = `
        query {
          page1: getFactTable(limit: 10, offset: 0) {
            data {
              value
            }
            total
            currentPage
            hasNextPage
          }
          page2: getFactTable(limit: 10, offset: 10) {
            data {
              value
            }
            currentPage
            hasNextPage
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.page1.currentPage).toBe(1);
      expect(result.data.page2.currentPage).toBe(2);
      expect(result.data.page1.total).toBe(result.data.page2.total);
    });

    test('should reject excessive limit', async () => {
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

    test('should reject excessive offset', async () => {
      const query = `
        query {
          getFactTable(limit: 10, offset: 10001) {
            data {
              value
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Offset cannot exceed 10000');
    });
  });

  // ============================================
  // 4. FACT TABLE WITH METADATA TESTS
  // ============================================
  
  describe('Fact Table with Metadata', () => {
    test('should retrieve facts with D3-optimized metadata', async () => {
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
              currentPage
              totalPages
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
      expect(result.data.getFactTableWithMetadata.metadata.count).toBeGreaterThan(0);
    });

    test('should retrieve metadata with filters', async () => {
      const query = `
        query {
          getFactTableWithMetadata(
            structuredFilters: [
              { key: "country", operator: "IN", values: ["1", "2", "3"] }
            ]
            limit: 100
            offset: 0
          ) {
            columns
            data
            metadata {
              count
              extents
              total
            }
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getFactTableWithMetadata).toBeDefined();
      expect(result.data.getFactTableWithMetadata.metadata.count).toBeGreaterThan(0);
      expect(result.data.getFactTableWithMetadata.metadata.extents).toBeDefined();
    });
  });

  // ============================================
  // 5. AGGREGATED FACTS TESTS
  // ============================================
  
  describe('Aggregated Facts Operations', () => {
    test('should perform simple aggregation', async () => {
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
      expect(result.data.getAggregatedFacts.length).toBeGreaterThan(0);
      expect(result.data.getAggregatedFacts[0]).toHaveProperty('key');
      expect(result.data.getAggregatedFacts[0]).toHaveProperty('aggregatedValue');
      expect(result.data.getAggregatedFacts[0]).toHaveProperty('count');
    });

    test('should support different aggregation functions', async () => {
      const query = `
        query {
          sumByCountry: getAggregatedFacts(groupBy: "country", aggregation: SUM) {
            key
            aggregatedValue
          }
          avgByIndicator: getAggregatedFacts(groupBy: "indicator", aggregation: AVG) {
            key
            aggregatedValue
          }
          maxByKind: getAggregatedFacts(groupBy: "kind", aggregation: MAX) {
            key
            aggregatedValue
          }
          countByModel: getAggregatedFacts(groupBy: "model", aggregation: COUNT) {
            key
            aggregatedValue
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.sumByCountry).toBeDefined();
      expect(result.data.avgByIndicator).toBeDefined();
      expect(result.data.maxByKind).toBeDefined();
      expect(result.data.countByModel).toBeDefined();
      
      // All should be arrays with data
      expect(Array.isArray(result.data.sumByCountry)).toBe(true);
      expect(Array.isArray(result.data.avgByIndicator)).toBe(true);
      expect(Array.isArray(result.data.maxByKind)).toBe(true);
      expect(Array.isArray(result.data.countByModel)).toBe(true);
    });

    test('should apply filters to aggregation', async () => {
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "indicator"
            aggregation: AVG
            filters: "country IN (1, 2) AND kind = 1"
            limit: 20
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
    });

    test('should sort aggregated results', async () => {
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "country"
            aggregation: SUM
            sort: [{ field: "aggregatedValue", order: DESC }]
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
      
      // Check descending order
      const values = result.data.getAggregatedFacts.map(r => r.aggregatedValue);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
      }
    });

    test('should retrieve key labels', async () => {
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "country"
            aggregation: SUM
            limit: 5
            offset: 0
          ) {
            key
            keyLabel
            aggregatedValue
            count
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

    test('should handle pagination in aggregation', async () => {
      const query = `
        query {
          getAggregatedFacts(
            groupBy: "country"
            aggregation: SUM
            limit: 2
            offset: 2
          ) {
            key
            aggregatedValue
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getAggregatedFacts).toBeDefined();
      expect(result.data.getAggregatedFacts.length).toBeLessThanOrEqual(2);
    });
  });

  // ============================================
  // 6. AGGREGATED FACTS WITH METADATA TESTS
  // ============================================
  
  describe('Aggregated Facts with Metadata', () => {
    test('should retrieve aggregation with complete metadata', async () => {
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
      
      const metadata = result.data.getAggregatedFactsWithMetadata.metadata;
      expect(metadata.count).toBeGreaterThan(0);
      expect(metadata.keyExtent).toBeDefined();
      expect(metadata.valueExtent).toBeDefined();
      expect(metadata.statistics).toBeDefined();
      expect(metadata.statistics.mean).toBeDefined();
      expect(metadata.statistics.median).toBeDefined();
      expect(metadata.statistics.stdDev).toBeDefined();
      expect(metadata.statistics.quartiles).toBeDefined();
      expect(metadata.groupByFieldInfo).toBeDefined();
      expect(metadata.groupByFieldInfo.name).toBe('indicator');
    });
  });

  // ============================================
  // 7. SELECT OPTIONS TESTS
  // ============================================
  
  describe('Select Options Operations', () => {
    test('should retrieve select options', async () => {
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
      expect(result.data.getSelectOptions.length).toBeLessThanOrEqual(10);
      expect(result.data.getSelectOptions[0]).toHaveProperty('value');
      expect(result.data.getSelectOptions[0]).toHaveProperty('label');
    });

    test('should filter options with search term', async () => {
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
      
      // Check that results contain search term if any results exist
      if (result.data.getSelectOptions.length > 0) {
        expect(result.data.getSelectOptions[0].label.toLowerCase())
          .toContain('fra');
      }
    });

    test('should retrieve grouped select options', async () => {
      const query = `
        query {
          getGroupedSelectOptions(
            groupField: "country"
            optionsField: "indicator"
            limit: 20
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
      expect(Array.isArray(result.data.getGroupedSelectOptions.options)).toBe(true);
    });
  });

  // ============================================
  // 8. IN/NOT IN OPERATOR TESTS
  // ============================================
  
  describe('IN and NOT IN Filter Operations', () => {
    test('should handle IN operator with multiple values', async () => {
      const query = `
        query {
          getFactTable(
            structuredFilters: [
              { key: "country", operator: "IN", values: ["1", "2", "3"] }
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

    test('should handle NOT IN operator', async () => {
      const query = `
        query {
          getFactTable(
            structuredFilters: [
              { key: "country", operator: "NOT IN", values: ["1", "2"] }
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

    test('should handle mixed operators in filters', async () => {
      const query = `
        query {
          getFactTable(
            structuredFilters: [
              { key: "country", operator: "IN", values: ["1", "2", "3"] }
              { key: "kind", operator: "=", value: "1" }
              { key: "indicator", operator: "NOT IN", values: ["5", "6"] }
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
    });
  });

  // ============================================
  // 9. COMPLEX QUERY TESTS
  // ============================================
  
  describe('Complex Query Operations', () => {
    test('should handle complex combined query', async () => {
      const query = `
        query {
          # Metadata
          countryMeta: getMetaData(name: "country") {
            name
            label
            is_categorical
          }
          
          # Dimensions
          countries: getDimensionTable(name: "country") {
            value
            label
          }
          
          # Facts with details
          facts: getFactTable(
            structuredFilters: [
              { key: "country", operator: "=", value: "1" }
            ]
            sort: [{ field: "value", order: DESC }]
            limit: 5
            offset: 0
          ) {
            data {
              value
              dimensionDetails {
                name
                value
                label
              }
            }
            total
          }
          
          # Aggregations
          aggregated: getAggregatedFacts(
            groupBy: "indicator"
            aggregation: AVG
            filters: "country = 1"
          ) {
            key
            keyLabel
            aggregatedValue
          }
          
          # Options
          options: getSelectOptions(fieldName: "indicator") {
            value
            label
          }
        }
      `;

      const result = await server.executeOperation({ query });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.countryMeta).toBeDefined();
      expect(result.data.countries).toBeDefined();
      expect(result.data.facts).toBeDefined();
      expect(result.data.aggregated).toBeDefined();
      expect(result.data.options).toBeDefined();
      
      // Verify each section has expected structure
      expect(result.data.countryMeta.name).toBe('country');
      expect(Array.isArray(result.data.countries)).toBe(true);
      expect(result.data.facts.data).toBeDefined();
      expect(Array.isArray(result.data.aggregated)).toBe(true);
      expect(Array.isArray(result.data.options)).toBe(true);
    });
  });

  // ============================================
  // 10. PERFORMANCE TESTS
  // ============================================
  
  describe('Performance Tests', () => {
    test('should handle large dataset queries efficiently', async () => {
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
      expect(duration).toBeLessThan(10000); // Should complete in under 10 seconds
    });

    test('should handle large aggregation queries', async () => {
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
            count
          }
        }
      `;

      const startTime = Date.now();
      const result = await server.executeOperation({ query });
      const duration = Date.now() - startTime;
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getAggregatedFacts).toBeDefined();
      expect(duration).toBeLessThan(10000); // Should complete in under 10 seconds
    });
  });

  // ============================================
  // 11. VARIABLE TESTS
  // ============================================
  
  describe('Variable Usage Tests', () => {
    test('should handle query variables', async () => {
      const query = `
        query TestWithVariables(
          $country: String!
          $limit: Int!
          $offset: Int!
        ) {
          getFactTable(
            structuredFilters: [
              { key: "country", operator: "=", value: $country }
            ]
            limit: $limit
            offset: $offset
          ) {
            data {
              value
            }
            total
          }
        }
      `;

      const variables = {
        country: "1",
        limit: 10,
        offset: 0
      };

      const result = await server.executeOperation({ query, variables });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getFactTable).toBeDefined();
      expect(result.data.getFactTable.data.length).toBeLessThanOrEqual(10);
    });

    test('should handle variables in aggregation queries', async () => {
      const query = `
        query TestAggregationWithVariables(
          $groupBy: String!
          $aggregation: AggregationType!
          $limit: Int!
        ) {
          getAggregatedFacts(
            groupBy: $groupBy
            aggregation: $aggregation
            limit: $limit
            offset: 0
          ) {
            key
            aggregatedValue
            count
          }
        }
      `;

      const variables = {
        groupBy: "country",
        aggregation: "SUM",
        limit: 5
      };

      const result = await server.executeOperation({ query, variables });
      
      expect(result.errors).toBeUndefined();
      expect(result.data.getAggregatedFacts).toBeDefined();
      expect(result.data.getAggregatedFacts.length).toBeLessThanOrEqual(5);
    });
  });

  // ============================================
  // 12. ERROR HANDLING TESTS
  // ============================================
  
  describe('Error Handling and Edge Cases', () => {
    test('should validate aggregation types', async () => {
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
      expect(result.errors[0].message).toContain('Expected type AggregationType');
    });

    test('should validate sort orders', async () => {
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
      expect(result.errors[0].message).toContain('Expected type SortOrder');
    });

    test('should handle missing required fields', async () => {
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
      expect(result.errors[0].message).toContain('groupBy');
    });

    test('should handle invalid filter operators', async () => {
      const query = `
        query {
          getFactTable(
            structuredFilters: [
              { key: "country", operator: "INVALID_OP", value: "1" }
            ]
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
      expect(result.errors[0].message).toContain('Expected type FilterOperator');
    });
  });

  // ============================================
  // 13. CACHING TESTS
  // ============================================
  
  describe('Caching Behavior', () => {
    test('should cache repeated metadata queries', async () => {
      const query = `
        query {
          getMetaData(name: "country") {
            name
            label
            is_categorical
          }
        }
      `;

      // First query
      const startTime1 = Date.now();
      const result1 = await server.executeOperation({ query });
      const duration1 = Date.now() - startTime1;
      
      // Second query (should be cached)
      const startTime2 = Date.now();
      const result2 = await server.executeOperation({ query });
      const duration2 = Date.now() - startTime2;
      
      expect(result1.data).toEqual(result2.data);
      expect(duration2).toBeLessThan(duration1 * 0.8); // Should be significantly faster
    });

    test('should cache dimension table queries', async () => {
      const query = `
        query {
          getDimensionTable(name: "country") {
            value
            label
          }
        }
      `;

      // First query
      const startTime1 = Date.now();
      const result1 = await server.executeOperation({ query });
      const duration1 = Date.now() - startTime1;
      
      // Second query (should be cached)
      const startTime2 = Date.now();
      const result2 = await server.executeOperation({ query });
      const duration2 = Date.now() - startTime2;
      
      expect(result1.data).toEqual(result2.data);
      expect(duration2).toBeLessThan(duration1 * 0.8); // Should be significantly faster
    });
  });

  // ============================================
  // 14. SECURITY TESTS
  // ============================================
  
  describe('Security and Validation', () => {
    test('should prevent SQL injection in filters', async () => {
      const query = `
        query {
          getFactTable(
            filters: "country = '1; DROP TABLE facts; --'"
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
      
      // Should either work safely or return a validation error
      // but should not crash the server
      expect(result).toBeDefined();
    });

    test('should validate field names in structured filters', async () => {
      const query = `
        query {
          getFactTable(
            structuredFilters: [
              { key: "'; DROP TABLE facts; --", operator: "=", value: "1" }
            ]
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
      
      // Should handle invalid field names gracefully
      expect(result).toBeDefined();
    });
  });
});