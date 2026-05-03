import { ensureSetup, getServer, execute } from './helpers.js';

let server;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

describe('getSelectOptions', () => {
  test('returns value/label pairs', async () => {
    const query = `query { getSelectOptions(fieldName: "country", limit: 10) { value label } }`;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const opts = result.data.getSelectOptions;
    expect(Array.isArray(opts)).toBe(true);
    expect(opts.length).toBeLessThanOrEqual(10);
    expect(opts[0]).toHaveProperty('value');
    expect(opts[0]).toHaveProperty('label');
  });

  test('filters options with a search term', async () => {
    const query = `
      query {
        getSelectOptions(fieldName: "country", searchTerm: "Fra", limit: 5) { value label }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    if (result.data.getSelectOptions.length > 0) {
      expect(result.data.getSelectOptions[0].label.toLowerCase()).toContain('fra');
    }
  });
});

describe('getGroupedSelectOptions', () => {
  test('returns group and options arrays', async () => {
    const query = `
      query {
        getGroupedSelectOptions(groupField: "country", optionsField: "indicator", limit: 20) {
          group { value label }
          options { value label }
        }
      }
    `;
    const result = await execute(server, { query });

    expect(result.errors).toBeUndefined();
    const r = result.data.getGroupedSelectOptions;
    expect(r.group).toBeDefined();
    expect(r.options).toBeDefined();
    expect(Array.isArray(r.options)).toBe(true);
  });
});
