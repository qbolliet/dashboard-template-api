import { ensureSetup, getServer, execute } from './helpers.js';

let server;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

describe('getDimensionTable', () => {
  test('returns dimension values with value and label', async () => {
    const query = `query { getDimensionTable(name: "country") { value label } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data.getDimensionTable)).toBe(true);
    expect(result.data.getDimensionTable.length).toBeGreaterThan(0);
    expect(result.data.getDimensionTable[0]).toHaveProperty('value');
    expect(result.data.getDimensionTable[0]).toHaveProperty('label');
  });

  test('handles multiple dimensions in a single query', async () => {
    const query = `
      query {
        countries: getDimensionTable(name: "country") { value label }
        indicators: getDimensionTable(name: "indicator") { value label }
        kinds: getDimensionTable(name: "kind") { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(Array.isArray(result.data.countries)).toBe(true);
    expect(Array.isArray(result.data.indicators)).toBe(true);
    expect(Array.isArray(result.data.kinds)).toBe(true);
  });

  test('returns empty array for a non-existent dimension', async () => {
    const query = `query { getDimensionTable(name: "inexistent") { value label } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data.getDimensionTable).toEqual([]);
  });

  test('accepts explicit empty database parameter (routes to default)', async () => {
    const noParam = `query { getDimensionTable(name: "country") { value label } }`;
    const withEmpty = `query { getDimensionTable(name: "country", database: "") { value label } }`;

    const r1 = await execute(server, { query: noParam });
    const r2 = await execute(server, { query: withEmpty });

    expect(r1.errors).toBeUndefined();
    expect(r2.errors).toBeUndefined();
    expect(r1.data.getDimensionTable).toEqual(r2.data.getDimensionTable);
  });

  test('caches repeated dimension queries (second call significantly faster)', async () => {
    const query = `query { getDimensionTable(name: "country") { value label } }`;

    const t1 = Date.now();
    await execute(server, { query });
    const d1 = Date.now() - t1;

    const t2 = Date.now();
    await execute(server, { query });
    const d2 = Date.now() - t2;

    expect(d2).toBeLessThan(d1 * 0.8);
  });
});
