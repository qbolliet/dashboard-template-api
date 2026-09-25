# Revue technique — API GraphQL (dashboard-template-api)

> Rédaction : juillet 2026 ; **révision : septembre 2026** (alignement sur la base
> reformatée). Périmètre : ce dépôt (API GraphQL Apollo Server 5 + Express 5 +
> `@duckdb/node-api`). Document compagnon de
> `../dashboard-template-database/specification-bdd.md` (spécification de référence
> de la base, dépôt `dt-ducklake-manager` ; ses §2 et §8 fixent le schéma et les
> impacts API). Il répond aux questions posées sur l'API, analyse le code existant et
> sert de **spécification cible** pour la série de prompts
> (`prompts-migration-api-v2.md`).
>
> **Mode de travail** : Claude Code n'effectue **aucun commit** (ni `git add`, ni
> `push`) en exécutant la série de prompts. Le travail de chaque prompt reste dans
> l'arbre de travail pour relecture ; le résumé de fin de prompt **propose** un message
> de commit conventionnel, et le commit est fait à la main avant le prompt suivant. Les
> conventions de commit citées plus bas (`feat!:`, `fix:`…, §5.3) restent la règle pour
> ces messages proposés : c'est elles que release-please lit.
>
> **Terminologie** : la spécification bdd nomme le nouveau schéma **« version 1 »**
> (`dataset_metadata.schema_version = 1`, projet non publié, aucune migration). Ce
> document parlait de « schéma v2 » : ce terme est abandonné au profit de **« schéma
> v1 »** ; la refonte de l'API sort en **0.3.0** (cf. §5.3).
>
> **Ajout du 2026-09-22 — codes et libellés** : la spec bdd a gagné un §2.6
> (`metadata.label_for`, un code métier et son libellé en deux colonnes de la fact
> table). Impacts API au §5.8 ; prompt 6 de la série, inséré après les prompts 1 à 5
> déjà exécutés.

---

## 0. Révision de septembre 2026 — écarts avec la base reformatée

La version de juillet anticipait un schéma de base qui a évolué pendant son
implémentation. Écarts constatés entre ce document (version de juillet), les prompts,
et la spécification bdd effectivement implémentée (`dt-ducklake-manager` 0.3.x) :

| Hypothèse de juillet                                                                    | Réalité de la base                                                                                                           | Conséquence pour l'API                                                                                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Tables `dim_*` **opt-in** (label_maps, hiérarchies de valeurs `path/depth`)             | **Aucune table `dim_*`**, jamais (spec bdd §1.2, §2.5 « non retenu »)                                                        | Supprimer toute détection de dim, `getSelectOptionsFlat`, `HierarchicalOption`, LEFT JOIN de labels, tables dim du setup de test |
| `schema_version = 2`, garde « `< 2` → erreur »                                          | `schema_version = 1`                                                                                                         | La garde de juillet aurait rejeté **tous** les catalogues. Garde : version ∈ versions supportées (`[1]`)                         |
| Dépréciation douce (`@deprecated` une version)                                          | « Supprimés, pas de dépréciation, le projet n'est pas publié » (spec bdd §8)                                                 | Retrait direct de `getDimensionTable`, `dimensionDetails`, `keyLabel`, `dimensionNames`, `Dimension`                             |
| `getGroupedSelectOptions` refondu en `[{group, options}]` + `getSelectOptionsFlat/Tree` | **`getSelectOptionsTree` (JSON) remplace `getGroupedSelectOptions`**, seule forme hiérarchique                               | Une seule query hiérarchique ; le group-options du frontend = arbre à 2 niveaux (§5.1)                                           |
| Hiérarchie de colonnes régulière                                                        | Chaîne `parent_name` de profondeur quelconque ; **niveaux absents = `NULL`**, la branche s'arrête au premier `NULL`          | L'arbre ignore les `NULL` ; jamais de nœud vide fabriqué                                                                         |
| `dataset_metadata` sans tri physique                                                    | Colonne `cluster_by` (JSON) : ordre physique d'écriture                                                                      | Tri par défaut déterministe et bon marché pour la pagination (§5.7)                                                              |
| Types « numérique / date / texte »                                                      | `TINYINT…UBIGINT` (non signés inclus), `FLOAT`, `DOUBLE`, `BOOLEAN`, `DATE`, `TIMESTAMP`, `VARCHAR`                          | Familles de types du `treeToSQL` à compléter (booléen, non signés) ; sérialisation `BIGINT` à garantir (§5.6)                    |
| Stats de colonnes lisibles dans le catalogue DuckLake                                   | `ducklake_file_column_stats` est **par fichier**, ignore les lignes **inlinées**, et reste large après `DELETE`              | `getFieldStats` = `MIN/MAX` SQL (exact) ; pas de raccourci par le catalogue (§4)                                                 |
| `metadata.label`, `sql_type`, booléens : nullables                                      | `NOT NULL` garantis par le writer                                                                                            | SDL plus strict : `label: String!`, `sqlType: String!`, `isCategorical: Boolean!`, `isPrimaryKey: Boolean!`                      |
| Suppression de `dimensionDetails` sans effet de bord                                    | Dans le code, `dimensionDetails` porte **les colonnes-clés** (`dimension-enrichment.ts` : clé ⇒ dimension, non-clé ⇒ mesure) | Le retirer sans remplacement ferait **disparaître les coordonnées** de `getFactTable` → `Fact { keys, measures }` (§5.1)         |

Constats supplémentaires, indépendants de la base :

- `docs-site/static/schema.graphql` est **gitignoré** (`.gitignore:9`) : le
  `git show <tag>:docs-site/static/schema.graphql` prévu pour le diff de schéma
  échouerait. C'est un artefact du build de la doc, réécrit à chaque build : il reste
  ignoré, et un SDL distinct, suivi, est ajouté à la racine (§5.3). C'est aussi ce SDL périmé (encore
  l'argument `database`) que le frontend a failli vendorer pour son serveur de mock.
- La pagination par offset n'a **aucun tri par défaut** (`buildSortClause` renvoie
  `''` sans `sort`) : sous DuckDB (scan parallèle), deux pages successives ne sont pas
  garanties disjointes (§5.7).
- `getRowObjectsJson()` de `@duckdb/node-api` convertit les types non représentables
  exactement en JSON (`BIGINT`, `HUGEINT`, `DECIMAL`) en **chaînes** : les colonnes
  `BIGINT` — type par défaut d'un `Int64` pandas/polars côté producteur — sortent
  probablement en chaînes et sont ignorées par le calcul des `extents` (filtre
  `typeof v === 'number'`, `src/db/pool.ts:643-651`). À vérifier par un test, puis
  corriger (§5.6).

Les sections suivantes sont mises à jour en conséquence.

---

## 1. GraphQL était-il le bon choix ?

**Oui — choix défendable, à conserver, mais à compléter par du REST pour l'export.**
Votre lecture (« je ne perds pas grand-chose à utiliser GraphQL ») est globalement
juste, à condition d'être lucide sur ce que le code utilise _réellement_ de GraphQL.

### Ce que votre code exploite vraiment de GraphQL (vérifié)

- **La projection de colonnes**, votre argument principal, est effective de bout en
  bout : l'argument `fields` pilote le `SELECT` SQL (`FactLoader.loadFacts`,
  `src/loaders/fact.ts:108`, via `buildSelectClause`, `src/loaders/base-loader.ts:289`)
  et l'enrichissement ne construit `measures` que sur les colonnes effectivement
  sélectionnées (`src/utils/dimension-enrichment.ts:112-116`). Pas de surcoût réseau
  **ni** SQL. Une honnêteté s'impose toutefois : cette projection est pilotée par un
  _argument_, pas par le selection set GraphQL — un REST avec `?fields=a,b` ferait
  pareil. Le selection set, lui, gouverne la _forme_ de la réponse (demander ou non
  `measures`, `keys`, `metadata`, `total`...), et là GraphQL apporte réellement
  quelque chose (le `COUNT(*)` de `total` pourrait n'être exécuté que s'il est
  demandé).
- **Un point d'entrée unique multi-sources** : plusieurs catalogues/schémas servis par
  le même endpoint, avec composition (`compareFacts`, `getSharedFields`).
- **Le contrat typé introspectable** : toute votre chaîne de documentation (SDL généré,
  graphql-markdown, voyager) et le futur codegen découlent gratuitement du schéma.
- **Le chargement paresseux par selection set** : `getCatalogs` ne charge
  `fields` que si demandés (`src/schema/typedefs/catalog.ts:20-27`) — idiome GraphQL
  propre, impossible à exprimer aussi simplement en REST. Le même mécanisme servira
  `CatalogSchemaInfo.info` (métadonnées de jeu de données) et `Metadata.stats`.

### Ce que GraphQL vous coûte (et que vous avez déjà payé)

- **La sécurité spécifique** (analyse de complexité, profondeur, sanitization) : un
  REST paramétré n'en aurait pas eu besoin à ce niveau. Mais `src/security/` est écrit,
  configuré (`config/security.yaml`) et testé — coût amorti.
- **Le cache HTTP** : des POST non cachables par les intermédiaires, compensés par
  votre cache Redis applicatif — coût amorti aussi.
- **Le streaming binaire** : impossible proprement en GraphQL ; c'est exactement le
  trou que votre endpoint REST Arrow/CSV vient boucher (§5.2).
- À noter honnêtement : la partie « graphe » de GraphQL (résolution imbriquée,
  batching DataLoader anti-N+1) est peu sollicitée — vos données sont tabulaires et
  vos resolvers sont de type RPC (`getFactTable`, `getAggregatedFacts`...). La
  disparition des tables de dimension réduit encore ce besoin (plus de résolution de
  labels). L'avantage net de GraphQL est donc _modéré_, mais les coûts étant déjà
  payés et les bénéfices (projection, contrat, outillage) réels, **une migration vers
  REST serait une pure perte**.

### Sur vos deux questions précises

- **« GraphQL simplifie les associations entre schémas »** : nuance. Les jointures
  cross-schéma sont faites **en SQL dans les loaders** (`src/loaders/cross-database.ts`),
  pas par la composition GraphQL — un endpoint REST `/compare` ferait la même chose.
  Le bénéfice réel est l'_unicité de surface_ : un seul schéma typé qui expose à la
  fois les données, les métadonnées et les comparaisons. C'est un bon point, mais ce
  n'est pas un argument « GraphQL-only ». La spec bdd renforce ce point : « un
  résultat porté par une autre clé est un autre schéma » — la composition de schémas
  de clés différentes est donc un usage normal, que l'API porte.
- **La citation REST vs GraphQL** : vos trois critères (bande passante, sources
  multiples, requêtes clients très variables) sont précisément ceux d'un dashboard
  data-driven multi-catalogues. Ce que vous « perdez » (cache HTTP, streaming,
  simplicité sécurité) est identifié et couvert (Redis, endpoint REST, `src/security/`).

### Alternatives écartées — d'accord avec vous

- **Cube.js** : le _concept_ (couche sémantique pilotant l'UI) est exactement le vôtre —
  mais votre table `metadata` **est** déjà cette couche sémantique, en plus simple et
  sous votre contrôle (la spec bdd l'érige en « contrat entre la base et
  l'interface »). La renforcer vaut mieux que d'adopter une dépendance dont la
  pérennité vous inquiète à raison.
- **Hasura / PostgREST** : centrés Postgres, support DuckDB/DuckLake inexistant ou
  exotique ; vous perdriez le contrôle de la couche sécurité et du cache.
- **REST + OData/JSON:API** : mature, mais vous auriez recodé à la main la projection,
  le typage et l'introspection que GraphQL vous donne.

**Verdict : architecture hybride GraphQL (requêtes dashboard) + REST (admin, export
volumineux) — c'est le pattern standard des grosses API publiques (GitHub, Shopify),
et c'est exactement la direction que vous proposez.**

---

## 2. Auth / quotas : votre analyse cible est la bonne — mais la défense actuelle n'est pas celle que vous croyez

D'accord sur le fond : données publiques, utilisateurs naïfs plutôt que malveillants —
pas besoin d'API keys ni de quotas individuels, le rate limit par IP est le bon niveau
de protection. **Mais l'exploration du code révèle un écart important entre la
sécurité écrite et la sécurité active :**

### Ce qui est réellement actif au runtime

- Limite de profondeur (validation rule, `src/server.ts:379-381`) : 15 en dev, 7 en
  prod (`config/security.yaml:2-4`) ;
- `securityManager.validateRequest` dans le plugin Apollo (`src/server.ts:302-308`) :
  validation de patterns interdits et **blocage des mutations/subscriptions** ;
- Clé admin (`requireAdminKey`, header `x-admin-key`) sur les endpoints d'écriture
  REST (`/api/cache/*`, `/api/catalog/reload*`) — le bon réglage ;
- CORS restreint, en-têtes HSTS/nosniff/DENY, compression, timeouts applicatifs ;
- Catalogues attachés en `READ_ONLY` (`src/db/pool.ts:85`) — conforme à la règle
  multi-catalogues de la spec bdd §7 (lecture multi-catalogues explicite et
  `READ_ONLY`, requêtes qualifiées `"catalog"."schema"."table"`).

### Ce qui est codé mais **jamais branché**

Le **rate limiter par IP**, l'**analyseur de complexité** et la **sanitization
XSS/SQL** ne vivent que dans `SecurityManager.createSecurityMiddleware`
(`src/security/manager.ts:119-180`)... qui n'est appliqué nulle part : le schéma est
construit par un simple `makeExecutableSchema` sans middleware, et
`createSecurityMiddleware` n'est référencé que par `manager.ts` et ses tests. Autrement
dit : **votre API publique tourne aujourd'hui sans aucun rate limiting effectif**, et
les scores de complexité de `config/security.yaml` sont décoratifs.

C'est le correctif n°1 de la série de prompts : brancher (ou re-brancher) le rate
limiting au niveau Express et trancher ce qu'on active de la complexité — _avant_
d'ajouter l'endpoint d'export, qui aggraverait l'exposition.

### Deux entrées contournent en plus toute validation

1. L'argument `filters: String` est un **prédicat SQL brut** injecté tel quel dans le
   `WHERE` (`src/utils/utils.ts:48-49` : `whereClause += '(${filters})'`). La docstring
   dit « trusted upstream » — sur une API publique, il n'y a pas d'upstream de
   confiance. Même sans attaquant : un front bugué peut produire du SQL arbitraire.
2. Dans `structuredFilters`, la `key` est validée et les `value` échappées, mais
   **l'`operator` est interpolé sans liste blanche** (`src/utils/utils.ts:78,85,91,95`).
   `operator: "= 1 OR (SELECT ...)"` passe tel quel.
3. S'y ajoute l'argument `fields`, concaténé dans le `SELECT` **sans passer par
   `validateIdentifier`** (`src/loaders/base-loader.ts:289-291` :
   `fields.join(', ')`) — troisième surface d'injection.

La surface est en lecture seule, mais cela permet de lire d'autres schémas, de
contourner les gardes et de fabriquer des requêtes coûteuses. Correction retenue
(décision post-revue) : **suppression pure et simple de `filters`**, remplacement de
`structuredFilters` par un **arbre de filtres** aligné sur le `MultiCriterionMenu` du
frontend et converti côté serveur par un `treeToSQL` durci (spécifié au §5.5), plus
validation de `fields` — prompt 1.

**Dernière réserve** : le futur endpoint d'export échappe par nature aux gardes
GraphQL ; il lui faut ses propres garde-fous (plafond de lignes, streams concurrents
par IP, timeout) — intégrés au prompt d'export.

---

## 3. Filtrer une mesure : c'est déjà possible

Réponse précise à votre question :

- **Filtrer les lignes sur une valeur de mesure : oui, déjà supporté.**
  `buildWhereClause` ne fait aucune distinction clé primaire / mesure — n'importe
  quelle colonne passe : `structuredFilters: [{key: "value", operator: ">", value:
"0.5"}]` fonctionne sur toutes les queries de faits. (La forme plate `[Filter]`
  disparaît dans la refonte au profit de l'arbre du §5.5 — la capacité, elle, est
  conservée et étendue au OR parenthésé.)
- **Restreindre les mesures retournées : oui, déjà supporté** via l'argument `fields`
  (projection SQL réelle, cf. §1 — `fields` absent → `SELECT *`). `Fact.measures` ne
  contient que les colonnes sélectionnées ayant `is_primary_key = false`
  (`src/utils/dimension-enrichment.ts:114-117`). Réserve : `fields` doit être validé
  (cf. §2.3).
- **Ce qui manque : le filtre post-agrégation (HAVING).** Aucun support dans
  `getAggregatedFacts` — impossible d'exprimer « les groupes dont la somme dépasse X ».
  À ajouter le jour où le besoin apparaît dans l'interface (un argument
  `having: FilterNode` restreint à la valeur agrégée) ; pas urgent, non inclus dans la
  série de prompts.
- Bémol mineur : le format `measures: [{name, value}]` est verbeux en JSON ; pour les
  tableaux volumineux, `getFactTableWithMetadata(format: ARRAYS)` répond déjà au
  besoin de compacité.

---

## 4. Frontend data-driven : état des lieux besoin par besoin

| Besoin UI                                                       | Aujourd'hui                                                                                                                                                                     | Reste à faire                                                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Liste colonnes + labels pour un select                          | ✅ `getFields` → `{value, label}`, filtrable par type/catégorie                                                                                                                 | Ajouter le filtre `family`                                                                                                           |
| Type d'une variable → opérateurs de filtre + type de menu       | ✅ `Metadata.sql_type`                                                                                                                                                          | Exposer `unit`, `displayFormat`, `family`, `description`, `defaultAggregation`, `parentName` en camelCase ; retirer `python_type`    |
| Min/max des numériques et dates (calibrage sliders/datepickers) | ❌ **Manque.** `DatasetMetadata.extents` n'est calculé que sur la _page retournée_ (`src/db/pool.ts:643-651`), uniquement pour les valeurs `number` — **jamais pour les dates** | ✅ Réalisé : `Metadata.stats` (lazy) et `getFieldStats` — voir ci-dessous                                                            |
| Modalités d'une catégorielle → select-menu                      | ✅ `getSelectOptions` (via `dim_*` si catégorielle)                                                                                                                             | `SELECT DISTINCT` sur la fact table uniquement, `label = value` ; erreurs remontées au lieu de `[]`                                  |
| Code métier affiché avec son libellé (nomenclature NC8)         | ❌ `label = value` partout                                                                                                                                                      | `value` = code, `label` = colonne de libellés (`labelFor`), recherche dans les deux, `keyLabel` sur les agrégats (§5.8)              |
| Données `Array[Row]` + méta pour graphiques / tableaux          | ✅ `getFactTableWithMetadata` (OBJECTS/ARRAYS, extents de page, total, pagination)                                                                                              | Métadonnées des colonnes retournées (`fields`), sérialisation garantie des types, extents de dates (§5.6)                            |
| Group-options / arbre de sélection                              | ⚠️ `getGroupedSelectOptions` retourne **deux listes indépendantes non corrélées** (`src/schema/resolvers/select-options.ts:95-103`)                                             | Remplacé par `getSelectOptionsTree` (JSON, chaîne `parentName`, profondeur quelconque) ; le group-options = arbre à 2 niveaux (§5.1) |
| Titre / description / fraîcheur d'un jeu de résultats           | ❌ Rien (`dataset_metadata` n'existait pas)                                                                                                                                     | `DatasetInfo` (label, description, source, updatedAt, schemaVersion)                                                                 |

### Min/max : matérialiser dans `metadata` ou calculer ?

**Ne pas matérialiser dans la table `metadata`.** C'est une donnée _dérivée_ : le
writer devrait la maintenir à chaque update (risque d'obsolescence silencieuse). La
spec bdd le confirme par principe : `metadata` contient ce que le producteur
_déclare_, jamais ce qui se déduit des données. Calculer à la demande :

1. **`SELECT MIN(col), MAX(col), COUNT(DISTINCT col), COUNT(*) - COUNT(col)`** sur la
   fact table : rapide sur du Parquet colonnaire, et très rapide sur les colonnes de
   `cluster_by` (données triées, statistiques de row groups serrées). C'est la voie
   retenue, exacte par construction.
2. Les statistiques DuckLake (`ducklake_file_column_stats`, _mesurées_ par la spec bdd
   §5.3) ne sont **pas** un raccourci fiable : elles sont **par fichier** (agrégation
   à faire), ne couvrent pas les lignes **inlinées** dans le catalogue (petits updates,
   spec bdd §5.2), et restent des bornes larges après `DELETE` (le fichier n'est pas
   réécrit tant que `rewrite_data_files` ne passe pas). Écartées.

**Design recommandé** : un champ `stats: FieldStats` (min, max, distinctCount,
nullCount) sur le type `Metadata`, **résolu paresseusement** (calculé seulement si
présent dans le selection set), avec cache Redis long — invalidé par le flux existant
(votre updater nocturne appelle déjà `/api/cache/invalidate-all`, la fraîcheur est
donc garantie par construction). Le front récupère alors colonnes + types + bornes en
**une seule requête** `getCatalogSchema`. En complément : une query `getFieldStats`
acceptant un `FilterNode` pour recalibrer les sliders après filtrage.

**Réalisé (prompt 8).** Un seul chemin de calcul (`src/loaders/field-stats.ts`) :
`SELECT MIN(col), MAX(col), COUNT(DISTINCT col), COUNT(*) - COUNT(col) FROM fact_table
[WHERE …]`, colonne validée par `validateIdentifier` et contrôlée contre la table
`metadata` (colonne inconnue → `BAD_USER_INPUT`), filtre compilé par `treeToSQL`,
valeurs sérialisées par le convertisseur unique du §5.6 (entier au-delà de 2^53 en
chaîne exacte, `DATE` en `YYYY-MM-DD`, `TIMESTAMP` en ISO). Sur une colonne texte ou
booléenne, `min`/`max` sont calculés aussi (ordre lexical ; `false` < `true`) : ils
n'ont pas de sens de calibrage. Le champ `Metadata.stats` et la query `getFieldStats`
partagent le même loader, donc la même clé de cache pour la variante non filtrée.
Chaque resolver qui produit un `Metadata` y attache `_catalog` / `_schema`
(`src/schema/resolvers/scope.ts`, champs internes absents du SDL) : `getMetaData`,
`getCatalogSchema`, `CatalogSchemaInfo.fields`, `DatasetWithMetadata.fields`,
`groupByFieldInfo` et `measureFieldInfo` ; un `Metadata` sans scope échoue
explicitement au lieu de deviner le catalogue. TTL : `SELECT_OPTIONS_CACHE_TIMEOUT`
sans filtre, `FACT_CACHE_TIMEOUT` avec filtre (hook `cacheTimeoutFor` de
`BaseQueryLoader`). Coût : `stats` = N requêtes pour N colonnes sélectionnées, d'où
les scores `stats: 10` et `getFieldStats: 5` dans `config/security.yaml`. Les clés
`field-stats:<catalogue>:<schéma>:…` sont couvertes par les motifs d'invalidation
(`keyPatterns.fieldStats` et `allCatalog`) — sous réserve du point 9 du §6.

---

## 5. Vos modifications commentées

### 5.1 Adaptation au schéma v1 de la base (Metadata, select-options, compare\*)

La base (spec bdd §1-2) repose sur trois principes qui simplifient fortement l'API :
**la fact table stocke les libellés** (plus de codes, plus aucune table `dim_*`),
**`metadata` est le contrat d'interface**, **les hiérarchies sont des chaînes de
colonnes** (`parent_name`). Conséquences, dans l'ordre d'importance :

- **Suppression de toute la couche dimension, sans dépréciation** (spec bdd §8 : projet
  non publié). Disparaissent : `getDimensionTable`, le type `Dimension`,
  `CatalogSchemaInfo.dimensionNames`, `Fact.dimensionDetails`, `DimensionDetail`,
  `AggregatedFact.keyLabel`, `ComparedFact.keyLabel`, le loader `dimension` et le
  routage `is_categorical → dim_<col>` de `SelectOptionsLoader`. `getSelectOptions`
  garde sa signature mais devient un `SELECT DISTINCT` pur sur la fact table.
- **Piège à éviter sur `Fact`** : `enrichFactsWithDimensions` range dans
  `dimensionDetails` **toutes les colonnes-clés** (catégorielles ou non : dates,
  identifiants numériques). La skill `dashboard-api-client` affirme que « `measures`
  seul suffit » : c'est faux dans le code actuel, les coordonnées disparaîtraient de
  `getFactTable`. Décision (validée le 2026-09-19) :
  `type Fact { keys: [FieldValue!]!, measures: [FieldValue!]! }` avec
  `type FieldValue { name: String!, value: JSON }` (renommage de `Measure`, qui
  n'aurait plus de sens pour une clé), la partition restant pilotée par
  `metadata.is_primary_key`, sans aucune requête supplémentaire.
- **`getSelectOptionsTree` remplace `getGroupedSelectOptions`** (spec bdd §8) :
  scalaire `JSON` `[{value, label, children?}]` construit par `SELECT DISTINCT` sur la
  chaîne de colonnes remontée via `parentName`, `NULL` terminant une branche. Le JSON
  est la **seule** forme hiérarchique (GraphQL n'exprime pas une profondeur
  arbitraire ; `getSelectOptionsFlat` et `HierarchicalOption` de juillet sont
  abandonnés : ils reposaient sur les dims hiérarchiques, non retenues). Sémantique
  validée le 2026-09-19 (la spec bdd donne la signature `(field, maxDepth, searchTerm)` sans la
  détailler) :
  - `fieldName` = niveau **le plus profond** affiché (argument nommé `fieldName` comme
    `getSelectOptions`, par cohérence — la skill écrit `field`) ;
  - `maxDepth` (défaut : toute la chaîne) = nombre de niveaux conservés **en
    remontant depuis `fieldName`** : sur `region → departement → commune`,
    `getSelectOptionsTree(fieldName: "commune", maxDepth: 2)` rend
    `[{departement, children: [communes]}]` — **c'est exactement le group-options du
    `SelectMenu`** ;
  - `searchTerm` filtre le niveau feuille (insensible à la casse) ; les ancêtres des
    feuilles retenues sont conservés ;
  - borne dure sur le nombre de nœuds (config), dépassement → erreur explicite
    invitant à utiliser `searchTerm` / `maxDepth` (pas de troncature silencieuse) ;
  - colonne sans `parentName` → arbre à un niveau (liste de nœuds sans `children`) ;
  - `label = value` à chaque niveau, **sauf** niveau doté d'une colonne de libellés
    (§5.8) : `label` = libellé (révision du 2026-09-22).

  Côté frontend, le mode groupé du `SelectMenu` attend
  `[{group: {value, label}, options: [...]}]` (fixture `MOCK_GROUPED_OPTIONS`) : le
  mapping depuis l'arbre à 2 niveaux est mécanique (`node → {group: {value, label},
options: node.children}`) ; c'est **le frontend qui s'adapte** (décision de la spec
  bdd). Le problème relevé dans `problèmes_additionnels_select_group_options.txt`
  (listes non corrélées) disparaît avec l'ancienne query.

- **`compareFacts` / `compareAggregatedFacts` / `crossDatabaseSelectOptions`** :
  jointure directe sur les colonnes (qui portent les libellés), plus de
  `getCategoricalMap` ni de CTE de résolution. `getSharedDimensions` est (décision validée) **renommé
  `getSharedFields`** (le concept de dimension n'existe plus ; fenêtre de rupture) et
  se résout par intersection des `metadata` (même `name`, `sqlType` compatible).
- **Collision de nom** : le schéma GraphQL a déjà un type `DatasetMetadata`
  (métadonnées de pagination, `src/schema/typedefs/fact.ts:67`). La table
  `dataset_metadata` est exposée sous le nom **`DatasetInfo`** (la section cible de la
  skill l'appelle `DatasetMetadata` : elle sera corrigée au prompt de documentation).
  Champs : `label`, `description`, `source`, `updatedAt` (ISO 8601), `schemaVersion`,
  `clusterBy: [String!]!` (liste JSON décodée ; utile au diagnostic et au tri par
  défaut §5.7).
- **Garde de version** : `schemaVersion` ∉ `SUPPORTED_SCHEMA_VERSIONS` (config,
  défaut `[1]`) ou table `dataset_metadata` absente (catalogue à l'ancien format) →
  `GraphQLError` `SCHEMA_VERSION_UNSUPPORTED` + warning à l'attach. Pas de double
  chemin de code.
- **camelCase** : le type `Metadata` est en snake_case (`python_type`,
  `is_categorical`...), contraire à la convention GraphQL. La refonte étant breaking,
  c'est LE moment de passer en camelCase (`sqlType`, `isCategorical`,
  `displayFormat`...). Les colonnes `NOT NULL` de la base deviennent non-nullables
  dans le SDL.
- **`defaultAggregation` a un consommateur côté API** : l'argument `aggregation` de
  `getAggregatedFacts*` (aujourd'hui `Aggregation! = SUM`) devient optionnel ; absent,
  il vaut `metadata.default_aggregation` de la mesure, puis `SUM`. L'enum `Aggregation`
  de l'API couvre déjà les sept valeurs de la base (`MEDIAN`, `MODE` inclus).

### 5.2 Export REST Arrow / CSV / Parquet

**Pleinement validé — c'est la bonne réponse** à la fois au plafond de pagination
(`MAX_OFFSET: 10000`, `config/api.yaml:39`) et à l'ordre de grandeur perdu en
sérialisation JSON. Design recommandé :

- `GET /api/export` (GET, pas POST : curlable, partageable, cacheable) avec
  `catalog`, `schema`, `fields`, `filters` (JSON d'un `FilterNode`), `sort`,
  `format=arrow|csv|parquet`.
- Content-Types : `application/vnd.apache.arrow.stream`, `text/csv`,
  `application/vnd.apache.parquet` + `Content-Disposition` avec nom de fichier daté.
- Réutilisation de `validateIdentifier` + `treeToSQL` **après** la sécurisation
  du §2 (le prompt 1 est un prérequis) ; tri par défaut `cluster_by` (§5.7) : l'export
  suit l'ordre physique, sans coût de tri.
- Garde-fous propres : plafond de lignes configurable, limite de streams concurrents
  par IP, timeout, intégration au rate limiter existant.
- Implémentation : DuckDB fait le gros du travail (`COPY (SELECT ...) TO ... (FORMAT
parquet/csv)` vers fichier temporaire streamé, ou streaming par chunks via
  `@duckdb/node-api` + `apache-arrow` pour l'IPC Arrow) — les noms d'API exacts sont à
  vérifier dans la doc de la version installée, le prompt l'exige explicitement.
  Parquet et Arrow préservent les types de la base (`UBIGINT`, `TIMESTAMP`...) sans
  passer par la sérialisation JSON du §5.6.

### 5.3 Versioning du schéma GraphQL

- **Pas de `/v2` d'URL** : la norme GraphQL est l'évolution continue du schéma +
  directives `@deprecated` + retrait après préavis. Le SemVer du package (release-please
  déjà en place) **est** la version de l'API : breaking schéma → majeur à partir de
  1.0.0, → **mineur tant que l'API est en 0.x**.
- **Numéro de la refonte : 0.3.0** (décision de septembre 2026 ; 1.0.0 viendra plus
  tard, par un `Release-As: 1.0.0` explicite). Le package est en `0.2.0` ; sans
  réglage, release-please traiterait le premier `feat!:` comme une rupture majeure et
  proposerait 1.0.0. `.release-please-config.json` porte donc
  `"bump-minor-pre-major": true` (ajouté le 2026-09-19, avant tout commit `feat!:`) :
  en 0.x, `feat!:` et `feat:` montent la mineure, `fix:` le patch — la refonte sort en
  0.3.0. Le « schéma v1 » de la base (`schema_version`) et la version de l'API sont
  deux numéros indépendants.
- **Politique de dépréciation : à partir de 0.3.0.** La refonte elle-même supprime
  sans préavis (projet non publié) ; ensuite, `@deprecated` + une mineure de préavis
  avant retrait, même en 0.x (la rupture reste permise en mineure par SemVer 0.x, mais
  la politique la rend prévisible pour le frontend).
- **Changelog : un seul.** release-please génère déjà le CHANGELOG.md depuis les
  conventional commits — les changements de schéma y figurent naturellement
  (`feat(schema):`, `feat!:`). À la place d'un second changelog manuel, **générer le
  diff SDL automatiquement** et publier le SDL comme artefact de release.
- **Prérequis oublié en juillet : versionner le SDL — mais pas celui de la doc.**
  `docs-site/static/schema.graphql` (et `schema.json`) est un **artefact de build de
  la documentation**, à laisser gitignoré. Vérifié le 2026-09-19 :
  - il est réécrit à chaque `npm run docs:schema`, donc à chaque `npm run docs:build`
    en local et à chaque déploiement de la doc (`.github/workflows/docs.yml:45`) ;
  - `docs-site/scripts/generate-schema.mjs` le produit depuis
    **`dist/`** (typedefs compilés), pas depuis `src/` : le CI lance `npm run build`
    avant, mais **`npm run docs:build` en local ne compile pas** — d'où le SDL périmé
    (argument `database`) observé par le frontend ;
  - il est **lu** par `@graphql-markdown/docusaurus`
    (`docs-site/docusaurus.config.ts:115`, `schema: 'static/schema.graphql'`) et par
    voyager (`schema.json`, `docs-site/src/pages/schema.tsx`).

  Le suivre dans git produirait des diffs parasites à chaque build de doc et un
  contenu dépendant de la fraîcheur de `dist/`. Retenu : un **fichier distinct et
  suivi, `schema.graphql` à la racine**, généré **depuis `src/`** (via `tsx`, déjà en
  devDependency) par un script dédié `schema:generate`, déterministe (même source →
  même octets) et vérifié à jour en CI (`git diff --exit-code`). `docs:schema` en
  dérive ses deux artefacts ignorés (copie du SDL + introspection), ce qui corrige au
  passage la dépendance à `dist/`. C'est le fichier racine que `graphql-inspector`
  compare au tag précédent, que la release publie, et que le frontend vendore pour
  son serveur de mock.

- **Le manque réel : un garde-fou CI.** `graphql-inspector diff` contre le SDL de la
  release précédente, qui échoue le CI sur breaking change non signalé (commit sans
  `!`). C'est ce qui rend la politique de dépréciation opposable.

### 5.4 Documentation

**Rien d'inutile dans la stack actuelle** — chaque brique a un rôle : TypeDoc (code),
Docusaurus (site), `@graphql-markdown/docusaurus` (référence du schéma), voyager
(visualisation), `generate-schema.mjs` (SDL + introspection). Le split en deux sites
est cohérent avec la double nature du projet (boîte à outils réutilisable vs
déploiement projet-spécifique), et vos sidebars déjà séparées
(`sidebars-code-reference.ts` / `sidebars-graphql.ts`) le rendent surtout mécanique.

Les manques réels :

1. **Publication du SDL** comme artefact versionné (cf. §5.3) — c'est le « contrat »
   que les tiers consomment.
2. **GraphQL Code Generator — oui, mais précision** : Apollo Codegen est _déprécié_,
   utilisez `@graphql-codegen`. Deux usages :
   - _côté clients_ : documenter une config codegen type dans la skill / le site de
     doc (les tiers génèrent leurs types depuis le SDL publié) ;
   - _côté API elle-même_ : `@graphql-codegen/typescript-resolvers` générerait les
     types de vos resolvers depuis le SDL — aujourd'hui vos interfaces TS
     (`SelectOptionsArgs`, etc.) sont écrites à la main et peuvent dériver du schéma.
3. **Le manque le plus intéressant : un dictionnaire des données auto-généré** depuis
   `metadata` + `dataset_metadata` (une page par schéma : colonnes, labels, types,
   unités, familles, descriptions, hiérarchies, couples code / libellé). C'est la moitié « projet-spécifique »
   de votre split de sites, data-driven par construction.
4. **La skill `dashboard-api-client`** : sa section « Database schema (target for the
   API) » (ajoutée par le prompt 10 côté base) devient caduque une fois la refonte
   faite ; elle est à fondre dans la référence de l'API, avec les corrections
   ci-dessus (`DatasetInfo`, `Fact.keys`, `fieldName`, camelCase).

### 5.5 Filtres en arbre alignés sur le MultiCriterionMenu (décision post-revue)

Décision : **supprimer l'argument `filters` (SQL brut) sans période de dépréciation**
et faire évoluer `structuredFilters` d'une liste plate `[Filter]` (AND implicites
uniquement) vers un **arbre de critères** — la forme produite par `buildTree` dans
`filterEngine.js` du frontend (`MultiCriterionMenu`) — converti côté serveur par une
fonction `treeToSQL`. Double gain : la surface d'injection disparaît à la racine, et
l'API gagne l'expressivité AND/OR parenthésée à profondeur arbitraire que la liste
plate ne sait pas exprimer.

**Contrat GraphQL cible** (les inputs récursifs sont permis en GraphQL ; pas d'union
d'inputs, donc un nœud discrimine feuille/groupe par le champ renseigné) :

```graphql
enum FilterConnector {
  AND
  OR
}
enum FilterOperation {
  EQ
  NEQ
  GT
  GTE
  LT
  LTE
  BETWEEN
  IN
  NOT_IN
  BEFORE
  AFTER
  CONTAINS
  STARTS
  IS_NULL
  IS_NOT_NULL
}
input FilterCriterion {
  variable: String!
  operation: FilterOperation!
  "String, nombre, booléen, [valeurs] pour IN/NOT_IN, {min, max} pour BETWEEN ; absent pour IS_NULL"
  value: JSON
}
"Exactement un des deux champs criterion/children doit être renseigné"
input FilterNode {
  "Connecteur avec le nœud précédent dans le groupe parent (ignoré pour le premier)"
  connector: FilterConnector
  criterion: FilterCriterion
  children: [FilterNode!]
}
```

Les queries de faits et de faits agrégés prennent `structuredFilters: FilterNode`
(la racine est un groupe). La correspondance avec le tree du frontend est mécanique
(`connectorBefore` → `connector`, feuilles → `criterion`) ; les champs `depth`,
`group`, `sql_type` et `is_categorical` du tree UI **ne font pas partie du contrat**.

**Règles du `treeToSQL` serveur** — c'est une réécriture durcie de
`filterEngine.js`, pas un portage :

1. **Ne jamais faire confiance au typage client** : le type de chaque `variable` est
   relu depuis la table `metadata` (`sql_type`), qui détermine la famille et donc les
   opérations autorisées. Familles, alignées sur les types réellement produits par la
   base (spec bdd §3) :
   - **numérique** : `TINYINT`, `SMALLINT`, `INTEGER`, `BIGINT`, `HUGEINT`,
     `UTINYINT`, `USMALLINT`, `UINTEGER`, `UBIGINT`, `FLOAT`, `DOUBLE`, `DECIMAL(p,s)`
     → `EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN IS_NULL IS_NOT_NULL` ;
   - **date** : `DATE`, `TIMESTAMP` (et variantes `TIMESTAMP WITH TIME ZONE`...)
     → `EQ NEQ BEFORE AFTER BETWEEN IS_NULL IS_NOT_NULL`, valeurs ISO 8601 ;
   - **texte** : `VARCHAR` → `EQ NEQ CONTAINS STARTS IN NOT_IN IS_NULL IS_NOT_NULL` ;
   - **booléen** : `BOOLEAN` → `EQ NEQ IS_NULL IS_NOT_NULL` (valeur JSON booléenne) ;
   - type non reconnu → rejet explicite (jamais de famille par défaut).
     Colonne inconnue ou opération incompatible → `GraphQLError BAD_USER_INPUT`
     explicite.
2. **SQL paramétré** : `treeToSQL` retourne `{sql, params}` (placeholders `?`) plutôt
   que des chaînes échappées — `@duckdb/node-api` supporte les paramètres, seuls les
   identifiants (validés par `validateIdentifier`) sont interpolés. Attention au
   binding : `bindParam` (`src/db/pool.ts`) choisit `bindInteger`/`bindDouble` selon
   la valeur JS — un entier au-delà de 2³¹ ou une comparaison sur `UBIGINT` doit être
   vérifiée par un test (au besoin `CAST(? AS <sql_type>)`).
3. **Critère incomplet = rejet** : le `?` de dégradation du frontend (critère sans
   valeur) n'a pas de sens côté API ; `BETWEEN` exige `{min, max}`, `IN` exige un
   tableau non vide, groupe sans enfant refusé (pas de `TRUE` silencieux).
4. **Bornes anti-abus** : profondeur max et nombre max de critères configurables
   (l'arbre est une expressivité offerte au client, elle se borne comme le reste).
5. Dates : ISO 8601 exigé (la conversion `DD/MM/YYYY` → ISO reste une affaire d'UI,
   `filterEngine.js` la fait déjà).

Impact en cascade : `getFieldStats` (§4) et l'endpoint `/api/export` (§5.2)
consomment le même `FilterNode` (en JSON URL-encodé pour l'export) — un seul moteur
de filtre pour toute l'API.

### 5.6 Données prêtes pour graphiques et tableaux (notes `mise_à_jour_chart` / `api_table`)

Deux notes rédigées côté frontend demandaient des évolutions de
`getFactTableWithMetadata`. Tri à la lumière de la base reformatée :

| Demande                                                                     | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveLabels: Boolean` (codes → libellés)                                 | **Obsolète** : la fact table stocke les libellés. Ne pas implémenter.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Métadonnées des colonnes retournées (`columnsMetadata` / `metadata.fields`) | **Pertinent, fusionné** : un seul champ `fields: [Metadata!]!` sur `DatasetWithMetadata`, aligné sur `columns` (même ordre). Réutilise le type `Metadata` refondu — le front reçoit en plus `unit` et `displayFormat` (suffixe d'axe, format d3) et `family`.                                                                                                                                                                                                                                        |
| Sérialisation garantie (dates ISO, numériques en nombres, NULL → null)      | **Pertinent, et plus urgent qu'il n'y paraît** : la base produit des `BIGINT` (Int64 par défaut) et des `UBIGINT`, que `getRowObjectsJson()` sort vraisemblablement en chaînes. Règle : entier dans `Number.isSafeInteger` → nombre JSON ; au-delà → chaîne (documentée) ; `DECIMAL` → nombre ; `DATE` → `YYYY-MM-DD` ; `TIMESTAMP` → `YYYY-MM-DDTHH:mm:ss[.sss]` (ISO, séparateur `T`). Un seul convertisseur, appliqué à tous les chemins JSON (OBJECTS, ARRAYS, `getFactTable`, agrégats, stats). |
| `extents` couvrant les dates                                                | **Pertinent** : extents de page étendus aux colonnes date/timestamp (bornes ISO) et aux entiers devenus nombres. Les bornes _globales_ restent `Metadata.stats` (§4).                                                                                                                                                                                                                                                                                                                                |

Même logique pour les agrégats : `AggregatedFactsMetadata.groupByFieldInfo` existe ;
ajouter `measureFieldInfo: Metadata` (unité et format de la valeur agrégée).

**Réalisé (prompt 7).** Constat de `getRowObjectsJson()` / `getRowsJson()` sur
`@duckdb/node-api` 1.5.2-r.2 (`tests/unit/test_db/json-serialization.test.ts`) : tout
entier de 64 bits ou plus (`BIGINT`, `UBIGINT`, `HUGEINT`), **même petit** (`'42'`), et
tout `DECIMAL` sortent en **chaînes** ; `NaN` / `Infinity` sortent en chaînes
(`'NaN'`) ; un `FLOAT` est élargi en double (`0.1` → `0.10000000149011612`) ; un
`TIMESTAMP` porte un espace (`'2024-03-05 10:11:12'`) et un `TIMESTAMPTZ` est rendu dans
le fuseau de la session (`+02`). Le convertisseur unique (`src/db/json-conversion.ts`,
branché sur `convertRowObjects` / `convertRows`) applique la règle cible, avec ces
précisions : un `FLOAT` est restitué par son plus court décimal (`0.1`) ; `NaN` et
`±Infinity` valent `null` ; un `TIMESTAMPTZ` est sérialisé en UTC avec suffixe `Z`,
indépendamment du fuseau de session ; une date infinie vaut `null`. Les extents d'une
colonne d'entiers dépassant 2^53 comparent les valeurs comme des nombres : leur borne
est approchée à cette échelle. Effet de déploiement : les entrées de cache Redis des
requêtes de faits gardent l'ancienne forme (`BIGINT` en chaîne) jusqu'à expiration —
vider le cache (`/api/cache/invalidate-all`) au déploiement.

### 5.7 Tri par défaut et pagination déterministe

La pagination par offset sans `ORDER BY` n'est pas stable sous DuckDB (scan parallèle
multi-fichiers) : lignes dupliquées ou manquantes d'une page à l'autre. La base fournit
la solution naturelle : **`dataset_metadata.cluster_by`**, l'ordre physique d'écriture
(défaut : clés primaires). Règle : sans `sort` explicite, `ORDER BY <cluster_by>` ;
avec un `sort` explicite, compléter par les clés primaires comme départage. Le tri sur
`cluster_by` est quasi gratuit (données déjà ordonnées tant que la maintenance
`recluster` est tenue). S'applique à `getFactTable*`, `compareFacts` et à l'export.

### 5.8 Codes et libellés (`labelFor`) — ajout du 2026-09-22

Besoin : certaines colonnes portent un **code métier** à restituer tel quel (code de
nomenclature tarifaire NC8, code INSEE) auquel on associe un **libellé** lisible. La
spec bdd §2.6 tranche côté base : le code et le libellé sont **deux colonnes de la
fact table**, et le lien est déclaré par `metadata.label_for`, **porté par la colonne
de libellés** et pointant vers le code (un code peut en avoir plusieurs : fr, en…). Le
writer garantit la **dépendance fonctionnelle** code → libellé (un seul libellé par
code, `NULL` compris). Pas de table de référentiel, pas de jointure : tout reste de la
lecture directe de la fact table. Contrat API :

- **`Metadata.labelFor: String`** (colonne de code visée, `null` sinon) et
  **`Metadata.labelFields: [String!]!`** (inverse : colonnes de libellés d'un code,
  triées par nom, vide sinon). `labelFields` est calculé par le loader de métadonnées
  sur les lignes déjà lues, sans requête supplémentaire. Le mapping snake → camel reste
  au seul endroit fixé au prompt 4.
- **`getFields(includeLabelFields: Boolean = false)`** : les colonnes de libellés ne
  sont pas des variables à proposer dans un menu ; elles restent dans
  `getCatalogSchema` (contrat complet) et sont requêtables par `fields` et les filtres.
- **Choix de la colonne de libellés** (règle unique, partagée par toutes les queries) :
  `labelField` fourni → doit être une colonne de libellés de la colonne visée, sinon
  `BAD_USER_INPUT` ; absent → la seule colonne de libellés, ou la **première par ordre
  alphabétique** s'il y en a plusieurs ; aucune → `label = value` (comportement
  actuel). Un code sans libellé (`NULL`) garde `label = value` (`SelectOption.label`
  est non-nullable).
- **`getSelectOptions(..., labelField: String)`** : une requête,
  `SELECT DISTINCT CAST(code AS VARCHAR) AS value, libelle AS label … ORDER BY value` —
  la dépendance fonctionnelle garantit que `DISTINCT (code, libellé)` = `DISTINCT
code`. `searchTerm` cherche dans le code **ou** le libellé (même échappement des
  jokers). La colonne de libellés effective fait partie de la clé de cache.
- **`getSelectOptionsTree`** : chaque niveau de la chaîne apporte son couple (code,
  libellé) au même `SELECT DISTINCT` ; le libellé de chaque niveau suit la règle par
  défaut (pas d'argument par niveau) ; `searchTerm` porte sur le code ou le libellé de
  la feuille. Borne de nœuds inchangée (un nœud = un code).
- **`AggregatedFact.keyLabel: String`** et **`ComparedFact.keyLabel: String`** :
  libellé de la clé de groupe, obtenu **dans la même requête** par `ANY_VALUE(libelle)`
  (licite grâce à la dépendance fonctionnelle) ; `null` quand la colonne groupée n'a pas
  de libellés. Pour `compareFacts`, rempli seulement quand la comparaison porte sur un
  seul champ de jointure doté de libellés (`COALESCE` des deux côtés). Note : le prompt
  3 a supprimé l'ancien `keyLabel`, qui résolvait les codes par les `dim_*` via un field
  resolver ; celui-ci est un champ SQL direct, sans résolveur ni requête de plus. Pas
  d'argument `labelField` sur les agrégats pour l'instant (extension locale si un
  dashboard bilingue le demande).
- **`getSharedFields`** : exclut les colonnes de libellés ; la jointure entre jeux de
  résultats porte sur le code, plus stable qu'un libellé révisable.
- **Sans changement** : `treeToSQL` (une colonne de libellés est un `VARCHAR`, famille
  texte : `CONTAINS 'viande'` fonctionne), `getFieldStats`, l'export, `Fact { keys,
measures }` (les libellés sont des colonnes ordinaires, demandées via `fields`).
  `DatasetWithMetadata.fields` (§5.6) porte `labelFor` / `labelFields` gratuitement :
  le tableau du frontend peut afficher « code — libellé ».
- **Compatibilité** : pas de chemin pour les catalogues sans colonne `label_for`
  (schéma v1 de développement, reconstruit ; spec bdd, en-tête). Les données de test
  sont complétées au prompt 6.

**Non retenu** : un catalogue de référentiels séparé joint à la volée (jointure
multi-catalogues à chaque requête, versionnage des nomenclatures, codes orphelins —
spec bdd §2.6) ; une résolution de libellés par field resolver (requête par champ,
retour du N+1 que la suppression des dimensions avait éliminé).

---

## 6. Points faibles relevés hors de vos questions

1. **Sécurité écrite mais non branchée** (rate limiting, complexité, sanitization) —
   détaillé au §2 ; c'est le point le plus important de cette revue.
2. **Erreurs avalées dans les select-options** : `loadSelectOptions` fait
   `catch { return []; }` (`src/loaders/select-options.ts:79-81`) — un champ
   inexistant, une table absente ou une panne DB sont indistinguables d'une liste
   vide côté front. Remonter une `GraphQLError` explicite.
3. **`MAX_OFFSET: 10000`** et **profondeur 7** : limites de conception acceptables
   pour un dashboard, à documenter comme telles (spec bdd §8) ; l'export REST couvre
   le besoin au-delà.
4. **Interfaces TS dupliquées du SDL** à la main (cf. §5.4, codegen resolvers) ; de
   même, le scalaire `JSON` est déclaré sans resolver custom (passthrough par défaut) —
   fonctionne, mais un vrai `GraphQLScalarType` (ex. `graphql-type-json`) rendrait la
   sérialisation explicite.
5. **Données de test** (`tests/setup/setup-test-data.ts`) construites à la main avec
   `python_type`, codes numériques et tables `dim_*` : à réécrire au format v1 — premier
   prérequis technique de la bascule. Elles doivent reproduire **exactement** le DDL de
   la spec bdd §2 (colonnes, types, `NOT NULL`), idéalement vérifié par un test de
   contrat.
6. **Sérialisation `BIGINT` / timestamps** non maîtrisée (§0, §5.6).
7. **Pagination non déterministe** sans tri (§5.7).
8. **SDL non versionné** (§5.3).
9. **L'invalidation du cache ne supprime rien dès que `keyPrefix` est non vide** (constat
   du prompt 8, vérifié sur un Redis réel). Le client ioredis est créé avec
   `keyPrefix` (`graphql-api:` par défaut, `src/cache/redis.ts`) : ioredis ajoute ce
   préfixe aux clés des commandes, **pas** au motif `MATCH` de `SCAN`, et ne le retire
   pas des clés que `SCAN` renvoie. `CacheInvalidationManager.scanKeys` cherche donc
   `facts:<catalogue>:*` alors que les clés sont `graphql-api:facts:<catalogue>:…`
   (aucun résultat), et un `DEL` des clés renvoyées les re-préfixerait. Conséquence :
   `/api/cache/invalidate-all`, appelé par l'updater nocturne, est sans effet ; la
   fraîcheur ne repose que sur les TTL (300 s pour les faits, 600 s pour les
   métadonnées, options et stats non filtrées). Les tests unitaires ne le voient pas :
   ils simulent `redis.scan`. Correctif : préfixer le motif avec
   `redis.options.keyPrefix` et retirer ce préfixe des clés avant `DEL`.

---

## 7. Synthèse

**Forces** : la projection de colonnes effective jusqu'au SQL ; la table `metadata`
comme contrat UI (désormais formalisé par la base) ; le cache Redis systématique sur
tous les loaders avec invalidation pilotée par l'updater ; la chaîne de doc générée
depuis le schéma ; release-please en place ; le blocage des mutations, le depth-limit
et l'attach `READ_ONLY` actifs.

**Faiblesses** : rate limiting / complexité / sanitization **codés mais non branchés** ;
`filters` SQL brut, `operator` et `fields` non contrôlés (correctif n°1) ;
group-options non corrélées ; couche dimension devenue sans objet ; pas de min/max de
colonne ; pas d'export volumineux ; sérialisation des entiers larges et pagination non
maîtrisées ; SDL non versionné et pas de garde-fou CI ; types resolvers manuels.

**La base reformatée simplifie l'API plus qu'elle ne la complique** : une couche
entière (dimensions, résolution de labels, jointures cross-catalogue par codes)
disparaît, et les ajouts (`DatasetInfo`, champs d'UI, arbre de sélection, couples
code / libellé) sont de la lecture directe de `metadata` / `dataset_metadata` / fact
table.

**Évolutions majeures anticipables sans refonte** : ajout de HAVING, time travel en
lecture (`AT (VERSION => n)` : les snapshots DuckLake portent déjà `run_id` et message
de commit — un argument `snapshot` sur les queries de faits serait local), subscriptions
GraphQL (données quasi statiques : inutile aujourd'hui), fédération si d'autres
services apparaissent, nouveau format d'export — toutes s'insèrent dans l'architecture
actuelle. Le seul scénario qui imposerait une refonte serait l'abandon de DuckLake, et
la couche loaders isole déjà le SQL du schéma GraphQL.
