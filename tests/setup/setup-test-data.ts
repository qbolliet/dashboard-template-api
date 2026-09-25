/**
 * Test DuckLake catalog creation script.
 *
 * Creates (or resets) the test DuckLake catalogs used by the Jest test suite,
 * reproducing the DDL of the database specification (specification-bdd.md §2):
 * every schema holds EXACTLY three tables — fact_table, metadata,
 * dataset_metadata — categorical columns store their labels directly, and no
 * dim_* table exists. A business code and its label are two fact_table
 * columns linked by metadata.label_for (§2.6).
 *
 * Must be run as a separate process (npm run test:setup) BEFORE npm test,
 * because DuckLake allows only one write connection at a time on Windows.
 * During tests the pool opens the catalogs in READ_ONLY mode (set via DEFAULT_READ_ONLY=true
 * in setup-env.ts), allowing all Jest VM contexts to share the same files concurrently.
 */

// Création des catalogues DuckLake de test — processus isolé avant npm test.
import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type Connection = Awaited<ReturnType<InstanceType<typeof DuckDBInstance>['connect']>>;

// ─── Interfaces et types ───────────────────────────────────────────────────────

/**
 * One row of the `metadata` table, in the column order of the specification
 * (specification-bdd.md §2.2). `python_type` does not exist.
 */
interface MetadataRow {
  name: string;
  label: string;
  sqlType: string;
  isPrimaryKey: boolean;
  isCategorical: boolean;
  parentName: string | null;
  labelFor: string | null;
  unit: string | null;
  displayFormat: string | null;
  family: string | null;
  description: string | null;
  defaultAggregation: string | null;
}

/** The single row of the `dataset_metadata` table of a schema (§2.3). */
interface DatasetMetadataRow {
  label: string;
  description: string;
  source: string;
  updatedAt: string;
  schemaVersion: number;
  clusterBy: string[];
}

/** Full description of one test schema: its three tables and its data. */
interface SchemaSpec {
  metadata: MetadataRow[];
  datasetMetadata: DatasetMetadataRow;
  rows: unknown[][];
}

// ─── Libellés de référence ─────────────────────────────────────────────────────

// Les colonnes catégorielles portent directement ces libellés (spec §2.1).
const COUNTRIES = ['France', 'Germany', 'Spain', 'Italy', 'United Kingdom'];
const INDICATORS = [
  'GDP Growth Rate',
  'Inflation Rate',
  'Unemployment Rate',
  'Trade Balance',
] as const;
const KINDS = ['Actual', 'Forecast'] as const;
const MODELS = ['Linear Regression', 'ARIMA', 'Neural Network'] as const;
const TRAININGS = ['Training Set 2023', 'Training Set 2024'] as const;

// Pays présent dans tous les catalogues avec UNE seule ligne, dont la valeur est
// nulle côté `default` : sert au test de division par zéro de deltaPercent.
const ZERO_COUNTRY = 'Zeroland';

// Pays propres à un seul catalogue : vérifient que compare* exclut les libellés
// disjoints au lieu de les apparier par erreur.
const DISJOINT_COUNTRY: Record<string, string> = {
  default: 'Portugal',
  macroeconomics: 'Netherlands',
  public_finance: 'Belgium',
  predictions: 'Poland',
};

// ─── Schéma « main » : palette de types de la spec §3 ──────────────────────────

/** Column order of the `main` fact_table, shared by every `main`-like schema. */
const MAIN_COLUMNS = `
  country        VARCHAR,
  indicator      VARCHAR,
  kind           VARCHAR,
  model          VARCHAR,
  training       VARCHAR,
  date           DATE,
  horizon        INTEGER,
  value          DOUBLE,
  lower_bound    FLOAT,
  upper_bound    FLOAT,
  headcount      BIGINT,
  sample_size    UINTEGER,
  is_provisional BOOLEAN,
  ingested_at    TIMESTAMP,
  notes          VARCHAR,
  quality_score  DOUBLE
`;

// Métadonnées du schéma « main ». Convention multi-mesure : une colonne est une
// MESURE ssi is_primary_key = false ; toutes les coordonnées (catégorielles ou
// non : date, horizon) sont is_primary_key = true.
const MAIN_METADATA: MetadataRow[] = [
  meta('country', 'Country', 'VARCHAR', true, true, { family: 'Géographie' }),
  meta('indicator', 'Economic Indicator', 'VARCHAR', true, true, { family: 'Économie' }),
  meta('kind', 'Data Kind', 'VARCHAR', true, true, { family: 'Méthode' }),
  meta('model', 'Model Type', 'VARCHAR', true, true, { family: 'Méthode' }),
  meta('training', 'Training Set', 'VARCHAR', true, true, { family: 'Méthode' }),
  meta('date', 'Date', 'DATE', true, false, {
    family: 'Temps',
    description: "Date d'observation, premier jour du mois",
  }),
  meta('horizon', 'Forecast Horizon', 'INTEGER', true, false, {
    unit: 'mois',
    family: 'Temps',
    description: 'Nombre de mois entre la date de production et la date observée',
  }),
  // Mesure de référence, entièrement documentée (unit + format d3 + famille + agrégation)
  meta('value', 'Measurement Value', 'DOUBLE', false, false, {
    unit: '€',
    displayFormat: ',.2f',
    family: 'Économie',
    description: "Valeur mesurée de l'indicateur",
    defaultAggregation: 'SUM',
  }),
  meta('lower_bound', 'Lower Confidence Bound', 'FLOAT', false, false, {
    unit: '€',
    displayFormat: ',.2f',
    family: 'Économie',
    defaultAggregation: 'MIN',
  }),
  meta('upper_bound', 'Upper Confidence Bound', 'FLOAT', false, false, {
    unit: '€',
    displayFormat: ',.2f',
    family: 'Économie',
    defaultAggregation: 'MAX',
  }),
  // Grand entier : contient au moins une valeur > 2^53 (sérialisation JSON à garantir)
  meta('headcount', 'Headcount', 'BIGINT', false, false, {
    unit: 'personnes',
    displayFormat: ',.0f',
    family: 'Démographie',
    description: 'Effectif concerné — dépasse 2^53 sur au moins une ligne',
    defaultAggregation: 'SUM',
  }),
  meta('sample_size', 'Sample Size', 'UINTEGER', false, false, {
    family: 'Qualité',
    defaultAggregation: 'SUM',
  }),
  meta('is_provisional', 'Provisional', 'BOOLEAN', false, false, { family: 'Qualité' }),
  meta('ingested_at', 'Ingested At', 'TIMESTAMP', false, false, { family: 'Qualité' }),
  meta('notes', 'Notes', 'VARCHAR', false, false, {
    family: 'Qualité',
    description: 'Note libre — NULL sur une partie des lignes',
  }),
  // Seconde mesure documentée, agrégée par moyenne
  meta('quality_score', 'Quality Score', 'DOUBLE', false, false, {
    displayFormat: '.0%',
    family: 'Qualité',
    description: 'Indice de confiance — NULL sur une partie des lignes',
    defaultAggregation: 'AVG',
  }),
];

// Clés primaires dans l'ordre de déclaration = cluster_by par défaut (spec §5.3)
const MAIN_CLUSTER_BY = MAIN_METADATA.filter((m) => m.isPrimaryKey).map((m) => m.name);

// ─── Schéma « geography » : hiérarchie de colonnes (spec §2.5) ─────────────────

/** Column order of the `geography` fact_table. */
const GEOGRAPHY_COLUMNS = `
  region       VARCHAR,
  departement  VARCHAR,
  commune      VARCHAR,
  date         DATE,
  population   UBIGINT,
  area_km2     FLOAT,
  budget       BIGINT,
  density      DOUBLE,
  is_urban     BOOLEAN
`;

// Chaîne region → departement → commune déclarée par parent_name ; les trois
// niveaux sont catégoriels, comme l'exige la spec §2.5.
const GEOGRAPHY_METADATA: MetadataRow[] = [
  meta('region', 'Région', 'VARCHAR', true, true, { family: 'Géographie' }),
  meta('departement', 'Département', 'VARCHAR', true, true, {
    parentName: 'region',
    family: 'Géographie',
  }),
  meta('commune', 'Commune', 'VARCHAR', true, true, {
    parentName: 'departement',
    family: 'Géographie',
    description: 'NULL lorsque le département ne descend pas au niveau communal',
  }),
  meta('date', 'Date', 'DATE', true, false, { family: 'Temps' }),
  meta('population', 'Population', 'UBIGINT', false, false, {
    unit: 'hab.',
    displayFormat: ',.0f',
    family: 'Démographie',
    defaultAggregation: 'SUM',
  }),
  meta('area_km2', 'Superficie', 'FLOAT', false, false, {
    unit: 'km²',
    displayFormat: ',.1f',
    family: 'Géographie',
    defaultAggregation: 'SUM',
  }),
  meta('budget', 'Budget', 'BIGINT', false, false, {
    unit: '€',
    displayFormat: ',.0f',
    family: 'Finances',
    description: 'Budget annuel — dépasse 2^53 sur au moins une ligne',
    defaultAggregation: 'SUM',
  }),
  meta('density', 'Densité', 'DOUBLE', false, false, {
    unit: 'hab./km²',
    displayFormat: ',.1f',
    family: 'Démographie',
    description: 'NULL sur au moins une ligne',
    defaultAggregation: 'AVG',
  }),
  meta('is_urban', 'Urbain', 'BOOLEAN', false, false, { family: 'Géographie' }),
];

const GEOGRAPHY_CLUSTER_BY = GEOGRAPHY_METADATA.filter((m) => m.isPrimaryKey).map((m) => m.name);

// Arbre géographique. Une commune NULL matérialise un arbre IRRÉGULIER : le
// niveau absent vaut NULL et la branche s'arrête là (spec §2.5) — on ne répète
// jamais le libellé du niveau supérieur. « Côte-d'Or » porte l'apostrophe qui
// vérifie le passage des libellés en paramètre et non en littéral SQL.
const GEOGRAPHY_TREE: Array<[string, string, string | null]> = [
  ['Bourgogne-Franche-Comté', "Côte-d'Or", 'Dijon'],
  ['Bourgogne-Franche-Comté', "Côte-d'Or", 'Beaune'],
  ['Bourgogne-Franche-Comté', 'Saône-et-Loire', null],
  ['Île-de-France', 'Paris', 'Paris'],
  ['Île-de-France', 'Seine-et-Marne', 'Meaux'],
  ['Île-de-France', 'Seine-et-Marne', 'Melun'],
  ['Occitanie', 'Hérault', 'Montpellier'],
];

// ─── Schéma « trade » : codes et libellés (spec §2.6) ────────────────────────────

/** Column order of the `trade` fact_table. */
const TRADE_COLUMNS = `
  nc6             VARCHAR,
  nc6_libelle     VARCHAR,
  nc8             VARCHAR,
  nc8_libelle_en  VARCHAR,
  nc8_libelle_fr  VARCHAR,
  partner_code    INTEGER,
  partner_libelle VARCHAR,
  year            INTEGER,
  value           DOUBLE,
  weight_kg       DOUBLE
`;

// Hiérarchie de codes nc6 → nc8 (parent_name) ; chaque niveau porte ses propres
// colonnes de libellés (label_for), nc8 en a deux (en, fr). Les colonnes de
// libellés ne sont ni clés primaires ni membres de la hiérarchie (spec §2.6) ;
// elles sont catégorielles pour que getSharedFields ait à les exclure.
const TRADE_METADATA: MetadataRow[] = [
  meta('nc6', 'Code NC6', 'VARCHAR', true, true, { family: 'Nomenclature' }),
  meta('nc6_libelle', 'Libellé NC6', 'VARCHAR', false, true, {
    labelFor: 'nc6',
    family: 'Nomenclature',
  }),
  meta('nc8', 'Code NC8', 'VARCHAR', true, true, {
    parentName: 'nc6',
    family: 'Nomenclature',
    description: 'Code de la nomenclature combinée, zéros de tête compris',
  }),
  meta('nc8_libelle_en', 'Libellé NC8 (en)', 'VARCHAR', false, true, {
    labelFor: 'nc8',
    family: 'Nomenclature',
  }),
  meta('nc8_libelle_fr', 'Libellé NC8 (fr)', 'VARCHAR', false, true, {
    labelFor: 'nc8',
    family: 'Nomenclature',
  }),
  // Code numérique doté d'un libellé : value = CAST(code AS VARCHAR)
  meta('partner_code', 'Code pays partenaire', 'INTEGER', true, true, { family: 'Géographie' }),
  meta('partner_libelle', 'Pays partenaire', 'VARCHAR', false, true, {
    labelFor: 'partner_code',
    family: 'Géographie',
  }),
  meta('year', 'Année', 'INTEGER', true, false, { family: 'Temps' }),
  meta('value', 'Valeur des échanges', 'DOUBLE', false, false, {
    unit: '€',
    displayFormat: ',.0f',
    family: 'Commerce',
    defaultAggregation: 'SUM',
  }),
  meta('weight_kg', 'Masse nette', 'DOUBLE', false, false, {
    unit: 'kg',
    displayFormat: ',.0f',
    family: 'Commerce',
    defaultAggregation: 'SUM',
  }),
];

const TRADE_CLUSTER_BY = TRADE_METADATA.filter((m) => m.isPrimaryKey).map((m) => m.name);

/** One nc8 code with its nc6 parent and every label (NULL when absent). */
interface TradeCode {
  nc6: string;
  nc6Libelle: string;
  nc8: string;
  en: string | null;
  fr: string | null;
}

// Libellé NC6 à apostrophe, partagé par les deux codes nc8 du chapitre 0201
const NC6_BOVINS = "Viandes désossées de l'espèce bovine, fraîches ou réfrigérées";
const NC6_CHEVAUX = 'Chevaux, autres que reproducteurs de race pure';

// Codes du catalogue default. 02013090 n'a AUCUN libellé : NULL sur toutes ses
// lignes, ce que la dépendance fonctionnelle code → libellé autorise.
const TRADE_CODES_DEFAULT: TradeCode[] = [
  {
    nc6: '010121',
    nc6Libelle: 'Chevaux reproducteurs de race pure',
    nc8: '01012100',
    en: 'Pure-bred breeding horses',
    fr: 'Chevaux reproducteurs de race pure',
  },
  {
    nc6: '010129',
    nc6Libelle: NC6_CHEVAUX,
    nc8: '01012910',
    en: 'Horses for slaughter',
    fr: 'Chevaux de boucherie',
  },
  {
    nc6: '010129',
    nc6Libelle: NC6_CHEVAUX,
    nc8: '01012990',
    en: 'Horses other than for slaughter',
    fr: 'Chevaux autres que de boucherie',
  },
  {
    nc6: '020130',
    nc6Libelle: NC6_BOVINS,
    nc8: '02013000',
    en: 'Boneless bovine meat, fresh or chilled',
    fr: "Viandes désossées de l'espèce bovine, fraîches ou réfrigérées",
  },
  { nc6: '020130', nc6Libelle: NC6_BOVINS, nc8: '02013090', en: null, fr: null },
];

// Codes du second catalogue : trois codes partagés avec default (compareFacts),
// dont 02013090 libellé ici seulement (COALESCE des deux côtés), et un code propre.
const TRADE_CODES_MACRO: TradeCode[] = [
  TRADE_CODES_DEFAULT[0],
  TRADE_CODES_DEFAULT[3],
  {
    nc6: '020130',
    nc6Libelle: NC6_BOVINS,
    nc8: '02013090',
    en: 'Other boneless bovine meat',
    fr: 'Autres viandes bovines désossées',
  },
  {
    nc6: '030211',
    nc6Libelle: 'Truites, fraîches ou réfrigérées',
    nc8: '03021100',
    en: 'Trout, fresh or chilled',
    fr: 'Truites, fraîches ou réfrigérées',
  },
];

// Pays partenaires : code numérique ISO 3166 et libellé (apostrophe comprise)
const TRADE_PARTNERS: Array<[number, string]> = [
  [250, 'France'],
  [276, 'Allemagne'],
  [384, "Côte d'Ivoire"],
];

// ─── Fonctions utilitaires ─────────────────────────────────────────────────────

/**
 * Builds a metadata row, defaulting every optional UI field to NULL.
 *
 * @param name - Technical column name.
 * @param label - Display label.
 * @param sqlType - DuckDB SQL type.
 * @param isPrimaryKey - Whether the column belongs to the logical key.
 * @param isCategorical - Whether the column is filtered through a select menu.
 * @param options - Optional UI fields (parentName, labelFor, unit, displayFormat, family, description, defaultAggregation).
 * @returns A fully populated MetadataRow.
 */
// Construction d'une ligne de métadonnées avec valeurs optionnelles à NULL
function meta(
  name: string,
  label: string,
  sqlType: string,
  isPrimaryKey: boolean,
  isCategorical: boolean,
  options: Partial<
    Pick<
      MetadataRow,
      | 'parentName'
      | 'labelFor'
      | 'unit'
      | 'displayFormat'
      | 'family'
      | 'description'
      | 'defaultAggregation'
    >
  > = {},
): MetadataRow {
  return {
    name,
    label,
    sqlType,
    isPrimaryKey,
    isCategorical,
    parentName: options.parentName ?? null,
    labelFor: options.labelFor ?? null,
    unit: options.unit ?? null,
    displayFormat: options.displayFormat ?? null,
    family: options.family ?? null,
    description: options.description ?? null,
    defaultAggregation: options.defaultAggregation ?? null,
  };
}

/**
 * Generates a synthetic measurement value for a given coordinate.
 *
 * @param indicator - Indicator label.
 * @param country - Country label.
 * @param date - Observation date.
 * @param kind - Data kind label.
 * @param multiplier - Scaling factor applied to the base value.
 * @returns Computed synthetic measurement value.
 */
// Génération d'une valeur synthétique, reproductible en ordre de grandeur
function generateValue(
  indicator: string,
  country: string,
  date: Date,
  kind: string,
  multiplier: number = 1.0,
): number {
  const countryRank = COUNTRIES.indexOf(country) + 1;
  // Variation saisonnière sinusoïdale sur 12 mois
  const monthVariation = Math.sin((date.getMonth() * Math.PI) / 6) * 0.1;
  const randomVariation = (Math.random() - 0.5) * 0.2;

  // Valeur de base selon l'indicateur
  let baseValue: number;
  switch (indicator) {
    case 'GDP Growth Rate':
      baseValue = 2.5 + (countryRank % 3) * 0.5;
      break;
    case 'Inflation Rate':
      baseValue = 2.0 + (countryRank % 4) * 0.3;
      break;
    case 'Unemployment Rate':
      baseValue = 7.0 - (countryRank % 4) * 0.8;
      break;
    case 'Trade Balance':
      baseValue = -20 + (countryRank % 5) * 15;
      break;
    default:
      baseValue = 50;
  }

  // Ajustement des prévisions par rapport aux valeurs constatées
  if (kind === 'Forecast') baseValue *= 1.1;

  return (baseValue + monthVariation + randomVariation) * multiplier;
}

/**
 * Formats a Date as a SQL DATE literal (YYYY-MM-DD).
 *
 * @param date - Date to format.
 * @returns ISO date string without the time part.
 */
// Formatage d'une date au format attendu par une colonne DATE
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Builds one fact row of a `main`-like schema, in MAIN_COLUMNS order.
 *
 * @param country - Country label.
 * @param indicator - Indicator label.
 * @param kind - Data kind label.
 * @param date - Observation date.
 * @param multiplier - Scaling factor applied to the measured value.
 * @param overrides - Optional forced values (used by the zero-value row).
 * @returns Row as an array aligned with MAIN_COLUMNS.
 */
// Construction d'une ligne de faits « main » avec ses mesures co-localisées
function mainRow(
  country: string,
  indicator: string,
  kind: string,
  date: Date,
  multiplier: number,
  overrides: { value?: number } = {},
): unknown[] {
  const value = overrides.value ?? generateValue(indicator, country, date, kind, multiplier);
  const horizon = kind === 'Forecast' ? Math.floor(Math.random() * 12) + 1 : 0;
  const model = MODELS[Math.floor(Math.random() * MODELS.length)];
  const training = TRAININGS[Math.floor(Math.random() * TRAININGS.length)];
  // Une ligne sur trois laisse notes et quality_score à NULL (mesures nullables)
  const sparse = date.getMonth() % 3 === 0;

  return [
    country,
    indicator,
    kind,
    model,
    training,
    isoDate(date),
    horizon,
    value,
    value * 0.9,
    value * 1.1,
    // BIGINT franchement au-delà de 2^53 sur les lignes constatées
    kind === 'Actual' ? 9007199254740993n + BigInt(date.getMonth()) : 1234567n,
    1000 + date.getMonth(),
    kind === 'Forecast',
    `${isoDate(date)} 03:15:00`,
    sparse ? null : kind.toLowerCase(),
    sparse ? null : Math.random(),
  ];
}

/**
 * Builds the fact rows of a `main`-like schema.
 *
 * @param countries - Country labels to generate rows for.
 * @param indicators - Indicator labels to generate rows for.
 * @param start - First observation date.
 * @param end - Last observation date (inclusive).
 * @param multiplier - Scaling factor applied to every measured value.
 * @returns Rows aligned with MAIN_COLUMNS.
 */
// Génération mensuelle des faits sur la plage temporelle demandée
function buildMainRows(
  countries: string[],
  indicators: readonly string[],
  start: Date,
  end: Date,
  multiplier: number,
): unknown[][] {
  const rows: unknown[][] = [];
  for (const country of countries) {
    for (const indicator of indicators) {
      for (const kind of KINDS) {
        const current = new Date(start);
        while (current <= end) {
          rows.push(mainRow(country, indicator, kind, new Date(current), multiplier));
          current.setMonth(current.getMonth() + 1);
        }
      }
    }
  }
  return rows;
}

/**
 * Builds the fact rows of the `geography` schema.
 *
 * @returns Rows aligned with GEOGRAPHY_COLUMNS.
 */
// Génération des faits géographiques, un point par nœud et par année
function buildGeographyRows(): unknown[][] {
  const rows: unknown[][] = [];
  const dates = ['2023-01-01', '2024-01-01'];

  GEOGRAPHY_TREE.forEach(([region, departement, commune], index) => {
    dates.forEach((date, yearIndex) => {
      const population = BigInt(25_000 + index * 40_000 + yearIndex * 1_500);
      const area = 120.5 + index * 35.25;
      // La densité est laissée à NULL sur les nœuds sans commune (arbre irrégulier)
      const density = commune === null ? null : Number(population) / area;
      rows.push([
        region,
        departement,
        commune,
        date,
        population,
        area,
        // BIGINT au-delà de 2^53 pour vérifier la sérialisation des grands entiers
        9007199254740995n + BigInt(index),
        density,
        commune !== null && index % 2 === 0,
      ]);
    });
  });

  return rows;
}

/**
 * Builds the fact rows of a `trade` schema.
 *
 * Every label is a function of its code (one label per code, NULL included),
 * so the rows honour the functional dependency the writer guarantees.
 *
 * @param codes - nc8 codes with their nc6 parent and labels.
 * @param partners - Partner codes and labels.
 * @param years - Observation years.
 * @param multiplier - Scaling factor applied to every measured value.
 * @returns Rows aligned with TRADE_COLUMNS.
 */
// Génération des échanges, une ligne par code, partenaire et année
function buildTradeRows(
  codes: TradeCode[],
  partners: Array<[number, string]>,
  years: number[],
  multiplier: number,
): unknown[][] {
  const rows: unknown[][] = [];
  codes.forEach((code, codeIndex) => {
    partners.forEach(([partnerCode, partnerLabel], partnerIndex) => {
      years.forEach((year, yearIndex) => {
        const value = (1000 * (codeIndex + 1) + 100 * partnerIndex + 10 * yearIndex) * multiplier;
        rows.push([
          code.nc6,
          code.nc6Libelle,
          code.nc8,
          code.en,
          code.fr,
          partnerCode,
          partnerLabel,
          year,
          value,
          value / 4,
        ]);
      });
    });
  });
  return rows;
}

/**
 * Builds the SchemaSpec of a `trade` schema.
 *
 * @param alias - Catalog alias, quoted in the dataset source.
 * @param rows - Fact rows aligned with TRADE_COLUMNS.
 * @returns The schema specification.
 */
// Assemblage d'un schéma « trade »
function tradeSpec(alias: string, rows: unknown[][]): SchemaSpec {
  return {
    metadata: TRADE_METADATA,
    datasetMetadata: {
      label: `Échanges par produit — ${alias}`,
      description: 'Échanges par code NC8 et pays partenaire',
      source: `test-fixture:${alias}.trade`,
      updatedAt: '2026-09-01 04:45:00',
      schemaVersion: 1,
      clusterBy: TRADE_CLUSTER_BY,
    },
    rows,
  };
}

// ─── Écriture d'un schéma ──────────────────────────────────────────────────────

/**
 * Inserts rows into a staging table in batches, then copies them into the fact
 * table sorted by cluster_by — exactly what the real writer does (spec §5.3).
 *
 * @param conn - Active DuckDB connection.
 * @param qualified - Fully qualified fact table name.
 * @param rows - Rows aligned with the fact table's column order.
 * @param clusterBy - Physical sort columns.
 */
// Écriture triée : staging temporaire puis INSERT ... ORDER BY cluster_by
async function insertFactRows(
  conn: Connection,
  qualified: string,
  rows: unknown[][],
  clusterBy: string[],
): Promise<void> {
  if (rows.length === 0) return;

  await conn.run(`CREATE OR REPLACE TEMP TABLE staging_fact AS SELECT * FROM ${qualified} LIMIT 0`);

  const columnCount = rows[0].length;
  const placeholder = `(${Array(columnCount).fill('?').join(', ')})`;
  const batchSize = 200;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    await conn.run(
      `INSERT INTO staging_fact VALUES ${batch.map(() => placeholder).join(', ')}`,
      batch.flat(),
    );
  }

  await conn.run(
    `INSERT INTO ${qualified} SELECT * FROM staging_fact ORDER BY ${clusterBy.join(', ')}`,
  );
  await conn.run('DROP TABLE staging_fact');
}

/**
 * Creates the three tables of one schema and fills them.
 *
 * @param conn - Active DuckDB connection.
 * @param alias - Alias of the already-attached catalog.
 * @param schema - Schema name to create inside the catalog.
 * @param columns - Fact table column definitions.
 * @param spec - Metadata, dataset metadata, and fact rows of the schema.
 * @param withDatasetMetadata - False to omit dataset_metadata entirely, which
 *   reproduces a catalog written in the legacy format (version guard fixture).
 */
// Création des trois tables du schéma (spec §2) : aucune table dim_*
async function createSchema(
  conn: Connection,
  alias: string,
  schema: string,
  columns: string,
  spec: SchemaSpec,
  withDatasetMetadata: boolean = true,
): Promise<void> {
  const qualify = (table: string): string => `"${alias}".${schema}.${table}`;

  if (schema !== 'main') {
    await conn.run(`CREATE SCHEMA IF NOT EXISTS "${alias}".${schema}`);
  }

  // Table metadata — contrat entre la base et l'interface (spec §2.2)
  await conn.run(`
    CREATE TABLE ${qualify('metadata')} (
      name                VARCHAR NOT NULL,
      label               VARCHAR NOT NULL,
      sql_type            VARCHAR NOT NULL,
      is_primary_key      BOOLEAN NOT NULL,
      is_categorical      BOOLEAN NOT NULL,
      parent_name         VARCHAR,
      label_for           VARCHAR,
      unit                VARCHAR,
      display_format      VARCHAR,
      family              VARCHAR,
      description         VARCHAR,
      default_aggregation VARCHAR
    )
  `);

  // Table dataset_metadata — exactement une ligne par schéma (spec §2.3).
  // Son absence est volontaire dans la fixture de l'ancien format.
  if (withDatasetMetadata) {
    await conn.run(`
    CREATE TABLE ${qualify('dataset_metadata')} (
      label          VARCHAR,
      description    VARCHAR,
      source         VARCHAR,
      updated_at     TIMESTAMP,
      schema_version INTEGER,
      cluster_by     VARCHAR
    )
  `);
  }

  await conn.run(`CREATE TABLE ${qualify('fact_table')} (${columns})`);

  for (const row of spec.metadata) {
    await conn.run(
      `INSERT INTO ${qualify('metadata')}
         (name, label, sql_type, is_primary_key, is_categorical, parent_name,
          label_for, unit, display_format, family, description, default_aggregation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.name,
        row.label,
        row.sqlType,
        row.isPrimaryKey,
        row.isCategorical,
        row.parentName,
        row.labelFor,
        row.unit,
        row.displayFormat,
        row.family,
        row.description,
        row.defaultAggregation,
      ],
    );
  }

  const info = spec.datasetMetadata;
  if (withDatasetMetadata) {
    await conn.run(
      `INSERT INTO ${qualify('dataset_metadata')}
         (label, description, source, updated_at, schema_version, cluster_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        info.label,
        info.description,
        info.source,
        info.updatedAt,
        info.schemaVersion,
        JSON.stringify(info.clusterBy),
      ],
    );
  }

  await insertFactRows(conn, qualify('fact_table'), spec.rows, info.clusterBy);

  console.log(`  [${alias}.${schema}] ${spec.rows.length} records inserted`);
}

/**
 * Builds the SchemaSpec of a `main`-like schema.
 *
 * @param label - Dataset label exposed by dataset_metadata.
 * @param source - Dataset source.
 * @param rows - Fact rows aligned with MAIN_COLUMNS.
 * @returns The schema specification.
 */
// Assemblage d'un schéma de type « main » (métadonnées communes + données propres)
function mainSpec(label: string, source: string, rows: unknown[][]): SchemaSpec {
  return {
    metadata: MAIN_METADATA,
    datasetMetadata: {
      label,
      description: "Série mensuelle d'indicateurs économiques par pays",
      source,
      updatedAt: '2026-09-01 04:30:00',
      schemaVersion: 1,
      clusterBy: MAIN_CLUSTER_BY,
    },
    rows,
  };
}

// ─── Création d'un catalogue ───────────────────────────────────────────────────

/**
 * Creates a DuckLake catalog holding a single `main` schema.
 *
 * Deletes any existing catalog and data directory before recreation.
 *
 * @param conn - Active DuckDB connection.
 * @param alias - SQL alias for the attached catalog.
 * @param catalogPath - Absolute path to the .ducklake metadata file.
 * @param dataPath - Absolute path to the Parquet data directory.
 * @param valueMultiplier - Scaling factor applied to all generated fact values.
 */
// Création d'un catalogue et de son schéma principal
async function createCatalog(
  conn: Connection,
  alias: string,
  catalogPath: string,
  dataPath: string,
  valueMultiplier: number = 1.0,
): Promise<void> {
  // Suppression des artefacts existants avant recréation
  if (fs.existsSync(catalogPath)) {
    fs.unlinkSync(catalogPath);
  }
  if (fs.existsSync(dataPath)) {
    fs.rmSync(dataPath, { recursive: true, force: true });
  }
  fs.mkdirSync(dataPath, { recursive: true });

  // Attachement du nouveau catalogue DuckLake
  await conn.run(`ATTACH 'ducklake:${catalogPath}' AS "${alias}" (DATA_PATH '${dataPath}/')`);

  // Les catalogues partagent les libellés de COUNTRIES (tests compare*) et
  // ajoutent chacun un pays qui leur est propre (libellés disjoints).
  const countries = [...COUNTRIES, DISJOINT_COUNTRY[alias]];
  const rows = buildMainRows(
    countries,
    INDICATORS,
    new Date('2022-01-01'),
    new Date('2024-12-01'),
    valueMultiplier,
  );

  // Ligne unique commune à tous les catalogues, à valeur nulle dans `default` :
  // elle rend deltaPercent indéterminé sans polluer le reste du jeu de données.
  rows.push(
    mainRow(ZERO_COUNTRY, INDICATORS[0], 'Actual', new Date('2024-01-01'), 1.0, {
      value: alias === 'default' ? 0 : 42,
    }),
  );

  await createSchema(
    conn,
    alias,
    'main',
    MAIN_COLUMNS,
    mainSpec(`Indicateurs — ${alias}`, `test-fixture:${alias}`, rows),
  );
}

// ─── Point d'entrée principal ──────────────────────────────────────────────────

/**
 * Orchestrates the creation of all test DuckLake catalogs.
 *
 * Creates a shared in-memory DuckDB instance, installs the DuckLake extension
 * if needed, then creates the default (main + predictions + geography +
 * trade), macroeconomics (main + trade), and public_finance catalogs.
 */
async function setupTestData(): Promise<void> {
  // Création du répertoire de données de test si absent
  const dataDir = path.resolve(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();

  try {
    // Chargement de l'extension DuckLake avec installation automatique si nécessaire
    try {
      await conn.run('LOAD ducklake;');
    } catch (_) {
      await conn.run('FORCE INSTALL ducklake FROM community; LOAD ducklake;');
    }

    // Catalogue par défaut
    await createCatalog(
      conn,
      'default',
      path.resolve(dataDir, 'test-default.ducklake'),
      path.resolve(dataDir, 'test-default_data'),
      1.0,
    );

    // Second schéma `predictions` : mêmes LIBELLÉS que `main` (la fact table les
    // porte directement, il n'y a plus d'identifiant à réconcilier) plus un pays
    // disjoint, pour les comparaisons cross-schéma.
    await createSchema(
      conn,
      'default',
      'predictions',
      MAIN_COLUMNS,
      mainSpec(
        'Prévisions — default',
        'test-fixture:default.predictions',
        buildMainRows(
          [...COUNTRIES.slice(0, 3), DISJOINT_COUNTRY.predictions],
          INDICATORS.slice(0, 3),
          new Date('2024-01-01'),
          new Date('2024-03-01'),
          1.0,
        ),
      ),
    );

    // Troisième schéma `geography` : hiérarchie de colonnes region → departement
    // → commune (spec §2.5), arbre irrégulier et libellé à apostrophe.
    await createSchema(conn, 'default', 'geography', GEOGRAPHY_COLUMNS, {
      metadata: GEOGRAPHY_METADATA,
      datasetMetadata: {
        label: 'Territoires',
        description: 'Population et budget par niveau géographique',
        source: 'test-fixture:default.geography',
        updatedAt: '2026-09-01 04:35:00',
        schemaVersion: 1,
        clusterBy: GEOGRAPHY_CLUSTER_BY,
      },
      rows: buildGeographyRows(),
    });

    // Quatrième schéma `trade` : codes NC6 → NC8 et code numérique, chacun doté
    // de colonnes de libellés (spec §2.6)
    await createSchema(
      conn,
      'default',
      'trade',
      TRADE_COLUMNS,
      tradeSpec('default', buildTradeRows(TRADE_CODES_DEFAULT, TRADE_PARTNERS, [2023, 2024], 1.0)),
    );

    // Deux schémas VOLONTAIREMENT non conformes, réservés au test de la garde
    // de version. Ils ne décrivent aucun format réel : le premier annonce une
    // version que l'API ne supporte pas, le second reproduit un catalogue
    // écrit avant l'existence de dataset_metadata.
    const guardRows = buildMainRows(
      COUNTRIES.slice(0, 2),
      INDICATORS.slice(0, 1),
      new Date('2024-01-01'),
      new Date('2024-02-01'),
      1.0,
    );

    await createSchema(conn, 'default', 'unsupported_version', MAIN_COLUMNS, {
      ...mainSpec('Version non supportée', 'test-fixture:guard', guardRows),
      datasetMetadata: {
        label: 'Version non supportée',
        description: 'Fixture de la garde de version — schema_version hors liste',
        source: 'test-fixture:guard',
        updatedAt: '2026-09-01 04:40:00',
        schemaVersion: 99,
        clusterBy: MAIN_CLUSTER_BY,
      },
    });

    await createSchema(
      conn,
      'default',
      'missing_dataset_metadata',
      MAIN_COLUMNS,
      mainSpec('Ancien format', 'test-fixture:guard', guardRows),
      false,
    );

    // Catalogue macroéconomie
    await createCatalog(
      conn,
      'macroeconomics',
      path.resolve(dataDir, 'test-macroeconomics.ducklake'),
      path.resolve(dataDir, 'test-macroeconomics_data'),
      1.05,
    );

    // Schéma `trade` du second catalogue : codes nc8 en partie partagés (compareFacts)
    await createSchema(
      conn,
      'macroeconomics',
      'trade',
      TRADE_COLUMNS,
      tradeSpec(
        'macroeconomics',
        buildTradeRows(TRADE_CODES_MACRO, TRADE_PARTNERS.slice(0, 2), [2024], 1.05),
      ),
    );

    // Catalogue finances publiques
    await createCatalog(
      conn,
      'public_finance',
      path.resolve(dataDir, 'test-public-finance.ducklake'),
      path.resolve(dataDir, 'test-public-finance_data'),
      0.93,
    );
  } finally {
    // closeSync ne libère pas le verrou Windows sur le fichier SQLite de DuckLake.
    // Le processus se termine immédiatement après, libérant tous les descripteurs.
    instance.closeSync();
  }
}

// Exécution directe uniquement si ce fichier est le point d'entrée principal
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  setupTestData()
    .then(() => {
      console.log('Test DuckLake catalogs ready.');
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error('Failed to set up test data:', error);
      process.exit(1);
    });
}

export { setupTestData };
export default setupTestData;
