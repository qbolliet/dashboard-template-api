import { ensureSetup, getServer, execute } from './helpers.js';

let server;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

describe('getAggregatedFacts', () => {
  test('performs SUM aggregation grouped by country', async () => {
    const query = `
      query {
        getAggregatedFacts(groupBy: "country", aggregation: SUM, limit: 10, offset: 0) {
          key
          aggregatedValue
          count
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const rows = result.data.getAggregatedFacts;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('key');
    expect(rows[0]).toHaveProperty('aggregatedValue');
    expect(rows[0]).toHaveProperty('count');
  });

  test('supports SUM, AVG, MAX, COUNT in a single query', async () => {
    const query = `
      query {
        sumByCountry: getAggregatedFacts(groupBy: "country", aggregation: SUM) { key aggregatedValue }
        avgByIndicator: getAggregatedFacts(groupBy: "indicator", aggregation: AVG) { key aggregatedValue }
        maxByKind: getAggregatedFacts(groupBy: "kind", aggregation: MAX) { key aggregatedValue }
        countByModel: getAggregatedFacts(groupBy: "model", aggregation: COUNT) { key aggregatedValue }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data.sumByCountry)).toBe(true);
    expect(Array.isArray(result.data.avgByIndicator)).toBe(true);
    expect(Array.isArray(result.data.maxByKind)).toBe(true);
    expect(Array.isArray(result.data.countByModel)).toBe(true);
  });

  test('MIN returns values smaller than or equal to AVG', async () => {
    const query = `
      query {
        minAgg: getAggregatedFacts(groupBy: "country", aggregation: MIN) { key aggregatedValue }
        avgAgg: getAggregatedFacts(groupBy: "country", aggregation: AVG) { key aggregatedValue }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data.minAgg)).toBe(true);
    expect(Array.isArray(result.data.avgAgg)).toBe(true);

    for (const minRow of result.data.minAgg) {
      const avgRow = result.data.avgAgg.find(r => r.key === minRow.key);
      if (avgRow) {
        expect(minRow.aggregatedValue).toBeLessThanOrEqual(avgRow.aggregatedValue);
      }
    }
  });

  test('MEDIAN aggregation returns non-null values', async () => {
    const query = `
      query {
        getAggregatedFacts(groupBy: "country", aggregation: MEDIAN) { key aggregatedValue count }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data.getAggregatedFacts)).toBe(true);
    if (result.data.getAggregatedFacts.length > 0) {
      expect(result.data.getAggregatedFacts[0].aggregatedValue).not.toBeNull();
    }
  });

  test('MODE aggregation returns non-null values', async () => {
    const query = `
      query {
        getAggregatedFacts(groupBy: "kind", aggregation: MODE) { key aggregatedValue count }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data.getAggregatedFacts)).toBe(true);
    if (result.data.getAggregatedFacts.length > 0) {
      expect(result.data.getAggregatedFacts[0].aggregatedValue).not.toBeNull();
    }
  });

  test('applies filters to aggregation', async () => {
    const query = `
      query {
        getAggregatedFacts(
          groupBy: "indicator"
          aggregation: AVG
          filters: "country IN (1, 2) AND kind = 1"
          limit: 20
          offset: 0
        ) { key aggregatedValue count }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data.getAggregatedFacts)).toBe(true);
  });

  test('sorts aggregated results in descending order', async () => {
    const query = `
      query {
        getAggregatedFacts(
          groupBy: "country"
          aggregation: SUM
          sort: [{ field: "aggregatedValue", order: DESC }]
          limit: 10
          offset: 0
        ) { key aggregatedValue count }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const values = result.data.getAggregatedFacts.map(r => r.aggregatedValue);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
    }
  });

  test('resolves keyLabel (human-readable, different from key)', async () => {
    const query = `
      query {
        getAggregatedFacts(groupBy: "country", aggregation: SUM, limit: 5, offset: 0) {
          key
          keyLabel
          aggregatedValue
          count
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const first = result.data.getAggregatedFacts[0];
    expect(first.keyLabel).toBeDefined();
    expect(first.keyLabel).not.toBe(first.key);
  });

  test('paginates — respects limit', async () => {
    const query = `
      query {
        getAggregatedFacts(groupBy: "country", aggregation: SUM, limit: 2, offset: 2) {
          key
          aggregatedValue
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data.getAggregatedFacts.length).toBeLessThanOrEqual(2);
  });

  test('handles query variables', async () => {
    const query = `
      query TestAggVars($groupBy: String!, $aggregation: Aggregation!, $limit: Int!) {
        getAggregatedFacts(groupBy: $groupBy, aggregation: $aggregation, limit: $limit, offset: 0) {
          key
          aggregatedValue
          count
        }
      }
    `;
    const result = await execute(server, {
      query,
      variables: { groupBy: 'country', aggregation: 'SUM', limit: 5 }
    });

    expect(result.errors).toBeUndefined();
    expect(result.data.getAggregatedFacts.length).toBeLessThanOrEqual(5);
  });

  test('handles large aggregation (1000 groups) in under 10s', async () => {
    const query = `
      query {
        getAggregatedFacts(groupBy: "date", aggregation: AVG, limit: 1000, offset: 0) {
          key
          aggregatedValue
          count
        }
      }
    `;
    const t = Date.now();
    const result = await execute(server, { query });
    expect(result.errors).toBeUndefined();
    expect(Date.now() - t).toBeLessThan(10000);
  });

  test('requires groupBy field — errors when missing', async () => {
    const query = `
      query {
        getAggregatedFacts(aggregation: SUM, limit: 10, offset: 0) { aggregatedValue }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toContain('groupBy');
  });

  test('rejects invalid aggregation type', async () => {
    const query = `
      query {
        getAggregatedFacts(groupBy: "country", aggregation: INVALID_AGG, limit: 10, offset: 0) {
          aggregatedValue
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeDefined();
    expect(result.errors[0].message).toContain('Aggregation');
  });
});

describe('getAggregatedFactsWithMetadata', () => {
  test('returns aggregation data with full statistical metadata', async () => {
    const query = `
      query {
        getAggregatedFactsWithMetadata(groupBy: "indicator", aggregation: AVG, limit: 10, offset: 0) {
          data { key keyLabel aggregatedValue count }
          metadata {
            count
            keyExtent
            valueExtent
            statistics { mean median stdDev quartiles }
            groupByFieldInfo { name label is_categorical }
          }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const meta = result.data.getAggregatedFactsWithMetadata.metadata;
    expect(meta.count).toBeGreaterThan(0);
    expect(meta.keyExtent).toBeDefined();
    expect(meta.valueExtent).toBeDefined();
    expect(meta.statistics.mean).toBeDefined();
    expect(meta.statistics.median).toBeDefined();
    expect(meta.statistics.stdDev).toBeDefined();
    expect(meta.statistics.quartiles).toBeDefined();
    expect(meta.groupByFieldInfo.name).toBe('indicator');
  });
});
