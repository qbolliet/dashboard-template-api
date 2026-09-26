# Audit — dashboard-template-api, branche `qb-schemav2-adaptation` → `main`

> Audit en lecture seule du 2026-09-26 (HEAD `2ad3511`, 17 commits d'avance sur `main`).
> Aucun fichier de code modifié ; seul ce fichier a été écrit. Les essais ont été faits
> avec des scripts jetables hors du dépôt, sur le Redis local (5.0.14) et sur l'API
> réelle démarrée (`npm start`) contre les catalogues de test, en dev puis en production.
>
> **Légende des preuves** — **[E]** essai réel (commande, script ou requête HTTP, résultat
> reproduit en §5) ; **[L]** lecture du code (fichier:ligne cités) ; **[S]** supposé,
> non vérifié (voir §6).

---

## 1. Verdict de fusion

**Oui, après correctifs.** La refonte (3 tables, `FilterNode` paramétré, contrat `Metadata`, export REST, SDL versionné) est cohérente et tous les contrôles passent (lint, types, schema/codegen check, 1 324 tests verts).
Mais cinq défauts **bloquants**, tous prouvés sur l'API réelle, doivent être corrigés avant la fusion et la release 0.3.0 : la validation GraphQL est désactivée (B1), les erreurs finissent en `null` silencieux (B2), le rate limiting derrière l'ingress et contournable (B3), les limites du corps JSON rejettent un filtre de 8 critères (B4), les agrégats sont faux sur les NULL (B5).
Effort cumulé : environ 2 à 3 jours. Le contrat n'ayant jamais été publié (`schema:diff` : v0.2.0 sans SDL), les corrections de contrat (B5, §4) sont gratuites maintenant et deviennent des ruptures après le tag 0.3.0.
L'invalidation du cache (I1, confirmée inopérante) est à corriger avant la release, sans bloquer la fusion : les TTL bornent la péremption à 600 s.

### 1.1 Ce qui a été vérifié et tient

- **Pas d'injection SQL trouvée [L]** : les valeurs de filtre sont liées (`treeToSQL`, `src/utils/filter-tree.ts:604-607`) ; les identifiants passent par `validateIdentifier` (`src/utils/utils.ts:18-26`) ; le schéma est contrôlé contre une allow-list (`src/loaders/index.ts:110-118`) ; les types des `CAST` viennent d'une liste blanche (`filter-tree.ts:329-342`) ; l'export vérifie en plus les colonnes contre `metadata` (`src/export/build-export-query.ts:105-116`). Détail en §3.3.
- **Modèle de données [E]** : aucune table `dim_*`, trois tables par schéma, hiérarchies par `parent_name` (test de contrat vert). Les traces restantes de l'ancien modèle dans le code sont des assertions d'absence dans les tests, sauf les exceptions listées en I9, I10 et M12.
- **Sérialisation [E]** : BIGINT au-delà de 2^53 renvoyé en chaîne exacte (`"9007199254740996"` observé), dates ISO, `NaN` rendu `null` (`src/db/json-conversion.ts`).
- **Export REST [L]** : validation avant de prendre un créneau, concurrence par IP et globale, `interrupt()` DuckDB sur timeout et abandon du client, connexion et fichier temporaire libérés en `finally`.
- **Garde de version du schéma [E]** : les fixtures non conformes sont refusées, y compris quand le cache Redis est chaud (`assertKeyAllowed`).

---

## 2. Tableau des constats

Gravité : **bloquant** (à corriger avant fusion) / **important** (avant la release ou en production) / **mineur**.

| id  | catégorie        | gravité   | fichier:ligne                                                                                                                                                                                                                                                                                                                                    | description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | correctif proposé                                                                                                                                                                                                                                                                                                                                                                      | effort | bloquant fusion ?                                                                                                        | preuve        |
| --- | ---------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ | ------------- |
| B1  | bug / sécurité   | bloquant  | `src/server.ts:395-408`                                                                                                                                                                                                                                                                                                                          | La règle de validation « liste blanche » renvoie `true` sur chaque `OperationDefinition` : `visitInParallel` interprète cela comme « sauter le sous-arbre », pour **toutes** les règles. Champs inconnus, arguments inconnus, sélections manquantes, alias en conflit et fragments inconnus sont acceptés (HTTP 200, `{}` renvoyé). La règle `NoIntrospection` d'Apollo est court-circuitée elle aussi.                                                                                                                                                                                           | Supprimer la règle, ou renvoyer `undefined` ; ajouter un test HTTP « champ inconnu → 400 `GRAPHQL_VALIDATION_FAILED` ».                                                                                                                                                                                                                                                                | 0,5 h  | **oui** (préexistant sur `main`, mais la migration camelCase de 0.3.0 rend les anciennes requêtes silencieusement vides) | E             |
| B2  | bug              | bloquant  | `src/loaders/base-loader.ts:293-301`, `:338-344`, `:417-424` ; `src/schema/resolvers/fact.ts:171-209`                                                                                                                                                                                                                                            | Toute erreur qui n'est pas une `GraphQLError` est avalée par les loaders et remplacée par `null` (ou `[]`) : limite hors bornes, `limit` négatif, colonne inconnue dans `fields`/`sort`/`groupBy`/`measure`, `SUM` sur un VARCHAR, panne S3, requête interrompue. Le client reçoit `null` **sans** `errors`.                                                                                                                                                                                                                                                                                      | Relancer toutes les erreurs ; faire lever des `GraphQLError` à `validatePagination` (limit ≥ 1, offset ≥ 0) ; contrôler `fields`/`sort`/`groupBy`/`measure` contre `metadata`, comme le fait l'export ; convertir les erreurs DuckDB en `INTERNAL_SERVER_ERROR` avec un `errorId`.                                                                                                     | 1 j    | **oui**                                                                                                                  | E             |
| B3  | sécurité         | bloquant  | `src/security/rate-limiter.ts:72-87`, `:122`, `:237-242` ; `config/security.yaml:22` ; `helm/.../values.yaml:127`                                                                                                                                                                                                                                | `TRUSTED_PROXIES` arrive en chaîne JSON et devient un `Set` de caractères ; la comparaison est exacte (pas de CIDR, or Helm passe `10.0.0.0/8`) ; le premier élément de `X-Forwarded-For` est pris, alors que c'est lui que le client contrôle ; la clé est `IP + User-Agent`. Conséquences : derrière l'ingress, tous les clients qui partagent un UA partagent un seul compteur (100 req/15 min, rafale de 20/min) ; un attaquant qui fait tourner son UA n'est jamais limité ; les compteurs sont en mémoire, sur 2 à 6 réplicas.                                                              | `app.set('trust proxy', <CIDR>)` (proxy-addr gère les CIDR) puis `req.ip` ; un seul parseur de config (réutiliser `configuredTrustedProxies`, `src/export/export-routes.ts:61-72`) ; clé = IP seule ; plus tard, un store Redis partagé.                                                                                                                                               | 0,5 j  | **oui** (le limiteur est branché par cette branche, en 416600f ; en production il bridera tous les utilisateurs)         | E             |
| B4  | bug              | bloquant  | `src/server.ts:113-175` ; `config/api.yaml` (`REQUEST_LIMITS`)                                                                                                                                                                                                                                                                                   | Le `verify` de `express.json` refuse (403) tout document GraphQL de plus de 1 000 caractères (`MAX_FIELD_SIZE` s'applique aussi à `query`) et tout corps de plus de 50 champs JSON imbriqués : un `FilterNode` de **8 critères** passé en variables est rejeté (le frontend passe `$structuredFilters` en variable, `dashboard-template-frontend/src/lib/api/documents/factTable.js:30`). Nommer l'opération `IntrospectionQuery` contourne ces deux contrôles (`:121`).                                                                                                                          | Exclure `query` de `MAX_FIELD_SIZE` (la taille du corps, la profondeur et la complexité suffisent) ; supprimer `MAX_FIELDS` ou l'aligner sur les bornes de l'arbre (50 critères × ~6 champs) ; supprimer l'exemption `IntrospectionQuery`.                                                                                                                                             | 2 h    | **oui** (rend `FilterNode` inutilisable au-delà de 7 critères)                                                           | E             |
| B5  | bug / contrat    | bloquant  | `src/loaders/aggregated-facts.ts:228-235`, `:298` ; `src/schema/typedefs/common.ts:32-33` (doublon `fact.ts:32-42`)                                                                                                                                                                                                                              | `Number(null)` donne 0 : l'`AVG` d'un groupe entièrement NULL est renvoyé comme `0` ; une clé de groupe NULL devient la chaîne `"null"` ; `MIN`/`MAX`/`MODE` sur une date ou un texte produisent des erreurs `NaN` ; `totalGroups` (COUNT DISTINCT) ignore le groupe NULL, ce qui fausse `hasNextPage` et `totalPages`.                                                                                                                                                                                                                                                                           | `aggregatedValue: Float` nullable (ou `JSON` passé par le convertisseur), `key` nullable ; refuser les agrégations incompatibles avec la famille de type (`BAD_USER_INPUT`) ; `SELECT COUNT(*) FROM (… GROUP BY …)`. À faire avant le tag 0.3.0.                                                                                                                                       | 3 h    | **oui**                                                                                                                  | E             |
| I1  | bug / cache      | important | `src/cache/cache-invalidation.ts:107-116`, `:140-148`, `:194-201` ; `src/cache/redis.ts:69` ; `config/cache.yaml:22` ; `src/loaders/base-loader.ts:253` ; `src/loaders/catalog.ts:40`, `dataset-info.ts:85`, `cross-database.ts:149`                                                                                                             | L'invalidation ne supprime rien : `SCAN MATCH` n'est pas préfixé et les clés renvoyées ne sont pas dépréfixées. `/api/cache/invalidate-all` répond `success:true` avec 19 clés avant et 19 après ; `/api/cache/stats` renvoie des 0. S'y ajoutent : le préfixe par défaut contient des apostrophes littérales (`'graphql-api:'`) ; un schéma implicite est stocké sous le segment `_`, donc hors du motif par schéma ; les loaders sans catalogue rangent **tous** les catalogues sous `default:_`.                                                                                               | Motif `${keyPrefix}${pattern}`, préfixe retiré avant `DEL` (correctif testé en réel) ; `${REDIS_KEY_PREFIX:-graphql-api:}` sans apostrophes ; segments de clé = catalogue et schéma **résolus** ; pour les loaders dont la clé porte le catalogue, un hook `cacheNamespace(key)` ; test d'intégration sur le Redis de la CI.                                                           | 1 j    | non (TTL ≤ 600 s) — avant release                                                                                        | E             |
| I2  | bug              | important | `src/schema/resolvers/fact.ts:54-55` ; `resolvers/catalog.ts:180`, `:204`, `:240` ; `src/server.ts:449-462` ; `config/api.yaml:8`                                                                                                                                                                                                                | Le routage par en-têtes `x-catalog-id`/`x-schema-id` est documenté mais incohérent. `getFactTable` routé par en-tête calcule son tri par défaut sur le catalogue **par défaut**, d'où un `ORDER BY` sur des colonnes absentes et un `null` (en-têtes `macroeconomics`/`trade`). `getCatalogSchema`, `getDatasetInfo` et `getFields` ignorent les en-têtes. Un en-tête invalide retombe **silencieusement** sur le catalogue par défaut. Les en-têtes CORS n'autorisent pas `x-catalog-id`.                                                                                                        | Résoudre partout la cible par `contextScope()` (`src/schema/resolvers/scope.ts:79-90`) ; rejeter un en-tête invalide ; ajouter les deux en-têtes à `CORS.HEADERS` ; ou supprimer le routage par en-tête et le retirer de la doc.                                                                                                                                                       | 3 h    | non                                                                                                                      | E             |
| I3  | sécurité / bug   | important | `config/security-patterns.yaml:3-38` ; `src/security/pattern-validator.ts:140-178`                                                                                                                                                                                                                                                               | Les motifs sont cherchés dans le texte brut de la requête. En production, toute requête contenant `__typename` (ajouté par défaut par Apollo Client et urql) est rejetée ; `searchTerm:"ecosystem"` est rejeté par le motif « system », `fields:["mutation_rate"]` par « mutation ». Aucune valeur de sécurité : la même valeur passe par les variables.                                                                                                                                                                                                                                          | Supprimer les motifs SQL et `mutation` (le type d'opération est déjà contrôlé en `src/security/manager.ts:231`) ; supprimer `__schema`/`__type` **après** B1 (l'`introspection: false` d'Apollo redevient alors effectif).                                                                                                                                                             | 1 h    | non (le frontend utilise `graphql-request`)                                                                              | E             |
| I4  | sécurité / perf  | important | `src/security/complexity-analyzer.ts:23`, `:56`, `:208-212` ; `config/security.yaml:40-51` ; `resolvers/select-options.ts:37` ; `resolvers/cross-database.ts:292`                                                                                                                                                                                | La complexité ne compte ni la taille des listes (`LIST_FACTOR` jamais utilisé), ni `limit` au-delà de 100, ni les requêtes sans score dédié. Mesures : `getCatalogSchema { stats }` coûte 16, quel que soit le nombre de colonnes (N `COUNT DISTINCT` plein scan) ; 50 `compareFacts` aliasés coûtent 50 (≤ 200 admis) ; 40 `getFieldStats` coûtent 200. `getSelectOptions` et `crossDatabaseSelectOptions` acceptent un `limit` non borné.                                                                                                                                                       | Scorer toutes les requêtes racine ; pondérer `stats` par le nombre de colonnes, ou le plafonner ; plafonner le nombre de champs racine ; borner les `limit` d'options (`MAX_LIMIT`).                                                                                                                                                                                                   | 0,5 j  | non                                                                                                                      | E             |
| I5  | perf / bug       | important | `src/loaders/cross-database.ts:206-209`, `:247`, `:259`, `:331-335` ; `resolvers/cross-database.ts:160-181`                                                                                                                                                                                                                                      | `compareFacts` fait un JOIN direct sur des `joinFields` non uniques, d'où une explosion cartésienne (N_A × N_B par clé) et un `COUNT(*)` de même taille. La mesure `value` est **codée en dur** (compareFacts et compareAggregatedFacts), alors que le CHANGELOG 0.2.0 annonce la fin de ce couplage. Le tri `ORDER BY key` sur une clé non unique rend la pagination non déterministe, et l'offset n'est pas borné. Le risque dépend de `ALLOW_CROSS_CATALOG_QUERIES` (faux par défaut, vrai en test).                                                                                           | Agréger chaque côté par `joinFields` avant la jointure (ou exiger une clé unique), ajouter un argument `measure` contrôlé contre `metadata`, départager par les clés, borner l'offset. Voir aussi §4.                                                                                                                                                                                  | 1 j    | non                                                                                                                      | L             |
| I6  | perf / fiabilité | important | `src/db/pool.ts:578-586`, `:594-689`, `:692-700` ; `src/loaders/base-loader.ts:120-153`, `:282-292` ; `src/utils/timeout.ts:10-15`                                                                                                                                                                                                               | Le pool dépasse `maxConnections` : avec 2, 10 `acquire()` concurrents à froid créent 10 connexions, qui ne sont jamais rendues (le test a lieu avant les `await`, l'insertion après). Le minuteur d'acquisition n'est jamais nettoyé. L'attente se fait par sondage toutes les 500 ms, sans FIFO. Les loaders prennent une connexion **avant** de consulter Redis, donc les hits de cache attendent derrière les requêtes lentes. `withTimeout` n'interrompt pas la requête DuckDB, qui garde sa connexion.                                                                                       | Réserver le créneau de façon synchrone (compteur), servir une file d'attente FIFO, `clearTimeout` ; lire le cache avant d'acquérir ; `conn.interrupt()` sur timeout, comme l'export.                                                                                                                                                                                                   | 1 j    | non                                                                                                                      | E (course), L |
| I7  | bug / perf       | important | `src/utils/cache.ts:40-43`                                                                                                                                                                                                                                                                                                                       | Le `catch` global de `withCache` relance le loader : une requête en échec est exécutée **2 fois** (un timeout de 15 s coûte 30 s). `loadWithCache` essaie de l'éviter mais `withCache` le défait.                                                                                                                                                                                                                                                                                                                                                                                                 | Distinguer les erreurs Redis des erreurs du loader dans `withCache` (même garde que `guardedLoader`).                                                                                                                                                                                                                                                                                  | 0,5 h  | non                                                                                                                      | E             |
| I8  | fiabilité        | important | `src/server.ts:512-531`, `:543-548` ; `src/index.ts:23-27`                                                                                                                                                                                                                                                                                       | L'arrêt gracieux ne ferme pas le serveur HTTP (pas de `ApolloServerPluginDrainHttpServer`) et ferme en parallèle Redis, le pool et Apollo pendant que des requêtes et des exports tournent encore ; il n'a pas de délai maximal. Lors d'un rolling update Kubernetes, cela produit des 5xx et des exports tronqués.                                                                                                                                                                                                                                                                               | Garder `httpServer = app.listen(…)`, ajouter le plugin de drain, arrêter d'accepter → drainer avec un délai inférieur au `terminationGracePeriodSeconds` → fermer le pool puis Redis.                                                                                                                                                                                                  | 2 h    | non                                                                                                                      | L             |
| I9  | tests            | important | `tests/integration/comprehensive.test.ts` (1 371 l.) ; `tests/unit/test_db/database-di.test.ts` + `tests/setup/di-container.ts`, `database-manager-injectable.ts` ; `tests/unit/test_cache/cache-invalidation.test.ts` ; `tests/unit/test_schema/test_resolvers/field-stats.test.ts:80-100` ; `tests/unit/test_db/schema-contract.test.ts:43-56` | Des tests passent pour de mauvaises raisons. `comprehensive.test.ts` (31 tests) n'importe **rien** de `src/` : il teste des bouchons définis dans le test lui-même, avec l'ancien modèle (`DATABASE_ROUTING`, `inputSanitizer`). `database-di` (23 tests) teste une réimplémentation propre aux tests. Les tests d'invalidation simulent `redis.scan` ; `field-stats.test.ts` **contourne** le bug de préfixe au lieu de le signaler. Aucun test de B1, B2, B4 ou B5. Le contrat de fixture impose des `NOT NULL` que le writer réel ne déclare pas (`dt_ducklake_manager/utils/types.py:30-37`). | Supprimer ces tests « creux » (environ 2 500 lignes) ; ajouter des tests HTTP (supertest) de validation, de propagation d'erreurs, de limites du corps, d'en-têtes et d'agrégats NULL ; un test d'invalidation sur le Redis de la CI (service `redis:7` déjà présent dans `.github/workflows/test.yml`) qui échoue si `ping` échoue ; aligner la nullabilité du contrat sur le writer. | 1 j    | non                                                                                                                      | L             |
| I10 | doc              | important | `README.md:26`, `:100` ; `docs-site/api/docs/intro.md:39` ; `docs-site/api/docs/api-guide/overview.md:42` ; `docs-site/toolbox/docs/architecture/security.md:52-59`, `overview.md:23`, `:103` ; `configuration/security.md:70-79` ; `configuration/cache.md:79` ; `architecture/caching.md:49`                                                   | La doc publique décrit une sanitization XSS/SQL et un `src/security/input-sanitizer.ts` supprimés, ainsi que `/api/cache/invalidate/:database`. `specification-bdd.md` est cité dans 3 fichiers de `src`, 5 de tests et 2 de doc, alors qu'il a été supprimé du dépôt de la base (commit `71d8fc9`, remplacé par `docs/schema.md`).                                                                                                                                                                                                                                                               | Réécrire les pages sécurité et cache, remplacer les renvois par `docs/schema.md`.                                                                                                                                                                                                                                                                                                      | 3 h    | non                                                                                                                      | L             |
| I11 | API publique     | important | `src/server.ts:341-349`, `:378-386`                                                                                                                                                                                                                                                                                                              | En production, **tous** les messages d'erreur sont masqués, y compris `BAD_USER_INPUT` (les messages soignés de `treeToSQL`) et `QUERY_COMPLEXITY_EXCEEDED`. Pour une API publique, le client ne peut plus corriger sa requête. Les erreurs sont en outre journalisées deux fois (`formatError` et `didEncounterErrors`).                                                                                                                                                                                                                                                                         | Masquer seulement `INTERNAL_SERVER_ERROR` et les codes inconnus ; journaliser une seule fois.                                                                                                                                                                                                                                                                                          | 1 h    | non                                                                                                                      | E             |
| M1  | sécurité         | mineur    | `src/security/admin-auth.ts:24` ; `src/server.ts:204-207`                                                                                                                                                                                                                                                                                        | La clé admin est comparée par `!==` (pas en temps constant) et les routes `/api/cache/*` et `/api/catalog/*` ne sont pas limitées (30 essais → 30 × 401).                                                                                                                                                                                                                                                                                                                                                                                                                                         | `crypto.timingSafeEqual` sur les condensés SHA-256 ; limiteur dédié.                                                                                                                                                                                                                                                                                                                   | 0,5 h  | non                                                                                                                      | E             |
| M2  | sécurité         | mineur    | `src/server.ts:228-281`                                                                                                                                                                                                                                                                                                                          | `/metrics` et `/ready` sont publics (mémoire du processus, état du pool).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Les restreindre (clé admin ou ingress).                                                                                                                                                                                                                                                                                                                                                | 0,5 h  | non                                                                                                                      | E             |
| M3  | sécurité         | mineur    | `src/server.ts:81-110` ; `config/api.yaml:5-15`                                                                                                                                                                                                                                                                                                  | `X-Powered-By: Express` est présent ; `Allow-Credentials: true` est inutile (pas de cookie) ; les `ORIGINS` de production valent `API_DOMAIN` (domaine de l'API, pas du front) avec des apostrophes littérales par défaut.                                                                                                                                                                                                                                                                                                                                                                        | `app.disable('x-powered-by')`, `CREDENTIALS: false`, une variable `CORS_ORIGINS` dédiée.                                                                                                                                                                                                                                                                                               | 0,5 h  | non                                                                                                                      | E             |
| M4  | config           | mineur    | `config/cache.yaml:5`, `:14-22` ; `src/utils/config-loader.ts:486-489` ; `src/cache/redis.ts:65-94`                                                                                                                                                                                                                                              | Sans défaut, `${REDIS_PASSWORD}` est gardé **littéralement** et envoyé en AUTH (avertissement ioredis observé). `DB` n'est pas transmis à ioredis. `CLUSTER` est rangé sous `OPTIONS`, alors que `redis.ts:88` lit `REDIS.CLUSTER` : le mode cluster ne peut pas s'activer.                                                                                                                                                                                                                                                                                                                       | `${REDIS_PASSWORD:-}`, `db: DB`, remonter `CLUSTER`.                                                                                                                                                                                                                                                                                                                                   | 0,5 h  | non                                                                                                                      | E             |
| M5  | bug              | mineur    | `src/loaders/aggregated-facts.ts:205-210`                                                                                                                                                                                                                                                                                                        | Le tri par `aggregatedValue` n'a pas de départage : les ex æquo rendent les pages non déterministes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Ajouter `, key ASC`.                                                                                                                                                                                                                                                                                                                                                                   | 0,2 h  | non                                                                                                                      | L             |
| M6  | contrat          | mineur    | `src/schema/typedefs/metadata.ts:62` ; `fact.ts:49`, `:65` ; `cross-database.ts:35`                                                                                                                                                                                                                                                              | `total`, `distinctCount` et `nullCount` sont des `Int` GraphQL (32 bits), qui dépassent au-delà de 2,1 milliards de lignes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `Float` ou `JSON`, avant 0.3.0.                                                                                                                                                                                                                                                                                                                                                        | 0,5 h  | non                                                                                                                      | L             |
| M7  | bug              | mineur    | `src/utils/filter-tree.ts:648-656`                                                                                                                                                                                                                                                                                                               | `MATCHES` est validé par `RegExp` (JavaScript) mais exécuté par RE2 : un motif valide en JS et invalide en RE2 (lookbehind) provoque une erreur DuckDB, avalée par B2.                                                                                                                                                                                                                                                                                                                                                                                                                            | Rejeter la syntaxe non supportée par RE2, ou mapper l'erreur DuckDB en `BAD_USER_INPUT`.                                                                                                                                                                                                                                                                                               | 1 h    | non                                                                                                                      | L             |
| M8  | perf / export    | mineur    | `src/export/export-runner.ts:139-141` ; `export-routes.ts:204-212`, `:260`                                                                                                                                                                                                                                                                       | En csv/parquet, la connexion DuckDB reste tenue pendant tout le téléchargement ; aucun `Content-Length` (une troncature est indétectable en CSV) ; le timeout couvre le téléchargement, donc un client lent reçoit un fichier tronqué ; l'espace disque temporaire n'est pas borné (5 M lignes × 2 exports, pods limités à 1 Gi de mémoire).                                                                                                                                                                                                                                                      | Rendre la connexion après le `COPY`, poser `Content-Length`, distinguer timeout de requête et timeout de transfert, surveiller `TMP_DIR`.                                                                                                                                                                                                                                              | 2 h    | non                                                                                                                      | L             |
| M9  | code mort        | mineur    | voir §3.4                                                                                                                                                                                                                                                                                                                                        | Exports jamais utilisés en production, options YAML jamais lues, `config/test/*.yaml` jamais chargés, variables d'environnement de test inutilisées, argument `fields` des agrégats ignoré.                                                                                                                                                                                                                                                                                                                                                                                                       | Supprimer (liste en §3.4).                                                                                                                                                                                                                                                                                                                                                             | 2 h    | non                                                                                                                      | L             |
| M10 | orphelins        | mineur    | `graphql-test-queries.graphql` ; `package.json` (`start`)                                                                                                                                                                                                                                                                                        | 17 des 92 opérations de `graphql-test-queries.graphql` sont invalides contre `schema.graphql` (snake*case, commentaire `dim*\*`, l. 1479). `start`lance`tsx src/index.js`, un fichier qui n'existe pas (fonctionne via la résolution de tsx ; l'image Docker utilise `dist/`).                                                                                                                                                                                                                                                                                                                    | Régénérer le fichier ou le supprimer au profit du dictionnaire et des exemples de la doc ; `tsx src/index.ts`.                                                                                                                                                                                                                                                                         | 1 h    | non                                                                                                                      | E             |
| M11 | forme            | mineur    | `src/schema/typedefs/fact.ts:32-42` vs `common.ts:32-33` ; `AggregationType` ×3 ; `PaginatedFactResult` ×2                                                                                                                                                                                                                                       | `AggregatedFact` est défini **deux fois**, avec des nullabilités contraires, et la fusion garde la version non nulle. Types dupliqués entre loaders et resolvers.                                                                                                                                                                                                                                                                                                                                                                                                                                 | Une seule définition ; migrer vers les types générés (codegen).                                                                                                                                                                                                                                                                                                                        | 2 h    | non                                                                                                                      | L             |
| M12 | cache            | mineur    | `src/loaders/cross-database.ts:136-176`                                                                                                                                                                                                                                                                                                          | `CrossDatabaseLoader` ne surcharge pas `assertKeyAllowed` : un résultat en cache reste servi après qu'un schéma a été déclaré non supporté par un reload.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Surcharger `assertKeyAllowed`, comme `catalog.ts:50-53`.                                                                                                                                                                                                                                                                                                                               | 0,5 h  | non                                                                                                                      | L             |
| M13 | cache            | mineur    | `src/loaders/base-loader.ts:253`                                                                                                                                                                                                                                                                                                                 | Les clés ne sont pas canoniques : `{"catalog":"default"}`, `{"catalog":"default","schema":null}` et `"main"` explicite produisent trois entrées pour la même donnée. Les clés contiennent aussi les listes `IN` en entier (jusqu'à 1 000 valeurs).                                                                                                                                                                                                                                                                                                                                                | Normaliser (schéma résolu, champs `undefined` retirés) et hacher le suffixe (sha1).                                                                                                                                                                                                                                                                                                    | 1 h    | non                                                                                                                      | E             |
| M14 | code mort        | mineur    | `src/server.ts:192-201` ; `config/cache.yaml` (`HTTP_CACHE`, `TTL.*`)                                                                                                                                                                                                                                                                            | Le middleware « cache HTTP public » est écrasé par Apollo (`cache-control: no-store` observé sur `/graphql`). Son `Vary` omet de toute façon `x-catalog-id`.                                                                                                                                                                                                                                                                                                                                                                                                                                      | Supprimer le middleware et la configuration associée.                                                                                                                                                                                                                                                                                                                                  | 0,5 h  | non                                                                                                                      | E             |

---

## 3. Détail des constats bloquants et importants

### B1 — Validation GraphQL désactivée

- **Code** (`src/server.ts:395-408`) : `() => ({ OperationDefinition(node) { …; return true; } })`. Dans graphql-js, une valeur de retour qui n'est ni `undefined` ni `false` est prise pour une édition du nœud. Si cette valeur n'est pas un nœud, le sous-arbre n'est pas visité, et `visitInParallel` la propage à toutes les règles (`specifiedRules` et règles Apollo). Le commentaire « Autorisation de toutes les opérations par défaut » décrit le contraire de l'effet réel.
- **Scénario prouvé (production, §5.4)** : `{ getCatalogs { idd } }` → HTTP 200 `{"getCatalogs":[{},{},{}]}` ; `{ getCatalogs(foo: 1) { id } }` → 200 ; `{ getCatalogs }` → 200 ; deux alias `a` en conflit → 200 ; `...Nope` → 200.
- **Pourquoi c'est bloquant maintenant** : 0.3.0 renomme `sql_type` en `sqlType`, `dimensionDetails` en `keys`, etc. Un client resté sur l'ancien contrat ne reçoit pas d'erreur, seulement des objets vides.
- **Effet de bord** : l'introspection n'est aujourd'hui bloquée en production que par le motif texte `__schema`/`__type` (I3), pas par `introspection: false`.
- **Correctif** : supprimer la règle. Test : `POST /graphql {getCatalogs{idd}}` → 400 et `extensions.code = GRAPHQL_VALIDATION_FAILED`.

### B2 — Erreurs avalées en `null` silencieux

- **Code** : `createLoader` (`base-loader.ts:293-301`) : `if (error instanceof GraphQLError) throw error; … return null`. De même `createBatchLoader` (`:338-344`). `validatePagination` lève une `Error` simple (`:417-424`), donc avalée. `getFactTableWithMetadata` ne valide pas la pagination dans le resolver (`fact.ts:171-209`). `fields`, `sort` explicite, `groupBy` et `measure` ne sont contrôlés que par une regex, jamais contre `metadata`.
- **Scénarios prouvés (dev, §5.4)** : `getFactTableWithMetadata(limit: 5000)` → `{"getFactTableWithMetadata":null}` sans `errors` ; `limit: -1` → idem ; `getFactTable(fields:["nope"])` → `null` ; `getAggregatedFacts(measure:"indicator", aggregation: SUM)` → `null`. `/metrics` ne compte pas ces cas comme des erreurs (1 erreur comptée sur 63 requêtes).
- **Correctif** :
  1. `createLoader`/`createBatchLoader` relancent toute erreur. DataLoader l'associe alors à la seule clé concernée.
  2. Un helper `assertColumns(names, metadata)` partagé avec `build-export-query.ts:105-116` pour `fields`, `sort`, `groupBy`, `measure` et `joinFields` → `BAD_USER_INPUT`.
  3. `validatePagination` lève une `GraphQLError` et refuse `limit < 1` et `offset < 0` (sinon `limit: 0` donne `currentPage = Infinity`, `fact.ts:143-146`).
  4. Un test par cas ci-dessus.

### B3 — Rate limiting inopérant derrière le proxy, et contournable

- **Code** : `rate-limiter.ts:122` fait `new Set(TRUSTED_PROXIES as string[])`. La valeur vient de `${TRUSTED_PROXIES:-[]}`, donc d'une **chaîne**, et le Set contient ses caractères (prouvé : `["[","\"","1","0",".","/","8","]"]`). `resolveClientIp` (`:72-87`) compare l'IP exacte et prend le premier élément de XFF. La clé (`:237-242`) est `sha256(ip:user-agent)`. `trust proxy` n'est pas réglé dans Express.
- **Scénarios prouvés** :
  - Même UA : 20 × 200 puis 429.
  - UA tournant : 25 × 200.
  - Deux clients distincts derrière `10.42.0.7` avec `TRUSTED_PROXIES='["10.0.0.0/8"]'` : même compteur (`remaining` 100 puis 99).
- **Impact en production (chart Helm)** : `replicaCount: 2` à 6 et un ingress en `10.x`. Tous les navigateurs d'une même version partagent 100 requêtes par 15 minutes et par pod, et une page de dashboard émet plusieurs requêtes. Sur `main`, le limiteur n'était pas branché : c'est donc une **régression introduite par la branche**.
- **Correctif** :

  ```ts
  // server.ts — avant tout middleware
  app.set('trust proxy', parseProxyList(config.SECURITY.RATE_LIMIT.TRUSTED_PROXIES)); // CIDR acceptés
  // rate-limiter.ts — clé = req.ip (déjà résolue par Express, XFF le plus à droite non fiable)
  ```

  Un seul parseur de liste pour l'export et le limiteur ; retirer l'UA de la clé. Dimensionner `MAX_REQUESTS` sur une vraie session de dashboard (mesure §3.5).

### B4 — Limites du corps JSON incompatibles avec `FilterNode`

- **Code** (`server.ts:113-175`) : `countFields` compte chaque couple clé/valeur de tout le corps (`MAX_FIELDS: 50`). `checkFieldSize` refuse toute chaîne de plus de 1 000 caractères, y compris `query` (`MAX_FIELD_SIZE: 1000`). L'exemption `operationName === 'IntrospectionQuery'` (`:121`) désactive les deux contrôles.
- **Scénarios prouvés** : document de 1 030 caractères → 403 `Field query exceeds maximum allowed size` ; filtre de 8 critères passé en variables → 403 `Too many fields in request` ; même requête renommée `IntrospectionQuery` avec 40 critères → 200.
- **Correctif** : ne plus appliquer `MAX_FIELD_SIZE` à `query`, borner `query` à environ 20 ko ; supprimer `MAX_FIELDS` (l'arbre est déjà borné par `FILTER_TREE.MAX_CRITERIA`/`MAX_DEPTH`/`MAX_IN_VALUES`) ou le porter à environ 500 ; supprimer l'exemption. Le contrôle doit renvoyer 400 et non 403 (un 403 laisse croire à un refus d'autorisation).

### B5 — Agrégats faux sur les NULL

- **Scénarios prouvés** (schéma de test `geography`, §5.4) :
  - `AVG(density)` par département → `Saône-et-Loire: 0` (toutes les densités sont NULL) ;
  - `SUM(population)` par commune → une barre `"null"` ;
  - `MAX(date)` par région → 3 erreurs `Float cannot represent non numeric value: NaN`.
- **Code** : `aggregated-facts.ts:231-233` (`String(row.key)`, `Number(row.aggregatedValue)`) ; SDL `aggregatedValue: Float!`, `key: String!` (`common.ts:32-33`) ; `getTotalGroups` en `COUNT(DISTINCT col)` (`:298`) exclut le groupe NULL que `GROUP BY` inclut. Sur un résultat vide, `valueExtent` vaut `[0, 0]` (`:343`) au lieu de `null`.
- **Correctif** : garder la valeur telle que la renvoie le convertisseur JSON (nombre, chaîne ISO ou `null`) ; SDL `key: String` et `aggregatedValue: Float` (ou `JSON` si les agrégats de dates sont admis, cf. §4) ; contrôler l'agrégation selon la famille de type (`SUM`/`AVG`/`MEDIAN` : famille numérique seulement) ; compter les groupes avec `SELECT COUNT(*) FROM (SELECT 1 … GROUP BY …)`. Supprimer le doublon `fact.ts:32-42`.

### I1 — Invalidation du cache inopérante (bug déjà identifié : **confirmé**)

- **Lecture** : `scanKeys` (`cache-invalidation.ts:107-116`) passe `pattern` tel quel à `redis.scan`. ioredis n'applique pas `keyPrefix` à l'argument `MATCH` et ne retire pas le préfixe des clés renvoyées. `DEL` (`:148`, `:201`) re-préfixerait de plus des clés déjà préfixées.
- **Essai Redis réel** (script, §5.3), avec les deux préfixes :
  - le préfixe effectif par défaut vaut `"'graphql-api:'"`, apostrophes comprises (`config/cache.yaml:22`) ;
  - `scanKeys("facts:default:*")` renvoie `[]` et les deux clés écrites survivent à `invalidateCatalog` et à `invalidateAllCatalogs` ; `getCacheStats` renvoie 0 ;
  - le correctif (motif préfixé, préfixe retiré avant `DEL`) trouve et supprime les clés. Le motif **par schéma** `*:default:main:*` ne trouve pas la clé `facts:default:_:…`, écrite par une requête sans schéma explicite.
- **Essai HTTP réel** : 19 clés, `POST /api/cache/invalidate-all` → `{"success":true}` → toujours 19 ; idem pour `/api/cache/invalidate/default/main`.
- **Même erreur ailleurs ?** Il n'y a pas d'autre `SCAN`/`KEYS` dans `src/` : les trois routes (catalogue, schéma, global) et `/api/cache/stats` passent toutes par `scanKeys`. Deux défauts **indépendants du préfixe** s'y ajoutent, visibles dans les clés réelles (§5.3) :
  1. `schema || '_'` (`base-loader.ts:253`) : l'invalidation par schéma manque toutes les requêtes sans schéma explicite ;
  2. `catalog-metadata`, `dataset-info` et `cross-database` sont créés avec `catalogId: null` (`catalog.ts:40`, `dataset-info.ts:85`, `cross-database.ts:149`). Leurs clés sont toutes `…:default:_:{"catalog":"macroeconomics",…}` : invalider `macroeconomics` ne les touche pas, et invalider `default` les efface pour tous les catalogues. Si aucun catalogue de production ne s'appelle `default`, même `invalidate-all` corrigé les manque. Les docstrings `dataset-info.ts:67-69`, `field-stats.ts:53-57` et `select-options.ts:469-470` affirment le contraire.
- **Correctif** :

  ```ts
  // Préfixe ioredis appliqué au motif, puis retiré des clés avant DEL
  const prefix = (redis as Redis).options.keyPrefix ?? '';
  const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}${pattern}`, 'COUNT', 100);
  keys.push(...batch.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k)));
  ```

  À compléter par :
  - `KEY_PREFIX: ${REDIS_KEY_PREFIX:-graphql-api:}` sans apostrophes ;
  - des segments de clé toujours résolus (`this.catalogId ?? defaultCatalog`, `resolvedSchema()`) ;
  - un hook `cacheNamespace(key)` pour les loaders dont la clé porte catalogue et schéma ;
  - si le préfixe peut contenir `*?[]`, l'échapper dans le motif.

- **Test d'intégration en CI : réaliste.** `.github/workflows/test.yml` démarre déjà un service `redis:7-alpine`. Il suffit d'écrire deux clés via `withCache`, d'appeler `invalidateCatalog`, puis de vérifier leur absence avec un client sans préfixe (`redis.duplicate({ keyPrefix: '' })`). Le test doit **échouer** si `redis.ping()` échoue, car les tests actuels « tiennent aussi Redis coupé » (`field-stats.test.ts:78-80`).

### I2 — Routage par en-têtes incohérent

- **Prouvé** : avec `x-catalog-id: macroeconomics` et `x-schema-id: trade`, sans arguments, `getFactTable` renvoie `null` ; avec les mêmes cibles en arguments, `total: 8`. Cause : `buildFactParams` résout le tri avec `validateCatalogRouting(args.catalog ?? null)` et `args.schema` (`fact.ts:54-55`) et ignore l'en-tête. Le tri par défaut du catalogue `default` (`country, indicator, …`) est appliqué à `trade`, d'où une erreur de binder avalée (B2).
- `getCatalogSchema` avec en-têtes `macroeconomics/trade` renvoie les colonnes de `default.main`. Un en-tête `x-catalog-id: nope` renvoie les données du catalogue par défaut (`total: 1729`).
- **Correctif** : un seul point de résolution (`contextScope`) pour tous les resolvers ; en-tête invalide → erreur ; `CORS.HEADERS` += `x-catalog-id, x-schema-id` (et `apollo-require-preflight` si les GET sont voulus).

### I3 à I11

Le tableau suffit pour ces constats ; leurs preuves sont en §5. Deux précisions :

- **I4** : DataLoader dédoublonne les alias **identiques**. Il suffit donc de varier un argument (`limit: 1…200`) pour multiplier les requêtes SQL. Une seule requête HTTP compte pour 1 dans le rate limiter.
- **I6** : les constats sur le pool (acquisition avant cache, sondage, absence d'interruption) se cumulent. Sous charge, les 5 connexions sont occupées par des requêtes dont le timeout a déjà été renvoyé au client, et les hits de cache attendent 500 ms par tour.

### 3.3 Injection SQL — inventaire des interpolations d'identifiants [L]

| Élément interpolé                                   | Où                                                                                | Garde                                                        | Constat                                                                                                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| catalogue                                           | `base-loader.ts:167-170`, `cross-database.ts:209`, `catalog.ts:68`                | allow-list `ALLOWED_CATALOGS` + guillemets doubles           | OK                                                                                                                                                                        |
| schéma                                              | idem, `database-manager.ts:557`                                                   | allow-list `isValidSchema` (config ∩ découverte) ; non quoté | OK (source de confiance)                                                                                                                                                  |
| `fields`                                            | `base-loader.ts:376-380`                                                          | regex `^[A-Za-z_]\w*$`                                       | Pas d'allow-list `metadata` : colonne inconnue → erreur avalée (B2) ; les mots réservés et fonctions sans parenthèses (`current_date`) passent la regex. Pas d'injection. |
| `sort` explicite                                    | `base-loader.ts:393-407`                                                          | regex + `ASC`/`DESC`                                         | Idem ; le tri **par défaut** est filtré par `metadata` (`default-sort.ts:49-58`)                                                                                          |
| `groupBy`, `measure`, `labelField`                  | `aggregated-facts.ts:188-194`                                                     | regex                                                        | Idem                                                                                                                                                                      |
| `joinFields`                                        | `cross-database.ts:236`                                                           | regex                                                        | Idem                                                                                                                                                                      |
| variables de filtre                                 | `filter-tree.ts:571-600`                                                          | regex + allow-list `metadata` + guillemets                   | OK                                                                                                                                                                        |
| valeurs de filtre                                   | `filter-tree.ts:604-607`                                                          | paramètres liés ; `CAST(? AS <type allow-listé>)`            | OK                                                                                                                                                                        |
| `LIMIT`/`OFFSET`                                    | `fact.ts:114`, `aggregated-facts.ts:223`, `cross-database.ts:275`, `:352`, `:417` | type GraphQL `Int`                                           | OK (entier garanti) ; `limit` négatif → erreur avalée                                                                                                                     |
| `searchTerm`                                        | `select-options.ts:258-261`, `:300-305`                                           | lié + jokers échappés                                        | OK                                                                                                                                                                        |
| export (`fields`, `sort`, `filters`, chemin `COPY`) | `build-export-query.ts:105-131`, `export-runner.ts:129-131`                       | regex + allow-list `metadata` + `escapeSqlString`            | OK                                                                                                                                                                        |
| secrets S3/Postgres                                 | `pool.ts:151-188`, `:278-291`                                                     | valeurs de config échappées                                  | OK (config de confiance)                                                                                                                                                  |

**Conclusion** : aucune injection trouvée. Il reste une recommandation de cohérence : appliquer partout l'allow-list `metadata` de l'export et quoter tous les identifiants.

### 3.4 Code mort et fichiers orphelins [L]

- **Exports utilisés seulement par les tests, ou jamais** :
  - `src/security/validation.ts` (module entier) ;
  - `createSimpleDepthLimitRule` (`depth-limit.ts:130-169`) ;
  - `getSecurityManager` (`manager.ts:289-295`) et `isOperationAllowed` (`manager.ts:246-253`), qui renvoie toujours `true` ;
  - `createLoadersForRequest` (`loaders/index.ts:237-242`), `prime`/`PrimeData` et `clearAll` (`loaders/index.ts:47-65`, `:166-222`) ;
  - `getSchemaVersionStatus` (`schema-version.ts:148`) ;
  - `src/utils/index.ts` (barrel importé nulle part) ;
  - le champ `listFactor` (`complexity-analyzer.ts:23`, `:56`) et `skipFailedRequests` (`rate-limiter.ts:116`), jamais lus.
- **Options YAML jamais lues** :
  - `security.yaml` : `TIMEOUTS.*` (l. 77-83), `SECURITY_LIMITS.MAX_INPUT_LENGTH`, `COMPLEXITY_LIST_FACTOR`, `COMPLEXITY_DEPTH_FACTOR`, `COMPLEXITY.LIST_FACTOR`, `RATE_LIMIT.SKIP_FAILED_REQUESTS` ;
  - `cache.yaml` : `TTL.METADATA`, `FACTS`, `AGGREGATED_FACTS`, `SELECT_OPTIONS`, `COUNT_QUERIES`, `REDIS.DB`, `OPTIONS.CLUSTER` ;
  - `api.yaml` : `PORT` (le serveur lit `process.env.PORT`, `server.ts:543`), `DOMAIN`, `LOADERS.MAX_BATCH_SIZE`, `TIMEOUTS.AGGREGATED_COMPLEX`, `SECURITY_THRESHOLDS.ERROR_TRUNCATION_LENGTH` ;
  - `logging.yaml` : `PERFORMANCE.LOG_SLOW_QUERIES` ;
  - `main.yaml` : `APP_NAME` ;
  - le type `CacheInvalidationConfig` (`config-loader.ts:231-236`), sans section YAML.
- **`config/test/*.yaml`** : jamais chargés par `ConfigLoader` (qui ne lit que `config/*.yaml`), et décrivent l'ancien modèle (`DATABASE_ROUTING`, `test-data/*.db`).
- **`tests/setup/setup-env.ts`** : les variables `DB_PATH`, `TEST_MODE`, `CACHE_TTL`, `MAX_QUERY_COMPLEXITY`, `RATE_LIMIT_MAX`, `METADATA_TIMEOUT`, `SELECT_OPTIONS_TIMEOUT` et `DISABLE_EXTERNAL_SERVICES` ne sont lues nulle part. Le commentaire l. 11 (« config-loader traite "test" comme "development" ») est faux : `validateEnvironment` rejette `test`.
- **SDL** : l'argument `fields` de `getAggregatedFacts*` (`typedefs/fact.ts:163`, `:180`) n'est pas utilisé, mais il entre dans la clé de cache.
- **Middleware « cache HTTP »** (`server.ts:192-201`) : écrasé par Apollo (M14).
- **Fichiers** : `graphql-test-queries.graphql` (M10). `TODO`, `coverage/` et `CLAUDE.md` sont ignorés par git, donc locaux. `TODO` contient déjà l'item « plusieurs opérations associées à plusieurs colonnes, comme pandas.agg » (§4).

### 3.5 Performance — état des lieux et mesures à faire avant d'optimiser

| Loader                           | Batching réel                                                                | N+1 ?                                                                              | Clé de cache                      | TTL           | Remarques                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `metadata`                       | DataLoader regroupe, mais **une requête SQL par clé** sur une même connexion | `partitionFacts` charge N colonnes, soit N requêtes au premier passage, puis Redis | stable, non canonique (M13)       | 600 s         | Dériver de `catalogMetadata`, qui lit toute la table en 1 requête déjà en cache                             |
| `fact*`                          | non (1 clé par requête)                                                      | non                                                                                | SQL compilé + params + tri résolu | 300 s         | `COUNT(*)` complet à chaque page (`total`)                                                                  |
| `aggregatedFacts*`               | non                                                                          | non                                                                                | idem                              | 300 s         | `WithMetadata` refait une lecture de `metadata` (`aggregated-facts.ts:328-331`) déjà en cache via le loader |
| `selectOptions*`                 | non                                                                          | non                                                                                | inclut `labelField` et `maxNodes` | 600 s         | `limit` non borné (I4)                                                                                      |
| `fieldStats`                     | non                                                                          | `Metadata.stats` = N requêtes `COUNT DISTINCT`                                     | inclut le filtre                  | 600 s / 300 s | `approx_count_distinct` possible si l'exactitude n'est pas requise                                          |
| `catalogMetadata`, `datasetInfo` | non (`batchSize: 1`)                                                         | non                                                                                | segment `default:_` (I1)          | 300 s         | —                                                                                                           |
| `compare*`                       | non                                                                          | non                                                                                | idem                              | 300 s         | Jointure explosive (I5)                                                                                     |

Constats transverses :

- **Pool** : voir I6. Une connexion est prise même sur un hit de cache.
- **Pas de single-flight inter-requêtes** : à l'expiration d'un TTL, toutes les requêtes concurrentes ratent le cache et relancent la même requête lourde (_cache stampede_). Supposé [S] : aucun essai de charge n'a été fait.
- **`getLoadersForCatalog`** (`server.ts:470-485`) recrée les 15 loaders à chaque champ racine qui a un argument `catalog`. Le cache DataLoader intra-requête n'est donc pas partagé entre champs racine.
- **DuckDB** : ni `memory_limit`, ni `threads`, ni `temp_directory` ne sont réglés (`pool.ts:266-310`), alors que les pods sont limités à 1 Gi et 1 CPU (`values.yaml:48-54`). Détection de la limite cgroup par DuckDB **non vérifiée** [S].
- **Réponses** : compression activée (seuil 1 ko, niveau 6) ; `Cache-Control: no-store` sur `/graphql`. `getFactTable` répète `{name, value}` à chaque cellule ; `ARRAYS` est 2 à 3 fois plus compact [S, non mesuré].

**Mesures proposées, dans cet ordre, sans rien optimiser à l'aveugle :**

1. Instrumenter (log `debug` ou métriques Prometheus) : durée d'attente d'`acquire()`, durée SQL par requête, hit/miss Redis par préfixe (`INFO stats`, `keyspace_hits`/`keyspace_misses`), taille des réponses.
2. Rejouer une session réelle de dashboard (5 à 10 requêtes par page) avec `autocannon` ou k6, cache froid puis chaud, à 1, 10 et 50 utilisateurs, avec 1 réplica. Relever p50/p95, la file du pool et le RSS du pod.
3. `EXPLAIN ANALYZE` sur un catalogue de production (S3) : `ORDER BY cluster_by` + `LIMIT/OFFSET 10000`, `COUNT(*)` avec et sans filtre, `COUNT(DISTINCT)` des stats, `compareFacts` sur un champ non unique.
4. `SELECT current_setting('memory_limit'), current_setting('threads')` dans un pod ; export parquet de 5 M lignes avec suivi de la mémoire et du disque.
5. Taille des réponses `getFactTable` vs `OBJECTS` vs `ARRAYS`, avec et sans gzip, sur 1 000 lignes.

Selon les résultats : taille du pool, cache consulté avant `acquire`, `total` optionnel ou mis en cache séparément, single-flight.

### 3.6 Forme du code — écarts par fichier (liste exploitable en prompts)

La couverture JSDoc est globalement bonne. TypeDoc donne 0 erreur et 7 avertissements ; un balayage heuristique ne trouve que quelques déclarations sans JSDoc. Les écarts réels portent surtout sur des **commentaires qui mentent** et sur les tests.

**Commentaires ou docstrings faux, ou périmés (à corriger en priorité) :**

- `src/server.ts:394-406` : « Liste blanche des opérations valides / Autorisation de toutes les opérations par défaut » décrit le contraire de l'effet réel (B1). `:192` : « Contrôle du cache HTTP » alors qu'il est écrasé par Apollo.
- `src/cache/cache-invalidation.ts:68-70` : « Cache keys are written … `<type>:<catalog>:<schema>:<queryKey>` … so the patterns here align ». Faux : préfixe, `_`, `default:_` (I1).
- `src/loaders/dataset-info.ts:67-69`, `src/loaders/field-stats.ts:53-57`, `src/loaders/select-options.ts:469-470` : affirment que l'invalidation par préfixe couvre ces clés (faux, I1).
- `src/schema/resolvers/field-stats.ts:82-84` : « N columns = N queries, which the complexity scores … account for ». Faux (I4).
- `src/security/rate-limiter.ts:229-232` : « Trusts x-forwarded-for only when … preventing IP spoofing ». Trompeur (B3).
- `src/loaders/base-loader.ts:294-299` : décrit le filet `null` comme voulu (B2).
- `src/db/database-manager.ts:55-71` : l'exemple de configuration est périmé (`ACQUIRE_TIMEOUT: 10000`, `POOL_RETRY_DELAY: 50`, contre 60000 et 500 en réalité).
- `tests/setup/setup-env.ts:11` : faux (voir §3.4).
- `tests/unit/test_db/schema-contract.test.ts:1-13` et les renvois à `specification-bdd.md` dans `src/` et `tests/` : spécification supprimée ; la nullabilité du contrat diverge du writer (I9).

**Commentaires inline en anglais (à franciser)** : `src/schema/resolvers/catalog.ts:94`, `:159-160`.

**JSDoc manquantes** :

- constructeurs de `DuckDBPool` (`pool.ts:231-232`, seulement « // Initialisation ») et de `DatabaseManager` (`database-manager.ts:88`) ;
- `isRemoteUri` (`database-manager.ts:23`) ;
- constantes exportées sans docstring : `COMPARISON_SQL` (`filter-tree.ts:245`), `DEFAULT_SETTINGS` (`export-params.ts:38`) ;
- avertissements TypeDoc : `ColumnKind`, `FilterTreeConfig`, `PartitionedFact`, `SelectOptionsConfig` non exportés mais référencés ; lien `{@link DatabaseManager}` non résolu (`pool.ts:401-405`) ; `reloadOnePromises` référencé (`pool.ts:448-451`).

**Docstrings au style Python (`Args:`/`Returns:`) au lieu de JSDoc `@param`/`@returns`** :

- `tests/integration/comprehensive.test.ts` (37 blocs), `tests/setup/di-container.ts` (18), `tests/setup/database-manager-injectable.ts` (14), `tests/helpers/mocks.ts` (6) ;
- `tests/unit/test_db/pool.test.ts` (5), `database-di.test.ts` (3), `test_resolvers/helpers.ts` (3), `database.test.ts` (2), `test_security/depth-limit.test.ts` (2).

**Noms et doublons** :

- `DuckDBConnection`/`DuckDBPool` redéclarés comme interfaces dans `base-loader.ts:32-47`, qui masquent les classes homonymes de `@duckdb/node-api` et de `pool.ts` ;
- `AggregationType` défini 3 fois (`loaders/aggregated-facts.ts:18`, `resolvers/aggregated-facts.ts:17`, `resolvers/cross-database.ts:18`) et `VALID_AGGREGATIONS` 2 fois ; `PaginatedFactResult` 2 fois (`loaders/fact.ts:25`, `resolvers/fact.ts:69`) ; `AggregatedFact` 2 fois dans le SDL (M11) ;
- `ServerContext.databaseManager: any` (`server.ts:46-47`) ; `createLoadersForRequest` (alias sans valeur ajoutée) ;
- « database » dans la doc et les routes historiques (`/api/cache/invalidate/:database`) au lieu de « catalog ».

**Doc générée et CHANGELOG** :

- TypeDoc OK (voir ci-dessus).
- `docs-site` : pages sécurité et cache périmées (I10). `docs:build` n'a pas été lancé (§6).
- `CHANGELOG.md` s'arrête à 0.2.0, ce qui est normal : release-please générera 0.3.0 à partir des `feat!:`. L'entrée 0.2.0 « multi measure type for fact requests (before was only "value") » est contredite par `compare*` (I5).

---

## 4. Clé-mesure multi-opérations

### 4.1 État actuel (vérifié)

- **Constat préliminaire confirmé [L][E]** (`schema.graphql:40-85`, `:242-257`) :
  - `getAggregatedFacts` et `getAggregatedFactsWithMetadata` n'acceptent qu'un `groupBy: String!`, une `measure: String!` et une `aggregation: Aggregation` ;
  - `compareAggregatedFacts` n'a **même pas** d'argument `measure` : elle agrège la colonne `value`, codée en dur (`cross-database.ts:333`), comme `compareFacts` (`:209`) ;
  - aucune requête n'offre d'agrégat **sans** `groupBy` (total global) : `groupBy` est obligatoire et doit être une colonne.
- **Contournement possible aujourd'hui** : des alias GraphQL dans une même requête HTTP (`a: getAggregatedFacts(measure:"value", aggregation: SUM) b: getAggregatedFacts(measure:"lower_bound", aggregation: MAX)`). Mais :
  1. chaque alias produit une requête SQL et un `COUNT` ;
  2. les résultats ne sont pas alignés (pagination et tri propres à chaque alias) et le front doit les joindre par `key` ;
  3. `measureFieldInfo` est dupliqué ;
  4. le coût en complexité s'additionne.

  Le besoin (a) + (b) n'est donc couvert ni en une requête SQL, ni sans recalcul côté front.

- **`getFactTable` et `FieldStats`** :
  - `getFactTable` ne fait aucune agrégation ;
  - `FieldStats` donne `min`, `max`, `distinctCount` et `nullCount` pour **une** colonne ; plusieurs colonnes demandent plusieurs alias, donc plusieurs requêtes ;
  - pas de `SUM`, `AVG` ni `MEDIAN`.

  Le cas « agrégé sans groupBy » **n'est pas couvert**, sauf `MIN`/`MAX`/`COUNT` via `getFieldStats`.

### 4.2 Design proposé — additif, un seul chemin SQL

Recommandation : **ajouter** une requête `getAggregates` (non cassante pour `schema:diff`), puis réimplémenter `getAggregatedFacts*` sur le même constructeur SQL, qui deviennent un cas particulier (un agrégat, un `groupBy`). La nullabilité de B5 est corrigée dans la même fenêtre. `getAggregatedFacts*` passe en `@deprecated` en 0.4.0, selon la politique de `api-versioning.md`.

Une rupture franche (remplacer directement `getAggregatedFacts`) serait gratuite **avant** le tag 0.3.0. Elle n'est pas recommandée : le frontend utilise l'API actuelle (`useFactTable`, graphiques) et la migration peut être progressive.

```graphql
"Un agrégat demandé : une mesure, une opération, un nom de colonne de sortie"
input AggregateInput {
  "Colonne agrégée (doit exister dans metadata)"
  measure: String!
  "Absente : metadata.defaultAggregation de la mesure, puis SUM (famille numérique) — sinon BAD_USER_INPUT"
  aggregation: Aggregation
  "Nom de la colonne résultat, ^[a-z_][a-z0-9_]*$, unique ; défaut : <measure>_<aggregation> en minuscules"
  alias: String
}

input AggregateSortInput {
  "Alias d'un agrégat ou colonne de groupBy"
  by: String!
  order: SortOrder = ASC
}

"Description d'une colonne d'agrégat : le front n'a rien à recalculer"
type AggregateColumn {
  alias: String!
  measure: String!
  aggregation: Aggregation!
  "Type SQL du résultat : SUM(BIGINT) → HUGEINT, AVG → DOUBLE, MIN/MAX/MODE → type de la mesure, COUNT → BIGINT"
  sqlType: String!
  "Unité : celle de la mesure, sauf COUNT (null)"
  unit: String
  "Format d3 : celui de la mesure, sauf COUNT (\",d\") et AVG d'un entier (celui de la mesure avec décimales)"
  displayFormat: String
  "Métadonnées complètes de la mesure (label, family, description, stats paresseuses…)"
  field: Metadata!
  "[min, max] de la page (nombres ou dates ISO), null si vide"
  extent: JSON
}

type AggregateResult {
  "Colonnes de regroupement, dans l'ordre"
  groupBy: [String!]!
  groupFields: [Metadata!]!
  aggregates: [AggregateColumn!]!
  "Ordre des colonnes de data : groupBy, libellés (<col>__label), alias, row_count"
  columns: [String!]!
  "Lignes OBJECTS ou ARRAYS, typées par le convertisseur JSON unique (NULL préservé)"
  data: [JSON!]!
  "Nombre de groupes (1 sans groupBy), groupe NULL compris"
  total: Float!
  hasNextPage: Boolean!
  generatedAt: String!
}

extend type Query {
  getAggregates(
    "Vide : agrégat global, une seule ligne"
    groupBy: [String!] = []
    aggregates: [AggregateInput!]!
    structuredFilters: FilterNode
    sort: [AggregateSortInput!]
    limit: Int! = 100
    offset: Int! = 0
    format: DataFormat = OBJECTS
    "Ajoute COUNT(*) sous l'alias row_count"
    includeRowCount: Boolean = true
    catalog: String
    schema: String
  ): AggregateResult!
}
```

Exemple de ligne `OBJECTS` pour `groupBy: ["country"]` et `aggregates: [{measure:"value", aggregation: SUM}, {measure:"value", aggregation: AVG}, {measure:"lower_bound", aggregation: MAX}]` :

```json
{
  "country": "France",
  "value_sum": 1234.5,
  "value_avg": 12.3,
  "lower_bound_max": 17.2,
  "row_count": 100
}
```

SQL généré (une requête, plus une requête de comptage en cache séparé) :

```sql
SELECT "country",
       ANY_VALUE("country_libelle") AS "country__label",     -- si colonne de libellés (règle resolveLabelField)
       SUM("value") AS "value_sum", AVG("value") AS "value_avg",
       MAX("lower_bound") AS "lower_bound_max", COUNT(*) AS "row_count"
FROM "cat".schema.fact_table
WHERE <treeToSQL>
GROUP BY "country"
ORDER BY <sort>, "country" ASC          -- départage systématique par les colonnes de groupe
LIMIT ? OFFSET ?;
SELECT COUNT(*) FROM (SELECT 1 FROM … WHERE … GROUP BY "country");   -- groupe NULL compris
```

### 4.3 Impacts

| Domaine                      | Impact                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SQL**                      | Un constructeur unique `buildAggregateQuery(params, metadata)`. Identifiants contrôlés contre `metadata` (B2), alias quotés, familles de type contrôlées : `SUM`/`AVG`/`MEDIAN` → famille numérique ; `MIN`/`MAX` → numérique ou date ; `MODE`/`COUNT` → toutes (corrige B5). Les valeurs passent par `jsonValueConverter`, donc HUGEINT au-delà de 2^53 → chaîne, NULL → `null`.                                           |
| **Cache**                    | Clé = paramètres **résolus** : agrégation effective (après `defaultAggregation`), alias par défaut calculés, `groupBy` et `aggregates` **dans l'ordre client** (l'ordre fixe celui des colonnes, on ne trie pas), filtre compilé, tri effectif avec départage. Préfixe `aggregated-facts`, variante `multi` : l'invalidation existante (corrigée en I1) couvre ces clés. Hacher le suffixe (M13).                           |
| **Sécurité / complexité**    | Config `AGGREGATES.MAX_AGGREGATES` (par exemple 20) et `MAX_GROUP_BY` (par exemple 4) → `BAD_USER_INPUT` au-delà. Score : base 10, plus 2 par agrégat, plus 5 par `MEDIAN`/`MODE` (agrégats holistiques coûteux), plus 3 par colonne de groupe. `calculateArgumentsComplexity` doit lire la **longueur** des listes `aggregates`/`groupBy` (variables déjà résolues, `complexity-analyzer.ts:203-206`).                     |
| **Tri / pagination**         | Tri par alias ou colonne de groupe (validés) ; départage obligatoire par les colonnes de groupe (corrige M5) ; `offset ≤ MAX_OFFSET` ; `total` inclut le groupe NULL (corrige B5).                                                                                                                                                                                                                                          |
| **`defaultAggregation`**     | Même règle qu'aujourd'hui, appliquée **par agrégat** : argument, puis `metadata.default_aggregation`, puis `SUM`. `SUM` n'est retenu que si la mesure est numérique ; sinon `BAD_USER_INPUT` nommant les agrégations permises. L'agrégation effective entre dans la clé.                                                                                                                                                    |
| **`compareAggregatedFacts`** | Ajouter `aggregates: [AggregateInput!]` et `groupBy: [String!]`, et supprimer la mesure `value` codée en dur. Forme proposée, cohérente avec `getAggregates` : colonnes `<alias>_a`, `<alias>_b`, `<alias>_delta`, `<alias>_delta_pct` dans `data: [JSON!]!`, avec `aggregates: [AggregateColumn!]!`. `ComparedFact` reste pour l'API actuelle.                                                                             |
| **Codegen**                  | `npm run codegen` génère `QueryGetAggregatesArgs`, `AggregateInput`, `AggregateResult` ; les resolvers se typent via `QueryResolvers` (pattern déjà en place pour select-options et metadata). `codegen:check` en CI.                                                                                                                                                                                                       |
| **SDL versionné**            | Additions seulement : `schema:diff` = non-breaking. La correction de B5 (`Float!` → `Float`, `String!` → `String`) est une rupture de type « plus permissif en sortie » : à faire **avant** le tag 0.3.0, où elle ne coûte rien (`schema:diff` : v0.2.0 sans SDL).                                                                                                                                                          |
| **Export REST**              | Paramètres `groupBy=country,year` et `aggregates=value:sum,value:avg:moyenne,lower_bound:max`, réutilisant `buildAggregateQuery`. **Attention** : `arrow-writer.ts` ne gère ni HUGEINT ni UHUGEINT (seuls TINYINT…UBIGINT, FLOAT, DOUBLE, DECIMAL, dates et BOOLEAN ont un convertisseur, `arrow-writer.ts:79-131`), alors que `SUM(BIGINT)` en produit : ajouter un `CAST` en DOUBLE ou DECIMAL(38), ou étendre le writer. |
| **Frontend**                 | `columns`, `aggregates[].unit/displayFormat/extent` et `groupFields` suffisent pour les axes, les en-têtes et les tooltips, sans seconde requête.                                                                                                                                                                                                                                                                           |
| **Effort**                   | `getAggregates` avec tests et doc : 2 à 3 j ; multi-agrégats de `compareAggregatedFacts` : 1 j ; export agrégé : 1 j.                                                                                                                                                                                                                                                                                                       |

---

## 5. Résultats bruts des commandes lancées

### 5.1 Contrôles statiques (Git Bash, `npm run …`)

```text
lint exit=0            > eslint src/ --ext .ts,.js            (aucune sortie)
type:check exit=0      > tsc --noEmit                          (aucune sortie)
schema:check exit=0    Schema SDL written to …\schema.graphql
                       schema.graphql est à jour.
codegen:check exit=0   ✔ Generate to src/generated/graphql.ts
                       src/generated/graphql.ts est à jour.
schema:diff exit=0     v0.2.0 ne contient pas schema.graphql (première release avec ce contrat) : rien à comparer.
typedoc (sortie redirigée vers un dossier temporaire)
                       Found 0 errors and 7 warnings (ColumnKind, FilterTreeConfig, PartitionedFact,
                       QueryResolvers, SelectOptionsConfig non inclus ; lien DatabaseManager non résolu ;
                       reloadOnePromises référencé)
```

`git status` après toutes les commandes : inchangé (seul `?? prompts-audit-api.md`, préexistant).

### 5.2 Tests

```text
npm run test:setup   exit=0
  [default.main] 1729 records inserted
  [default.predictions] 72 records inserted
  [default.geography] 14 records inserted
  [default.trade] 30 records inserted
  [default.unsupported_version] 8 records inserted
  [default.missing_dataset_metadata] 8 records inserted
  [macroeconomics.main] 1729 records inserted
  [macroeconomics.trade] 8 records inserted
  [public_finance.main] 1729 records inserted
  Test DuckLake catalogs ready.

npm test   exit=0
  Test Suites: 62 passed, 62 total
  Tests:       1324 passed, 1324 total
  Time:        104.116 s
  Force exiting Jest: Have you considered using `--detectOpenHandles` …   (forceExit: true dans jest.config.js)
  [WARN] Redis server does not require a password, but a password was supplied.   (répété — cf. M4)
```

Les tests utilisent le Redis local réel (préfixe `test:api:`) et y laissent environ 219 clés avec TTL.

### 5.3 Redis réel — invalidation (script jetable, Redis 5.0.14 local)

```text
keyPrefix effectif = "'graphql-api:'"                       ← défaut de config/cache.yaml
clés brutes après écriture = [ `'graphql-api:'facts:default:_:{"audit":1}`, `'graphql-api:'facts:default:main:{"audit":2}` ]
scanKeys("facts:default:*") = []
clés brutes après invalidateCatalog + invalidateAllCatalogs = [ …les deux mêmes clés… ]
getCacheStats().default.main.facts = 0
correctif, motif par schéma "*:default:main:*" = [ 'facts:default:main:{"audit":2}' ]      ← la clé "_" est manquée
correctif, motif catalogue "*:default:*:*" = [ 'facts:default:_:{"audit":1}', 'facts:default:main:{"audit":2}' ]
clés brutes après DEL corrigé = []
(même résultat avec REDIS_KEY_PREFIX=graphql-api: sans apostrophes)

Clés laissées par la suite de tests (extrait) :
test:api:catalog-metadata:default:_:{"catalog":"public_finance","schema":"main"}
test:api:dataset-info:default:_:{"catalog":"macroeconomics","schema":"trade"}
test:api:cross-database:default:_:{"catalogA":"default","catalogB":"macroeconomics",…}
test:api:catalog-metadata:default:_:{"catalog":"default","schema":null}  /  …:{"catalog":"default"}   ← doublons (M13)
```

### 5.4 API réelle (`npm start` sur les catalogues de test)

```text
── dev (port 4555)
POST /graphql en-têtes : X-Powered-By: Express | Access-Control-Allow-Headers: Content-Type, Authorization
                         cache-control: no-store | Vary: accept-encoding, accept | X-RateLimit-Limit: 100
getFactTableWithMetadata(limit: 5000)      → {"data":{"getFactTableWithMetadata":null}}
getFactTableWithMetadata(limit: -1)        → {"data":{"getFactTableWithMetadata":null}}
getFactTable(fields:["nope"])              → {"data":{"getFactTable":null}}
getAggregatedFacts(measure:"indicator",SUM)→ {"data":{"getAggregatedFacts":null}}
POST /api/cache/invalidate-all             → {"success":true} ; clés audit: 19 avant, 19 après
POST /api/cache/invalidate/default/main    → {"success":true} ; 19 après
GET  /api/cache/stats                      → tous les compteurs à 0
x-catalog-id: macroeconomics + x-schema-id: trade, getFactTable(limit:2) → {"data":{"getFactTable":null}}
getFactTable(limit:2, catalog:"macroeconomics", schema:"trade")          → total 8
x-catalog-id: macroeconomics + x-schema-id: trade, getCatalogSchema      → colonnes de default.main
x-catalog-id: nope, getFactTable                                         → total 1729 (catalogue par défaut)
AVG(density) par departement (geography)   → … {"key":"Saône-et-Loire","aggregatedValue":0,"count":2} …
SUM(population) par commune                → … {"key":"null","aggregatedValue":211500,"count":2}
MAX(date) par region                       → 3 × "Float cannot represent non numeric value: NaN"
UA fixe, 25 requêtes                       → 200 ×20 puis 429 ×5
UA tournant, 25 requêtes                   → 200 ×25
X-Forwarded-For usurpé (TRUSTED_PROXIES vide) → 429 (non pris en compte : correct)
30 mauvaises clés admin                    → 401 ×30 (aucune limitation)
GET /metrics                               → public ; requests.errors = 1 sur 63

── production (port 4556)
{ __schema { … } }                         → FORBIDDEN_PATTERN (masqué "An error occurred")
{ getCatalogs { id __typename } }          → FORBIDDEN_PATTERN
getFactTable(limit: 5000)                  → "An error occurred", code INTERNAL_SERVER_ERROR
filtre sur colonne inconnue                → "An error occurred", code BAD_USER_INPUT (message masqué)
{ getFactTable(limit: 1) { totl } }        → {"data":{"getFactTable":{}}}
{ getCatalogs { idd } }                    → HTTP 200 {"data":{"getCatalogs":[{},{},{}]}}
{ getCatalogs(foo: 1) { id } }             → HTTP 200 (ids renvoyés)
{ getCatalogs }                            → HTTP 200 [{},{},{}]
alias "a" en conflit                       → HTTP 200 {"data":{"a":{"name":"value"}}}
{ getCatalogs { ...Nope } }                → HTTP 200
JSON invalide                              → {"error":"Internal server error"} (au lieu d'un 400)

── dev (port 4557), limites du corps
document de 1 030 caractères               → 403 Field query exceeds maximum allowed size
filtre en variables, 8 critères            → 403 Too many fields in request
filtre en variables, 12 critères           → 403 Too many fields in request
opération renommée IntrospectionQuery, 40 critères, +1 000 car. → 200 {"getFactTable":{"total":1729}}
```

### 5.5 Scripts ciblés

```text
PatternValidator, NODE_ENV=production :
  REJETÉE   Apollo Client (__typename) -> Type introspection is disabled in production
  REJETÉE   searchTerm "ecosystem" -> System table access is forbidden
  REJETÉE   colonne "mutation_rate" -> Mutations are not allowed in this read-only API
  ACCEPTÉE  même valeur via variables
Complexité (MAX_ALLOWED = 200) :
  getCatalogSchema { name stats { min max distinctCount } }  16
  1 x compareFacts(joinFields:["kind"], limit:1000)           13
  50 alias compareFacts(...){total}                           50
  30 alias getAggregatedFactsWithMetadata(limit:1000)         375
  40 alias getFieldStats(fieldName:"value")                   200
  20 alias getCatalogSchema { stats {min} }                   320
  60 alias getSelectOptions(limit: 1000000)                   660   (11 par alias, quel que soit le limit)
RateLimiter, TRUSTED_PROXIES='["10.0.0.0/8"]' :
  TRUSTED_PROXIES lu dans la config : "[\"10.0.0.0/8\"]" string
  Set interne du RateLimiter : ["[","\"","1","0",".","/","8","]"]
  deux clients distincts derrière l'ingress -> même compteur ? remaining: 100 99
DuckDBPool(maxConnections=2), 10 acquire() concurrents à froid -> taille du pool = 10
withCache avec un loader en échec -> exécuté 2 fois
graphql-test-queries.graphql validé contre schema.graphql -> 92 opérations, 17 invalides
  (ex. TestGetMetadata -> Cannot query field "sql_type" on type "Metadata". Did you mean "sqlType"?)
```

### 5.6 `npm audit` (2026-09-26)

```text
npm audit (toutes dépendances) : 8 vulnerabilities (2 low, 2 moderate, 4 high) — "fix available via `npm audit fix`"
  body-parser 2.0.0-2.2.2  DoS quand une limite invalide désactive le contrôle de taille (GHSA-v422-hmwv-36x6)
  brace-expansion (high, dev)  DoS multiples (GHSA-jxxr-4gwj-5jf2, -3jxr-9vmj-r5cp, -mh99-v99m-4gvg, -rgw5-rvv9-x895)
  esbuild 0.27.3-0.28.0 (dev)  lecture de fichier arbitraire du serveur de dev sous Windows (GHSA-g7r4-m6w7-qqqr)
  fast-uri 3.0.0-3.1.5 (high, dev)  confusion d'hôte / SSRF (6 avis)
  js-yaml (high, dev)  DoS quadratiques (4 avis)
  linkify-it <=5.0.1 (high, dev), markdown-it <=14.1.1 (moderate, dev)
  qs 2.2.5-6.15.3 (moderate)  DoS / contournement de arrayLimit (3 avis)
npm audit --omit=dev : 2 vulnerabilities (1 low, 1 moderate) — body-parser, qs (dépendances d'express)
```

Lecture : en production, seuls `body-parser` et `qs` sont concernés. La limite `'100kb'` est valide, donc l'avis body-parser ne s'applique pas tel quel ; `qs` parse la query string de `/api/export`. `npm audit fix` suffit et est à faire avant la release.

**Dépendances modifiées par la branche** : ajout de `apache-arrow` ; retrait de `xss` (sanitization supprimée) ; ajouts dev `@graphql-codegen/*`, `@graphql-inspector/core`, `supertest`, `@types/supertest`.

---

## 6. Ce que je n'ai PAS pu vérifier, et pourquoi

- **Données et charge de production** : pas d'accès aux catalogues S3 ni au trafic réel. Les coûts cités (`COUNT(*)` par page, `COUNT DISTINCT` de `stats`, explosion de `compareFacts`) sont déduits du SQL généré, pas mesurés (voir le protocole en §3.5).
- **Comportement mémoire de DuckDB dans un pod limité à 1 Gi** (prise en compte de la limite cgroup par `memory_limit`) : non testé, pas de cluster disponible.
- **Arrêt gracieux (I8)** : SIGTERM n'a pas été rejoué (Windows, pas de pod). Le constat repose sur la lecture de `server.ts:512-548`.
- **Rate limiting multi-réplicas et derrière un vrai ingress** : simulé par script (`checkLimit` avec `socket.remoteAddress` et XFF), pas déployé.
- **Contournement de `introspection: false` par B1** : non observable tant que le motif `__schema` d'I3 bloque ; déduit du fonctionnement de `visitInParallel` et de la règle d'Apollo.
- **Mode cluster Redis** : la config n'est pas atteignable (M4), donc rien à tester.
- **Requêtes concurrentes sur une même connexion DuckDB** (`Promise.all` dans `createLoader` et `compareFacts`) : les tests passent, sans essai de charge. Fonctionnel, mais sérialisé [S].
- **`npm run docs:build` complet (Docusaurus)** : non lancé, car il réécrit des répertoires générés du dépôt (ignorés par git) et demande une API démarrée. TypeDoc a été exécuté vers un dossier temporaire.
- **Écart entre la fixture et le writer** : comparé au clone local de `dt_ducklake_manager` (`v0.3.1-5-g71d8fc9`). Le writer de production peut être d'une autre version.
- **`updated_at` suffixé `Z`** (`dataset-info.ts:34`) : suppose que le writer écrit en UTC ; non vérifié dans le writer [S].
- **Frontend** : seul son usage de `graphql-request` et de `$structuredFilters` en variables a été vérifié par recherche ; aucun parcours réel n'a été joué.
