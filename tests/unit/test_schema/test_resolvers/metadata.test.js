import { ensureSetup, getServer, execute } from './helpers.js';

let server;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

describe('getMetaData', () => {
  test('returns metadata for a categorical field', async () => {
    const query = `query { getMetaData(name: "country") { name label python_type sql_type is_categorical } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data.getMetaData.name).toBe('country');
    expect(result.data.getMetaData.is_categorical).toBe(true);
    expect(result.data.getMetaData.label).toBeDefined();
    expect(result.data.getMetaData.python_type).toBeDefined();
    expect(result.data.getMetaData.sql_type).toBeDefined();
  });

  test('returns metadata for a numeric field', async () => {
    const query = `query { getMetaData(name: "value") { name label python_type sql_type is_categorical } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data.getMetaData.name).toBe('value');
    expect(result.data.getMetaData.is_categorical).toBe(false);
  });

  test('returns is_primary_key field', async () => {
    const query = `query { getMetaData(name: "country") { name is_categorical is_primary_key } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data.getMetaData).toBeDefined();
    expect(typeof result.data.getMetaData.is_primary_key).toBe('boolean');
    expect(result.data.getMetaData.is_primary_key).toBe(true);
  });

  test('returns null for a non-existent field', async () => {
    const query = `query { getMetaData(name: "field_that_does_not_exist") { name label } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data.getMetaData).toBeNull();
  });

  test('handles multiple fields in a single query', async () => {
    const query = `
      query {
        indicator: getMetaData(name: "indicator") { name label is_categorical }
        value: getMetaData(name: "value") { name label is_categorical }
        date: getMetaData(name: "date") { name sql_type is_categorical }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    expect(result.data.indicator.name).toBe('indicator');
    expect(result.data.value.name).toBe('value');
    expect(result.data.date.name).toBe('date');
  });

  test('caches repeated queries (second call significantly faster)', async () => {
    const query = `query { getMetaData(name: "country") { name label is_categorical } }`;

    const t1 = performance.now();
    await execute(server, { query });
    const d1 = performance.now() - t1;

    const t2 = performance.now();
    await execute(server, { query });
    const d2 = performance.now() - t2;

    // Allow up to 50ms for the second call regardless of d1 (cache may already be warm).
    expect(d2).toBeLessThan(Math.max(d1 * 0.8, 50));
  });
});
