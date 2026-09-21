/**
 * Integration tests for the default ordering of fact table queries.
 *
 * Offset pagination without an ORDER BY is not stable under DuckDB: the scan
 * is parallel and spans several files, so successive pages may repeat or drop
 * rows. Without an explicit sort the query is therefore ordered by
 * `dataset_metadata.cluster_by`; with an explicit sort the primary keys are
 * appended as tiebreakers (revue-technique-api.md §5.7).
 */

import { ApolloServer } from '@apollo/server';
import { ensureSetup, getServer, execute } from './helpers.js';

// ─── État partagé ─────────────────────────────────────────────────────────────

// Serveur Apollo réutilisé par tous les tests du fichier
let server: ApolloServer;

beforeAll(async () => {
  await ensureSetup();
  server = await getServer();
}, 60000);

// ─── Fonctions utilitaires ────────────────────────────────────────────────────

/** A fact row reduced to its coordinates and measures, as returned by the API. */
interface FactRow {
  keys: { name: string; value: unknown }[];
  measures: { name: string; value: unknown }[];
}

/**
 * Fetches one page of the fact table, optionally sorted.
 *
 * @param limit - Page size.
 * @param offset - Page offset.
 * @param sort - Inline sort argument, or an empty string to omit it.
 * @returns The rows of that page.
 */
// Lecture d'une page de faits, tri explicite optionnel
const page = async (limit: number, offset: number, sort: string = ''): Promise<FactRow[]> => {
  const sortArg = sort ? `sort: ${sort}, ` : '';
  const result = await execute(server, {
    query: `query {
      getFactTable(schema: "main", ${sortArg}limit: ${limit}, offset: ${offset}) {
        data { keys { name value } measures { name value } }
        total
      }
    }`,
  });

  expect(result.errors).toBeUndefined();
  return (result.data!.getFactTable as { data: FactRow[] }).data;
};

/**
 * Reduces a row to a stable identity built from its coordinates.
 *
 * @param row - Fact row returned by the API.
 * @returns A string identifying the row uniquely.
 */
// Identité d'une ligne : ses coordonnées, qui forment la clé logique
const identify = (row: FactRow): string =>
  row.keys
    .map((k) => `${k.name}=${String(k.value)}`)
    .sort()
    .join('|');

// ─── Pagination déterministe ──────────────────────────────────────────────────

describe('pagination sans tri explicite', () => {
  test('deux pages successives sont disjointes', async () => {
    const first = await page(200, 0);
    const second = await page(200, 200);

    expect(first).toHaveLength(200);
    expect(second).toHaveLength(200);

    const firstIds = new Set(first.map(identify));
    const overlap = second.map(identify).filter((id) => firstIds.has(id));

    expect(overlap).toEqual([]);
  });

  test('l’union des pages égale la requête non paginée', async () => {
    const whole = await page(600, 0);
    const pages = [await page(200, 0), await page(200, 200), await page(200, 400)];
    const union = pages.flat();

    expect(union).toHaveLength(whole.length);
    expect(union.map(identify).sort()).toEqual(whole.map(identify).sort());
  });

  test('la même page relue rend exactement les mêmes lignes, dans le même ordre', async () => {
    const once = await page(100, 300);
    const twice = await page(100, 300);

    expect(twice.map(identify)).toEqual(once.map(identify));
  });

  test('un balayage complet ne perd ni ne duplique aucune ligne', async () => {
    const result = await execute(server, {
      query: 'query { getFactTable(schema: "main", limit: 1) { total } }',
    });
    const total = (result.data!.getFactTable as { total: number }).total;

    // Balayage par pages de 500 sur l'ensemble du jeu de test
    const seen: string[] = [];
    for (let offset = 0; offset < total; offset += 500) {
      seen.push(...(await page(500, offset)).map(identify));
    }

    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });
});

// ─── Départage d'un tri explicite ─────────────────────────────────────────────

describe('pagination avec tri explicite', () => {
  // `kind` ne prend que deux valeurs : sans départage, l'ordre serait arbitraire
  const TIED = '[{ field: "kind", order: ASC }]';

  test('un tri sur une colonne à ex æquo reste déterministe', async () => {
    const once = await page(150, 150, TIED);
    const twice = await page(150, 150, TIED);

    expect(twice.map(identify)).toEqual(once.map(identify));
  });

  test('deux pages successives restent disjointes malgré les ex æquo', async () => {
    const first = await page(200, 0, TIED);
    const second = await page(200, 200, TIED);

    const firstIds = new Set(first.map(identify));
    const overlap = second.map(identify).filter((id) => firstIds.has(id));

    expect(overlap).toEqual([]);
  });

  test('le tri demandé reste prioritaire sur le départage', async () => {
    const rows = await page(400, 0, TIED);
    const kinds = rows.map((row) => String(row.keys.find((k) => k.name === 'kind')?.value ?? ''));

    // La colonne triée est bien croissante : le départage ne s'intercale pas
    expect([...kinds].sort()).toEqual(kinds);
  });

  test('un tri déjà porté par une clé primaire n’est pas dupliqué', async () => {
    const result = await execute(server, {
      query: `query {
        getFactTable(
          schema: "main"
          sort: [{ field: "country", order: DESC }]
          limit: 50
        ) { data { keys { name value } } }
      }`,
    });

    expect(result.errors).toBeUndefined();
    const rows = (result.data!.getFactTable as { data: FactRow[] }).data;
    const countries = rows.map((row) =>
      String(row.keys.find((k) => k.name === 'country')?.value ?? ''),
    );

    // Le tri explicite DESC est conservé, non écrasé par le départage ASC
    expect([...countries].sort().reverse()).toEqual(countries);
  });

  test('un champ de tri inconnu est toujours rejeté', async () => {
    const result = await execute(server, {
      query: `query {
        getFactTable(schema: "main", sort: [{ field: "nope; DROP", order: ASC }], limit: 5) {
          total
        }
      }`,
    });

    expect(result.errors).toBeDefined();
  });
});
