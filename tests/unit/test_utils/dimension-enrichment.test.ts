/**
 * Unit tests for dimension enrichment utilities (src/utils/dimension-enrichment.ts).
 *
 * Covers enrichFactsWithDimensions (field-level enrichment) and
 * enrichAggregatedFactsWithLabels (group-by key label resolution),
 * including categorical/non-categorical branching and deduplication.
 */

// Importation directe — pas de module à mocker, les loaders sont des faux objets.
import { jest } from '@jest/globals';
import {
  enrichFactsWithDimensions,
  enrichAggregatedFactsWithLabels,
} from '../../../src/utils/dimension-enrichment.js';

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** Métadonnée de champ indiquant si la dimension est catégorielle. */
interface FieldMetadata {
  is_categorical: boolean;
}

/** Détail d'une valeur de dimension enrichie. */
interface DimensionDetail {
  name: string;
  value: string;
  label: string;
}

/** Options de configuration de la fabrique de mocks. */
interface MockLoadersOptions {
  metadataMap?: Record<string, FieldMetadata | null>;
  dimensionValueMap?: Record<string, DimensionDetail | null>;
}

/** Loaders mockés exposant les mêmes méthodes que les loaders de production. */
interface MockLoaders {
  metadata: { load: jest.Mock };
  dimensionValue: { load: jest.Mock };
}

// ─── Fabrique de mocks ─────────────────────────────────────────────────────────

/**
 * Create a set of mock data loaders for dimension enrichment tests.
 *
 * Args:
 *     options: Optional maps controlling what each loader returns.
 *         metadataMap: Keyed by field name, value is FieldMetadata or null.
 *         dimensionValueMap: Keyed by "dimensionName:value", value is DimensionDetail or null.
 *
 * Returns:
 *     MockLoaders object with jest.fn() for each load method.
 */
const makeMockLoaders = ({ metadataMap = {}, dimensionValueMap = {} }: MockLoadersOptions = {}): MockLoaders => ({
  metadata: {
    load: jest.fn((fieldName: unknown) =>
      Promise.resolve(metadataMap[fieldName as string] ?? null)
    ),
  },
  dimensionValue: {
    load: jest.fn(({ dimensionName, value }: { dimensionName: string; value: string }) =>
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
    // Valeurs null — ignorées lors de la construction des détails de dimension.
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
    // Repli sur la valeur brute — label identique à la valeur si non trouvé.
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
    // Déduplication — chaque paire (champ, valeur) ne doit être chargée qu'une seule fois.
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
    // Champs réservés — "value" et "_groupByField" exclus de l'enrichissement.
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
    // Champ groupBy null — retour direct sans transformation.
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
        'region_id:1': { name: 'region_id', value: '1', label: 'Paris' },
        'region_id:2': { name: 'region_id', value: '2', label: 'Lyon' },
      },
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'region_id', loaders);
    expect(result[0].keyLabel).toBe('Paris');
    expect(result[1].keyLabel).toBe('Lyon');
  });

  test('falls back to key when label not found', async () => {
    // Repli sur la clé brute — label identique à la clé si dimension introuvable.
    const facts = [{ key: '99', value: 50 }];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: {},
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'region_id', loaders);
    expect(result[0].keyLabel).toBe('99');
  });

  test('loads each unique key only once', async () => {
    // Déduplication — clés identiques dans plusieurs faits chargées une seule fois.
    const facts = [
      { key: '1', value: 10 },
      { key: '1', value: 20 },
      { key: '2', value: 30 },
    ];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: {
        'region_id:1': { name: 'region_id', value: '1', label: 'Paris' },
        'region_id:2': { name: 'region_id', value: '2', label: 'Lyon' },
      },
    });
    await enrichAggregatedFactsWithLabels(facts, 'region_id', loaders);
    expect(loaders.dimensionValue.load).toHaveBeenCalledTimes(2);
  });

  test('adds _groupByField to each enriched fact', async () => {
    const facts = [{ key: '1', value: 100 }];
    const loaders = makeMockLoaders({
      metadataMap: { region_id: { is_categorical: true } },
      dimensionValueMap: { 'region_id:1': { name: 'region_id', value: '1', label: 'Paris' } },
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'region_id', loaders);
    expect(result[0]._groupByField).toBe('region_id');
  });

  test('preserves original fact fields', async () => {
    // Conservation des champs originaux — pas de mutation destructive des faits.
    const facts = [{ key: '1', value: 999, extra: 'data' }];
    const loaders = makeMockLoaders({
      metadataMap: { cat: { is_categorical: false } },
    });
    const result = await enrichAggregatedFactsWithLabels(facts, 'cat', loaders);
    expect(result[0].value).toBe(999);
    expect(result[0].extra).toBe('data');
  });
});
