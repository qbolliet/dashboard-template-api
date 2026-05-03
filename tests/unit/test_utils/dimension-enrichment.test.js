// Unit tests for dimension enrichment utilities (src/utils/dimension-enrichment.js)
import { jest } from '@jest/globals';
import {
  enrichFactsWithDimensions,
  enrichAggregatedFactsWithLabels,
} from '../../src/utils/dimension-enrichment.js';

// ─── Mock loader factory ───────────────────────────────────────────────────────

const makeMockLoaders = ({ metadataMap = {}, dimensionValueMap = {} } = {}) => ({
  metadata: {
    load: jest.fn(fieldName => Promise.resolve(metadataMap[fieldName] ?? null)),
  },
  dimensionValue: {
    load: jest.fn(({ dimensionName, value }) =>
      Promise.resolve(dimensionValueMap[`${dimensionName}:${value}`] ?? null)
    ),
  },
});

// ─── enrichFactsWithDimensions ─────────────────────────────────────────────────

describe('enrichFactsWithDimensions', () => {
  test('returns the original value for null/empty facts', async () => {
    const loaders = makeMockLoaders();
    expect(await enrichFactsWithDimensions(null, loaders)).toBeNull();
    expect(await enrichFactsWithDimensions([], loaders)).toEqual([]);
  });

  test('adds empty dimensionDetails when fact has no dimension fields', async () => {
    const facts = [{ value: 100 }];
    const loaders = makeMockLoaders();
    const result = await enrichFactsWithDimensions(facts, loaders);
    expect(result[0].dimensionDetails).toEqual([]);
  });

  test('skips null field values when building dimension details', async () => {
    const facts = [{ value: 100, region: null }];
    const loaders = makeMockLoaders();
    const result = await enrichFactsWithDimensions(facts, loaders);
    expect(result[0].dimensionDetails).toEqual([]);
  });

  test('returns raw value object for non-categorical fields', async () => {
    const facts = [{ value: 100, year: '2023' }];
    const loaders = makeMockLoaders({
      metadataMap: { year: { is_categorical: false } },
    });
    const result = await enrichFactsWithDimensions(facts, loaders);
    expect(result[0].dimensionDetails).toEqual([
      { name: 'year', value: '2023', label: '2023' },
    ]);
  });

  test('enriches categorical fields with dimension details', async () => {
    const facts = [{ value: 100, region_id: '42' }];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: {
        'region_id:42': { name: 'region_id', value: '42', label: 'Paris' },
      },
    });
    const result = await enrichFactsWithDimensions(facts, loaders);
    expect(result[0].dimensionDetails[0].label).toBe('Paris');
  });

  test('falls back to raw object when categorical detail not found', async () => {
    const facts = [{ value: 100, region_id: '99' }];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: {},
    });
    const result = await enrichFactsWithDimensions(facts, loaders);
    expect(result[0].dimensionDetails[0]).toEqual({
      name: 'region_id',
      value: '99',
      label: '99',
    });
  });

  test('loads each unique (field, value) pair only once', async () => {
    const facts = [
      { value: 10, region_id: '1' },
      { value: 20, region_id: '1' },
      { value: 30, region_id: '2' },
    ];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: {
        'region_id:1': { name: 'region_id', value: '1', label: 'Paris' },
        'region_id:2': { name: 'region_id', value: '2', label: 'Lyon' },
      },
    });
    await enrichFactsWithDimensions(facts, loaders);
    expect(loaders.dimensionValue.load).toHaveBeenCalledTimes(2);
  });

  test('excludes value and _groupByField from dimension enrichment', async () => {
    const facts = [{ value: 100, _groupByField: 'year' }];
    const loaders = makeMockLoaders();
    const result = await enrichFactsWithDimensions(facts, loaders);
    expect(result[0].dimensionDetails).toEqual([]);
  });

  test('enriches multiple facts and preserves original fields', async () => {
    const facts = [
      { value: 10, category: 'A' },
      { value: 20, category: 'B' },
    ];
    const loaders = makeMockLoaders({
      metadataMap: { category: { is_categorical: false } },
    });
    const result = await enrichFactsWithDimensions(facts, loaders);
    expect(result).toHaveLength(2);
    expect(result[0].value).toBe(10);
    expect(result[1].category).toBe('B');
    expect(result[0].dimensionDetails).toBeDefined();
  });
});

// ─── enrichAggregatedFactsWithLabels ──────────────────────────────────────────

describe('enrichAggregatedFactsWithLabels', () => {
  test('returns original value for null/empty inputs', async () => {
    const loaders = makeMockLoaders();
    expect(await enrichAggregatedFactsWithLabels(null, 'field', loaders)).toBeNull();
    expect(await enrichAggregatedFactsWithLabels([], 'field', loaders)).toEqual([]);
    const facts = [{ key: '1', value: 100 }];
    expect(await enrichAggregatedFactsWithLabels(facts, null, loaders)).toEqual(facts);
  });

  test('uses key as keyLabel for non-categorical groupByField', async () => {
    const facts = [
      { key: '2023', value: 100 },
      { key: '2024', value: 200 },
    ];
    const loaders = makeMockLoaders({
      metadataMap: { year: { is_categorical: false } },
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'year', loaders);
    expect(result[0].keyLabel).toBe('2023');
    expect(result[1].keyLabel).toBe('2024');
    expect(result[0]._groupByField).toBe('year');
  });

  test('uses key as keyLabel when metadata is null', async () => {
    const facts = [{ key: 'abc', value: 1 }];
    const loaders = makeMockLoaders({ metadataMap: { field: null } });
    const result = await enrichAggregatedFactsWithLabels(facts, 'field', loaders);
    expect(result[0].keyLabel).toBe('abc');
  });

  test('enriches categorical groupByField with labels', async () => {
    const facts = [
      { key: '1', value: 100 },
      { key: '2', value: 200 },
    ];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: {
        'region_id:1': { label: 'Paris' },
        'region_id:2': { label: 'Lyon' },
      },
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'region_id', loaders);
    expect(result[0].keyLabel).toBe('Paris');
    expect(result[1].keyLabel).toBe('Lyon');
  });

  test('falls back to key when label not found', async () => {
    const facts = [{ key: '99', value: 50 }];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: {},
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'region_id', loaders);
    expect(result[0].keyLabel).toBe('99');
  });

  test('loads each unique key only once', async () => {
    const facts = [
      { key: '1', value: 10 },
      { key: '1', value: 20 },
      { key: '2', value: 30 },
    ];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: {
        'region_id:1': { label: 'Paris' },
        'region_id:2': { label: 'Lyon' },
      },
    });
    await enrichAggregatedFactsWithLabels(facts, 'region_id', loaders);
    expect(loaders.dimensionValue.load).toHaveBeenCalledTimes(2);
  });

  test('adds _groupByField to each enriched fact', async () => {
    const facts = [{ key: '1', value: 100 }];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: { 'region_id:1': { label: 'Paris' } },
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'region_id', loaders);
    expect(result[0]._groupByField).toBe('region_id');
  });

  test('preserves original fact fields', async () => {
    const facts = [{ key: '1', value: 999, extra: 'data' }];
    const loaders = makeMockLoaders({
      metadataMap: { cat: { is_categorical: false } },
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'cat', loaders);
    expect(result[0].value).toBe(999);
    expect(result[0].extra).toBe('data');
  });
});
