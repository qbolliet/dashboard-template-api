# Prompts d'implémentation — correctifs de `audit-api.md` et `audit-integration.md`

> Un prompt par correctif ou par lot cohérent, à lancer **chacun dans une session Claude Code
> fraîche**, depuis la racine du dépôt indiqué. Ordre et dépendances : `audit-integration.md` §4.
> Chaque prompt se suffit à lui-même ; les fichiers d'audit donnent seulement le détail des preuves.
>
> **Règles communes** (rappelées dans chaque prompt) :
>
> - Claude Code ne lance **jamais** `git add`, `git commit` ni `git push`. Il termine par un
>   message de commit conventionnel **proposé**, dans un bloc de code ; le commit est fait à
>   la main après relecture, **avant** le prompt suivant.
> - Commentaires en français (formulations nominales), docstrings en anglais (Google : JSDoc
>   `@param`/`@returns`/`@throws` pour TS/JS, `Args:`/`Returns:`/`Raises:` pour Python).
> - Avant le tag 0.3.0 de l'API, une rupture du SDL est gratuite (`schema:diff` : v0.2.0 sans
>   SDL). Après, toute rupture suit `docs-site/toolbox/docs/api-versioning.md` (`@deprecated`).
> - Toute modification de typedef : `npm run schema:generate` puis `npm run codegen`, et
>   commiter `schema.graphql` et `src/generated/graphql.ts`.
>
> **Grille modèle / effort / plan mode.** Sonnet 5 + medium + sans plan pour les correctifs
> mécaniques bien délimités. Opus 5.5 + high + plan pour les changements de contrat, de
> sécurité ou de conception. Chaque prompt justifie ses écarts à cette grille.
>
> | #   | Dépôt | Constats                                 | Modèle | Effort | Plan |
> | --- | ----- | ---------------------------------------- | ------ | ------ | ---- |
> | A1  | API   | B1, B4, AF2                              | Sonnet | medium | non  |
> | A2  | API   | B2, BA3, M7                              | Opus   | high   | oui  |
> | A3  | API   | B3, M1                                   | Opus   | high   | oui  |
> | A4  | API   | I2, M3, AF3 (API)                        | Sonnet | high   | non  |
> | A5  | API   | B5, M5, M6, M11                          | Opus   | high   | oui  |
> | A6  | API   | I1, M4, M12, M13                         | Sonnet | medium | non  |
> | A7  | API   | BA7                                      | Opus   | high   | oui  |
> | A8  | API   | I6, I7                                   | Opus   | high   | oui  |
> | A9  | API   | I3, I4, I11                              | Opus   | high   | oui  |
> | A10 | API   | BA1, BA2 (API), BA5, BA6, BA8            | Sonnet | high   | non  |
> | A11 | API   | AF4 (API)                                | Opus   | high   | oui  |
> | A12 | API   | EX1, EX2                                 | Opus   | high   | oui  |
> | A13 | API   | EX3 (M8), EX4, EX5, EX6, EX7             | Sonnet | high   | non  |
> | A14 | API   | `audit-api.md` §4, AF10 (API)            | Opus   | high   | oui  |
> | A15 | API   | I5, compare\* multi-agrégats, EX8        | Opus   | high   | oui  |
> | A16 | API   | I8, M2, `npm audit`                      | Sonnet | medium | non  |
> | A17 | API   | I9                                       | Sonnet | medium | non  |
> | A18 | API   | I10, M9, M10, M14, §3.6                  | Sonnet | medium | non  |
> | D1  | Base  | BA2, BA4, BA9, BA10, BA3 (avertissement) | Sonnet | high   | non  |
> | F1  | Front | AF14                                     | Sonnet | medium | non  |
> | F2  | Front | AF1, AF3, AF4, AF8 (front)               | Opus   | high   | oui  |
> | F3  | Front | AF5, AF13                                | Opus   | high   | oui  |
> | F4  | Front | AF6, AF7, AF15                           | Sonnet | medium | non  |
> | F5  | Front | AF12                                     | Sonnet | medium | non  |
> | F6  | Front | AF9, AF11                                | Sonnet | high   | non  |
> | F7  | Front | AF10 (front)                             | Opus   | high   | oui  |

---

## A1 — Pipeline de requête : validation GraphQL, limites du corps, crash de complexité

- **Modèle : Sonnet 5.** Les trois correctifs sont localisés et leur forme est connue.
- **Effort : medium.** Pas de conception, seulement des tests HTTP à écrire.
- **Plan mode : non.** La spécification ci-dessous tient lieu de plan.
- **Dépôt / branche** : `dashboard-template-api`, `qb-schemav2-adaptation`.

```text
Contexte : trois défauts prouvés sur l'API réelle bloquent la fusion de la branche.
1) B1 — src/server.ts:395-408 : une règle de validation « liste blanche » renvoie true sur
   chaque OperationDefinition ; visitInParallel l'interprète comme « sauter le sous-arbre »
   pour TOUTES les règles. Champs inconnus, arguments inconnus, sélections manquantes,
   fragments inconnus passent (HTTP 200, objets vides) ; la règle NoIntrospection d'Apollo
   est court-circuitée.
2) B4 — src/server.ts:113-175 et config/api.yaml (REQUEST_LIMITS) : le verify d'express.json
   refuse (403) tout document de plus de 1 000 caractères (MAX_FIELD_SIZE s'applique à
   `query`) et tout corps de plus de 50 champs JSON : un FilterNode de 8 critères passé en
   variables est rejeté. Nommer l'opération IntrospectionQuery contourne les deux contrôles
   (:121).
3) AF2 — src/security/complexity-analyzer.ts:203-210 et :231-242 : quand l'argument limit
   est une variable omise (valeur par défaut `$limit: Int = 50`) ou nulle,
   extractNumericValue lit `.kind` sur undefined → 500 « Cannot read properties of
   undefined (reading 'kind') ». Prouvé : query A($f: String!, $l: Int = 50) {
   getSelectOptions(fieldName: $f, limit: $l) { value } } sans l → 500, avec l=5 → 200.

À faire :
- B1 : supprimer la règle (ou renvoyer undefined) et le commentaire faux qui l'accompagne.
- B4 : ne plus appliquer MAX_FIELD_SIZE à `query` ; borner `query` par une taille dédiée
  (config, ~20 ko) ; supprimer MAX_FIELDS ou le porter à ~500 (l'arbre est déjà borné par
  SECURITY.FILTER_TREE.MAX_CRITERIA / MAX_DEPTH / MAX_IN_VALUES) ; supprimer l'exemption
  IntrospectionQuery ; répondre 400 (et non 403) avec un corps JSON explicite.
- AF2 : résoudre les variables à partir des valeurs coercées (getVariableValues de graphql
  avec operation.variableDefinitions), ou à défaut retomber sur defaultValue de la
  définition de variable ; valeur absente ou null → défaut du champ (limit par défaut du
  SDL) ; jamais d'exception.

Critères d'acceptation :
- POST /graphql {getCatalogs{idd}} → 400, extensions.code = GRAPHQL_VALIDATION_FAILED ;
  idem pour un argument inconnu, une sélection manquante, un fragment inconnu.
- Un getFactTable avec un FilterNode de 40 critères en variables → 200 ; un document de
  5 000 caractères → 200 ; un corps > limite configurée → 400.
- La requête AF2 ci-dessus sans l → 200 ; avec limit: null → 200.
- En NODE_ENV=production, une requête d'introspection est refusée par Apollo
  (introspection: false), sans dépendre du motif texte __schema.

Tests (supertest, tests/integration/) : un test par critère ci-dessus. Tests unitaires de
l'analyseur : variable avec défaut omise, variable null, littéral, variable fournie.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions : commentaires français, docstrings anglaises Google. Ne commite pas ; propose :
fix(security): restore GraphQL validation, relax body limits and fix complexity on defaulted variables
```

---

## A2 — Erreurs propagées et identifiants contrôlés contre `metadata`, puis quotés

- **Modèle : Opus 5.5.** Invariant de sécurité (injection) et gestion d'erreurs répartis dans tous les loaders.
- **Effort : high.** Beaucoup d'appelants ; une erreur avalée de trop et le défaut reste invisible.
- **Plan mode : oui.** Le plan doit lister chaque appelant avant d'écrire.
- **Dépôt / branche** : `dashboard-template-api`, `qb-schemav2-adaptation`.

```text
Contexte :
- B2 : src/loaders/base-loader.ts:293-301 (createLoader), :338-344 (createBatchLoader)
  avalent toute erreur qui n'est pas une GraphQLError et renvoient null ou [] ; le client
  reçoit null SANS errors (limit hors bornes, limit négatif, colonne inconnue dans
  fields/sort/groupBy/measure, SUM sur VARCHAR, panne S3). validatePagination (:417-424)
  lève une Error simple ; getFactTableWithMetadata ne valide pas la pagination
  (src/schema/resolvers/fact.ts:171-209).
- BA3 : la base accepte tout nom de colonne (prouvé : « Année », « taux chômage ») alors que
  l'API impose ^[a-zA-Z_][a-zA-Z0-9_]*$ (src/utils/utils.ts:19) et retire en silence ces
  colonnes du tri par défaut (src/utils/default-sort.ts:49-58). Les schémas ne sont pas
  quotés : "${catalog}".${schema} (src/loaders/catalog.ts:68, dataset-info.ts:113,
  src/db/database-manager.ts:557, base-loader.ts:167-170).
- M7 : MATCHES est validé par RegExp (JS) mais exécuté par RE2 (filter-tree.ts:648-656) :
  un lookbehind passe la validation puis fait échouer DuckDB.
Le seul chemin déjà correct est l'export : il contrôle les colonnes contre metadata
(src/export/build-export-query.ts:105-116).

À faire :
1) createLoader / createBatchLoader relancent toute erreur ; DataLoader l'attache à la clé
   concernée. Les erreurs DuckDB non-GraphQL deviennent INTERNAL_SERVER_ERROR avec un
   errorId (déjà produit par formatError) ; une erreur de binder ou de conversion due à
   l'entrée utilisateur (colonne, type, regex RE2) devient BAD_USER_INPUT.
2) validatePagination lève une GraphQLError BAD_USER_INPUT : limit ≥ 1, limit ≤ MAX_LIMIT,
   offset ≥ 0, offset ≤ MAX_OFFSET ; appelée par TOUS les resolvers paginés.
3) Helper unique src/utils/identifiers.ts : assertColumns(names, metadataByName, context)
   → BAD_USER_INPUT listant les colonnes inconnues ; quoteIdent(name) (guillemets doublés).
   Tout identifiant interpolé (fields, sort, groupBy, measure, labelField, joinFields,
   variables de filtre, tri par défaut, export) passe par assertColumns puis quoteIdent ;
   validateIdentifier ne sert plus qu'aux catalogues (allow-list), sinon il disparaît. Les
   schémas sont quotés partout. Le tri par défaut garde les colonnes connues de metadata,
   quel que soit leur nom.
4) MATCHES : rejeter en BAD_USER_INPUT les constructions non supportées par RE2 (lookaround,
   rétro-références), ou mapper l'erreur DuckDB correspondante.
5) Docstring de base-loader.ts:294-299 (qui décrit le filet null comme voulu) corrigée.

Plan attendu avant d'écrire : liste exhaustive des interpolations d'identifiants (grep
`${` dans src/loaders, src/utils, src/export) avec le traitement retenu pour chacune.

Critères d'acceptation :
- getFactTableWithMetadata(limit: 5000), (limit: -1), (limit: 0), (offset: -1) →
  errors BAD_USER_INPUT, data null.
- getFactTable(fields:["nope"]) → BAD_USER_INPUT nommant "nope".
- getAggregatedFacts(measure:"indicator", aggregation: SUM) → BAD_USER_INPUT.
- Une colonne nommée « taux chômage » (ajoutée à un schéma de test dédié dans
  tests/setup/setup-test-data.ts) est projetable, filtrable, triable et groupable.
- Aucune erreur n'est plus convertie en null silencieux (grep `return null` dans les catch
  des loaders : justifié ligne par ligne).

Tests : chaque critère ; test unitaire de quoteIdent (guillemet dans le nom) et
d'assertColumns ; MATCHES avec (?<=a)b → BAD_USER_INPUT.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
fix: propagate loader errors and check every identifier against metadata
```

---

## A3 — Rate limiting derrière le proxy, clé admin

- **Modèle : Opus 5.5.** Sécurité : identification du client derrière un ingress.
- **Effort : high.** L'effet dépend de la topologie réseau et doit être testé sous plusieurs en-têtes.
- **Plan mode : oui.** À trancher dans le plan : parseur de configuration unique et place de `trust proxy`.
- **Dépôt / branche** : `dashboard-template-api`, `qb-schemav2-adaptation`.

```text
Contexte (prouvé) :
- src/security/rate-limiter.ts:122 fait new Set(TRUSTED_PROXIES as string[]) alors que la
  valeur arrive en chaîne JSON (${TRUSTED_PROXIES:-[]}) : le Set contient ses caractères.
- resolveClientIp (:72-87) compare l'IP exacte (pas de CIDR, or Helm passe 10.0.0.0/8,
  helm/.../values.yaml:127) et prend le PREMIER élément de X-Forwarded-For (contrôlé par
  le client).
- Clé = sha256(ip:user-agent) (:237-242) : un UA tournant n'est jamais limité ; derrière
  l'ingress, tous les navigateurs d'une même version partagent un compteur.
- Un parseur correct existe déjà : configuredTrustedProxies (src/export/export-routes.ts:61-72).
- M1 : src/security/admin-auth.ts:24 compare la clé admin par !== ; /api/cache/* et
  /api/catalog/* ne sont pas limités.

À faire :
1) Un seul parseur de liste de proxys (module partagé), qui accepte le tableau ou la chaîne
   JSON et les CIDR ; app.set('trust proxy', <liste>) avant tout middleware ; le limiteur
   et l'export utilisent req.ip (Express/proxy-addr prend l'IP la plus à droite non fiable).
2) Clé du limiteur = IP seule. Retirer l'UA.
3) Admin : crypto.timingSafeEqual sur les condensés SHA-256 ; limiteur dédié et strict sur
   /api/cache/* et /api/catalog/* (ex. 10 req/min/IP).
4) Documenter dans docs-site/toolbox/docs/configuration/security.md le réglage attendu
   derrière l'ingress, et que les compteurs sont par pod (un store Redis partagé est une
   évolution ultérieure, non demandée ici).

Critères d'acceptation :
- TRUSTED_PROXIES='["10.0.0.0/8"]', socket 10.42.0.7 et XFF "1.1.1.1" puis "2.2.2.2" :
  deux compteurs distincts.
- XFF usurpé sans proxy de confiance : ignoré.
- Même IP, 25 UA différents : limitée après MAX_REQUESTS / BURST.
- 11 mauvaises clés admin en une minute : 429 à partir de la 11e.

Tests : supertest avec app.set('trust proxy') réel (pas de simulation de resolveClientIp) ;
tests unitaires du parseur (chaîne JSON, tableau, CIDR, entrée invalide).

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
fix(security): identify clients by trusted-proxy IP and harden admin routes
```

---

## A4 — Ciblage par arguments seulement, CORS

- **Modèle : Sonnet 5.** La décision est prise (supprimer le routage par en-têtes) ; le travail est une suppression plus de la configuration.
- **Effort : high.** Écart assumé à la grille : c'est de la sécurité (CORS) et un comportement documenté est retiré ; il faut tout relire.
- **Plan mode : non.** Pas de choix ouvert.
- **Dépôt / branche** : `dashboard-template-api`, `qb-schemav2-adaptation`.

```text
Contexte :
- I2 : le routage par en-têtes x-catalog-id / x-schema-id (src/server.ts:440-462) est
  incohérent. getFactTable routé par en-tête calcule son tri par défaut sur le catalogue
  par défaut (src/schema/resolvers/fact.ts:54-55) → null. getCatalogSchema,
  getDatasetInfo et getFields ignorent l'en-tête. Un en-tête invalide retombe en silence
  sur le catalogue par défaut.
- AF3 (prouvé) : le frontend envoie X-Catalog-Id / X-Schema-Id dès qu'un catalogue est
  fourni ; le preflight répond Access-Control-Allow-Headers: Content-Type, Authorization
  → le navigateur bloque. Le front est servi en statique depuis GitHub Pages (toujours
  cross-origin).
- M3 : config/api.yaml:5-15 — ORIGINS de production = ${API_DOMAIN:-'…'} (le domaine de
  l'API, pas celui du front, avec des apostrophes littérales) ; CREDENTIALS: true inutile
  (pas de cookie) ; X-Powered-By: Express présent.
Décision : le catalogue et le schéma se passent UNIQUEMENT en arguments ; le frontend
cessera d'envoyer les en-têtes (prompt F2).

À faire :
1) Supprimer la lecture des en-têtes (server.ts:440-462), getLoadersForCatalog résolu par
   les seuls arguments ; contextScope (src/schema/resolvers/scope.ts:79-90) devient le
   point unique de résolution (catalogue, schéma) pour TOUS les resolvers.
2) CORS : variable CORS_ORIGINS (liste JSON) pour la production, défaut vide (aucune origine
   cross-origin) ; supprimer les apostrophes littérales ; CREDENTIALS: false ; ajouter
   Access-Control-Max-Age ; app.disable('x-powered-by').
3) Supprimer toute mention du routage par en-têtes : README, docs-site (api-guide,
   toolbox/configuration), skill C:\Users\bolli\.claude\skills\dashboard-api-client\SKILL.md.
4) Helm : exposer CORS_ORIGINS dans values.yaml avec un exemple commenté (origine GitHub
   Pages du front).

Critères d'acceptation :
- Une requête portant x-catalog-id: macroeconomics SANS argument cible le catalogue par
  défaut (l'en-tête est ignoré, et documenté comme tel).
- En production, avec CORS_ORIGINS='["https://qbolliet.github.io"]' : preflight depuis
  cette origine → 204 avec Allow-Origin ; depuis une autre → pas d'Allow-Origin.
- Plus d'en-tête X-Powered-By ; Access-Control-Allow-Credentials absent.

Tests : supertest (preflight autorisé et refusé, en-tête ignoré) ; les tests du routage
par en-tête existants sont supprimés.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose (retrait d'un comportement documenté) :
fix!: target catalogs by arguments only and configure CORS origins explicitly
```

---

## A5 — Agrégats corrects sur les NULL, contrat numérique

- **Modèle : Opus 5.5.** Rupture du SDL (nullabilité, types) à décider avant le tag 0.3.0.
- **Effort : high.** Les choix Float/JSON et agrégats de dates engagent le contrat public.
- **Plan mode : oui.** Le SDL final doit être validé avant d'écrire.
- **Dépôt / branche** : `dashboard-template-api`, `qb-schemav2-adaptation`.

```text
Contexte (prouvé sur le schéma de test geography) :
- src/loaders/aggregated-facts.ts:228-235 fait String(row.key) / Number(row.aggregatedValue).
  AVG d'un groupe entièrement NULL → 0 ; clé NULL → chaîne "null" ; MAX(date) → 3 erreurs
  « Float cannot represent non numeric value: NaN ».
- getTotalGroups (:298) compte en COUNT(DISTINCT col), qui exclut le groupe NULL que
  GROUP BY inclut : hasNextPage et totalPages sont faux.
- Sur un résultat vide, valueExtent vaut [0, 0] (:343) au lieu de null.
- M5 : le tri par aggregatedValue n'a pas de départage (:205-210).
- M6 : total, distinctCount, nullCount sont des Int (32 bits) (typedefs/metadata.ts:62,
  fact.ts:49,65, cross-database.ts:35).
- M11 : AggregatedFact est défini deux fois avec des nullabilités contraires
  (typedefs/fact.ts:32-42 et common.ts:32-33) ; AggregationType est défini 3 fois,
  PaginatedFactResult 2 fois.

À faire :
1) Valeurs gardées telles que les rend le convertisseur JSON unique (src/db/json-conversion.ts) :
   nombre, chaîne ISO ou null. SDL : key: String (nullable), aggregatedValue: JSON (pour
   admettre MIN/MAX de dates ; documenter la forme) — ou Float nullable si le plan
   démontre qu'aucune agrégation non numérique n'est admise ; trancher dans le plan.
2) Agrégation contrôlée selon la famille de type (sqlTypeFamily) : SUM/AVG/MEDIAN →
   numérique ; MIN/MAX → numérique ou date ; MODE/COUNT → toutes. Sinon BAD_USER_INPUT
   listant les agrégations permises. defaultAggregation absente sur une mesure non
   numérique → COUNT n'est PAS implicite : BAD_USER_INPUT.
3) total des groupes : SELECT COUNT(*) FROM (SELECT 1 FROM … WHERE … GROUP BY …).
4) valueExtent: JSON nullable ([min, max] ou null si vide).
5) Tri : départage systématique par la clé de groupe.
6) total, distinctCount, nullCount, count → Float (ou JSON si le plan le justifie), partout.
7) Un seul AggregatedFact, un seul AggregationType (depuis src/generated/graphql.ts), un
   seul PaginatedFactResult.

Critères d'acceptation : les trois scénarios geography donnent null / null / dates ISO ;
totalGroups inclut le groupe NULL ; SUM sur VARCHAR → BAD_USER_INPUT ; deux pages
successives de groupes ex æquo sont disjointes ; schema.graphql ne contient qu'un
AggregatedFact.

Tests : chaque scénario (unitaires et intégration), agrégat sur résultat vide.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test &&
npm run schema:generate && npm run codegen && npm run schema:check && npm run codegen:check.
Conventions habituelles. Ne commite pas ; propose :
fix!: make aggregates NULL-safe and widen counters before the 0.3.0 contract
```

---

## A6 — Invalidation du cache Redis

- **Modèle : Sonnet 5.** Le correctif est connu et déjà validé sur un Redis réel.
- **Effort : medium.** Travail mécanique ; le test sur Redis en CI est la partie la plus délicate.
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-api`, `qb-schemav2-adaptation` (ou `fix/cache-invalidation` depuis `main` si la branche est déjà fusionnée).

```text
Contexte (prouvé sur Redis réel) :
- src/cache/cache-invalidation.ts:107-116 (scanKeys) passe le motif tel quel à SCAN ;
  ioredis n'applique pas keyPrefix à MATCH et ne le retire pas des clés renvoyées ; DEL
  (:148, :201) re-préfixerait. /api/cache/invalidate-all répond success:true et ne
  supprime rien ; /api/cache/stats renvoie 0.
- config/cache.yaml:22 : KEY_PREFIX: ${REDIS_KEY_PREFIX:-'graphql-api:'} → préfixe avec
  apostrophes littérales.
- src/loaders/base-loader.ts:253 : `schema || '_'` → une requête sans schéma explicite est
  rangée sous `_`, hors du motif par schéma. catalog-metadata, dataset-info et
  cross-database sont créés avec catalogId: null (catalog.ts:40, dataset-info.ts:85,
  cross-database.ts:149) → leurs clés sont toutes sous `default:_` quel que soit le catalogue.
- M4 : ${REDIS_PASSWORD} sans défaut est envoyé littéralement en AUTH ; DB n'est pas
  transmis à ioredis ; CLUSTER est rangé sous OPTIONS alors que redis.ts:88 lit REDIS.CLUSTER.
- M12 : CrossDatabaseLoader ne surcharge pas assertKeyAllowed.
- M13 : clés non canoniques ({"catalog":"default"} vs {"catalog":"default","schema":null}) ;
  listes IN complètes dans les clés.

À faire :
1) scanKeys : motif = keyPrefix + pattern (échapper *?[] du préfixe) ; préfixe retiré des
   clés avant DEL.
2) KEY_PREFIX: ${REDIS_KEY_PREFIX:-graphql-api:} ; PASSWORD: ${REDIS_PASSWORD:-} ; db
   transmis ; CLUSTER remonté au niveau lu par redis.ts.
3) Segments de clé toujours RÉSOLUS : catalogue effectif (this.catalogId ?? catalogue de la
   clé ?? défaut) et schéma effectif ; hook cacheNamespace(key) pour les loaders dont la clé
   porte catalogue et schéma.
4) Clé canonique : schéma résolu, champs undefined retirés, suffixe haché (sha1 du JSON trié).
5) CrossDatabaseLoader.assertKeyAllowed (comme catalog.ts:50-53).
6) Corriger les docstrings fausses : cache-invalidation.ts:68-70, dataset-info.ts:67-69,
   field-stats.ts:53-57, select-options.ts:469-470 ; supprimer le contournement de
   tests/unit/test_schema/test_resolvers/field-stats.test.ts:80-100.

Critères d'acceptation : sur Redis réel, invalidateCatalog('macroeconomics') supprime les
clés facts, catalog-metadata, dataset-info et field-stats de ce catalogue et elles seules ;
invalidate-all vide tout le préfixe ; stats cohérentes ; même résultat avec un préfixe
contenant « : ».

Tests : test d'intégration sur le service redis:7 déjà déclaré dans
.github/workflows/test.yml, qui ÉCHOUE si redis.ping() échoue ; vérification avec un client
sans préfixe (redis.duplicate({ keyPrefix: '' })).

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
fix(cache): make invalidation honour the Redis key prefix and resolved key segments
```

---

## A7 — Fraîcheur des données en multi-réplicas

- **Modèle : Opus 5.5.** Conception : cohérence entre réplicas, Redis partagé et snapshots DuckLake.
- **Effort : high.** Plusieurs pods, un cache partagé et des rechargements concurrents : les courses sont subtiles.
- **Plan mode : oui.** À choisir dans le plan : le marqueur de version et la stratégie de rechargement.
- **Dépôt / branche** : `dashboard-template-api`, branche `feat/snapshot-aware-refresh` depuis `main` (après A6 et le déploiement de D1).

```text
Contexte :
- La mise à jour nocturne écrit le catalogue DuckLake et les Parquet sur S3, puis doit
  appeler POST /api/catalog/reload puis POST /api/cache/invalidate-all (x-admin-key).
- /api/catalog/reload reconstruit l'instance DuckDB du SEUL pod qui reçoit la requête
  (src/db/pool.ts:361-395) ; Helm déploie 2 à 6 réplicas (values.yaml:16, 57-60). Les
  autres pods gardent l'instance attachée au démarrage.
- Redis est partagé : un pod non rechargé réécrit des résultats périmés, servis ensuite par
  tous. Même avec l'invalidation corrigée (A6), la fenêtre se rouvre à chaque TTL.
- dataset_metadata.updated_at est estampillé à chaque écriture (après D1 : en UTC).

Objectif : plus aucune orchestration nécessaire côté updater, fraîcheur garantie sur tous
les pods.

À faire (à affiner dans le plan) :
1) Marqueur de version par (catalogue, schéma) : dataset_metadata.updated_at, ou l'id de
   snapshot DuckLake si lisible à coût négligeable (vérifier ducklake_snapshots / fonction
   de snapshot courant sur la version installée) — trancher et justifier.
2) Sondeur par pod (intervalle configurable, ex. 60 s, désactivable) : lit le marqueur sur
   une connexion FRAÎCHE capable de voir le nouvel état (vérifier par un essai si un
   ATTACH existant voit les nouveaux snapshots pour un catalogue fichier et pour un
   catalogue Postgres) ; s'il change, reloadOne(catalogue) puis mise à jour du marqueur.
3) Le marqueur entre dans l'espace de noms des clés Redis (<type>:<catalogue>:<schéma>@<version>:…) :
   une donnée périmée devient inaccessible sans SCAN ; les anciennes clés expirent par TTL.
4) /api/catalog/reload déclenche une sonde immédiate (compatibilité) ; documenter que
   l'updater peut se contenter d'attendre l'intervalle.
5) Métriques : dernier marqueur vu et date de la dernière sonde par schéma, dans /metrics
   (protégé par M2, prompt A16).
6) Doc : docs-site/toolbox/docs (cache-invalidation, architecture) et le runbook de mise à jour.

Critères d'acceptation : test d'intégration à deux instances d'API (deux pools) sur un
catalogue de test. Une écriture (updated_at modifié) est vue par les DEUX instances en
moins d'un intervalle de sonde, sans appel admin. Aucune clé de l'ancienne version n'est
servie après le changement.

Tests : sondeur (changement, pas de changement, erreur de lecture → aucune bascule, log
warn), espace de noms des clés, deux instances.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
feat: detect catalog updates on every replica and version cache keys by snapshot
```

---

## A8 — Pool de connexions et double exécution

- **Modèle : Opus 5.5.** Concurrence et gestion de ressources.
- **Effort : high.**
- **Plan mode : oui.** À décider dans le plan : la forme de la file d'attente et le point d'interruption.
- **Dépôt / branche** : `dashboard-template-api`, `perf/pool-fifo` depuis `main`.

```text
Contexte :
- I6 (prouvé : maxConnections=2, 10 acquire() concurrents à froid → 10 connexions) :
  src/db/pool.ts:578-586, :594-689, :692-700 — le test de capacité a lieu avant les await,
  l'insertion après ; le minuteur d'acquisition n'est jamais nettoyé ; l'attente sonde toutes
  les 500 ms sans FIFO. Les loaders prennent une connexion AVANT de consulter Redis
  (src/loaders/base-loader.ts:120-153, :282-292). withTimeout (src/utils/timeout.ts:10-15)
  n'interrompt pas DuckDB, qui garde sa connexion.
- I7 (prouvé : loader en échec exécuté 2 fois) : le catch global de withCache
  (src/utils/cache.ts:40-43) relance le loader.

À faire :
1) Réservation synchrone du créneau (compteur), file FIFO de promesses, clearTimeout de
   l'attente, aucun sondage.
2) Lecture du cache AVANT l'acquisition d'une connexion.
3) Timeout : connection.interrupt() (comme src/export/export-runner.ts:76-90), connexion
   rendue ensuite.
4) withCache distingue une erreur Redis (repli sur le loader) d'une erreur du loader
   (relancée, jamais rejouée).
5) Métriques : attente d'acquisition, taille de la file, dans /metrics.

Critères d'acceptation : 10 acquire() concurrents avec maxConnections=2 → jamais plus de 2
connexions ; ordre FIFO ; un hit de cache ne prend aucune connexion ; une requête en
timeout libère sa connexion en moins de 1 s ; un loader en échec est appelé une seule fois.

Tests : unitaires du pool (courses avec Promise.all), intégration du timeout sur une
requête lente (range(1e9)), withCache.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
perf: bound the DuckDB pool with a FIFO queue and consult the cache before acquiring
```

---

## A9 — Motifs interdits, complexité, messages d'erreur publics

- **Modèle : Opus 5.5.** Sécurité et barème de coûts à concevoir.
- **Effort : high.**
- **Plan mode : oui.** Le barème de complexité doit être validé.
- **Dépôt / branche** : `dashboard-template-api`, `qb-schemav2-adaptation` avant le tag si possible, sinon `fix/security-scoring` depuis `main`. **Après A1.**

```text
Contexte :
- I3 (prouvé) : config/security-patterns.yaml:3-38 est appliqué au texte brut de la requête
  (src/security/pattern-validator.ts:140-178). En production, `__typename` (ajouté par
  Apollo Client et urql) est rejeté, searchTerm:"ecosystem" aussi (motif « system »),
  fields:["mutation_rate"] aussi (« mutation ») ; la même valeur passe par les variables :
  aucune valeur de sécurité.
- I4 (prouvé) : src/security/complexity-analyzer.ts ignore la taille des listes
  (LIST_FACTOR jamais lu), plafonne limit à 100, ne score pas toutes les requêtes racine.
  getCatalogSchema { stats } coûte 16 quel que soit le nombre de colonnes ; 50 compareFacts
  aliasés coûtent 50 ; 40 getFieldStats coûtent 200 ; getSelectOptions et
  crossDatabaseSelectOptions ont un limit non borné (resolvers/select-options.ts:37,
  resolvers/cross-database.ts:292).
- I11 (prouvé) : src/server.ts:341-349, :378-386 masquent en production TOUS les messages,
  y compris BAD_USER_INPUT et QUERY_COMPLEXITY_EXCEEDED ; erreurs journalisées deux fois.

À faire :
1) Supprimer les motifs SQL et `mutation` (le type d'opération est contrôlé en
   src/security/manager.ts:231) ; supprimer __schema/__type (après A1, introspection:false
   est effectif) ; si le module devient vide, le supprimer avec sa config et ses tests.
2) Complexité : score pour CHAQUE champ racine (table config, défaut non nul) ; limit sans
   plafond de 100 dans le calcul ; stats pondéré par le nombre de colonnes du schéma (lu
   dans le cache catalogMetadata) ou plafonné ; plafond du nombre de champs racine par
   opération (config) ; MAX_LIMIT appliqué aux limit d'options. Documenter le barème dans
   docs-site/toolbox/docs/architecture/security.md.
3) Erreurs : masquer seulement INTERNAL_SERVER_ERROR et les codes inconnus (errorId
   conservé) ; BAD_USER_INPUT, SCHEMA_VERSION_UNSUPPORTED, QUERY_COMPLEXITY_EXCEEDED,
   GRAPHQL_VALIDATION_FAILED gardent leur message ; une seule journalisation.

Critères d'acceptation (NODE_ENV=production) : { getCatalogs { id __typename } } → 200 ;
searchTerm "ecosystem" → 200 ; filtre sur colonne inconnue → message lisible ; 50 alias
compareFacts → QUERY_COMPLEXITY_EXCEEDED ; getCatalogSchema { stats } sur 40 colonnes
refusé au-delà du budget ; getSelectOptions(limit: 1000000) → BAD_USER_INPUT.

Tests : chaque critère en supertest (production) ; tests du barème.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
fix(security): drop text pattern checks, score every root field and expose client errors
```

---

## A10 — Base générale : schémas découverts, types, ordre, tri de repli

- **Modèle : Sonnet 5.** Correctifs localisés et spécifiés.
- **Effort : high.** Écart assumé : la politique d'exposition des schémas touche la surface publique.
- **Plan mode : non.** Les décisions sont prises ci-dessous.
- **Dépôt / branche** : `dashboard-template-api`, `feat/general-base` depuis `main` (ou sur la branche avant le tag). **Après A2.**

```text
Contexte (prouvé sauf mention) :
- BA1 : config/database.yaml:14,29,35 définit toujours SCHEMAS (${…_SCHEMAS:-["main"]}),
  donc chaque catalogue est « explicite » (src/db/database-manager.ts:135-137) et la
  découverte ne peut que restreindre. Essai : 6 schémas découverts, 1 exposé. Un schéma
  ajouté par l'updater reste invisible jusqu'au prochain déploiement.
- BA2 (API) : sqlTypeFamily (src/utils/filter-tree.ts:329-342) rejette `DECIMAL` sans
  précision (DECIMAL_PATTERN :104), alors que la base l'écrit tel quel dans metadata.sql_type ;
  UHUGEINT absent d'INTEGER_TYPES (:85-95) ; TIME, INTERVAL, BLOB sans famille.
- BA5 : sans clé primaire, cluster_by est NULL et le repli sur les clés est vide
  (src/utils/default-sort.ts:60-66) : ni ORDER BY ni pagination déterministe.
- BA6 : loadAllMetadata (src/loaders/catalog.ts:68) lit metadata sans ORDER BY ; la base
  écrit ses lignes par ordre alphabétique, pas dans l'ordre des colonnes.
- BA8 : les noms des catalogues du gabarit sont répétés dans CATALOGS et ALLOWED_CATALOGS.

À faire :
1) BA1 : défaut ${…_SCHEMAS:-} (vide = découverte) pour chaque catalogue ; le config-loader
   doit distinguer « absent ou vide » d'une liste fournie. getCatalogs n'expose que les
   schémas dont la garde de version est « supportée » ; les autres sont journalisés à
   l'attach. Ajouter CatalogSchemaInfo.supported: Boolean! seulement si le plan le juge
   utile au diagnostic.
2) BA2 : DECIMAL et DECIMAL(p,s) (p ≤ 38) → numeric ; UHUGEINT → numeric ; nouvelle famille
   'other' (TIME, INTERVAL, BLOB, LIST…) : non filtrable avec un BAD_USER_INPUT clair, sans
   exception ailleurs (getSharedFields, stats, extents). La table de vérité couvre TOUS les
   types de map_python_to_sql_type (dépôt de la base,
   dt_ducklake_manager/utils/types.py:177-277).
3) BA5 : dernier repli ORDER BY ALL (le writer déduplique sur toutes les colonnes sans clé
   primaire) ; log warn une fois par schéma ; même règle pour l'export.
4) BA6 : lignes de metadata triées par la position de la colonne dans fact_table
   (duckdb_columns() ou information_schema.columns.ordinal_position), dans la même lecture
   mise en cache ; une colonne de metadata absente de la table est en fin de liste, avec
   un warn.
5) BA8 : ALLOWED_CATALOGS par défaut = clés de CATALOGS.

Critères d'acceptation : sans DEFAULT_SCHEMAS, getCatalogs liste main, predictions,
geography, trade, sans les deux schémas non conformes ; filtre BETWEEN sur une colonne
DECIMAL déclarée « DECIMAL » accepté ; pages disjointes sur un schéma de test sans clé
primaire (à ajouter au setup) ; getCatalogSchema dans l'ordre de fact_table.

Tests : chacun des critères ; table de vérité de sqlTypeFamily étendue.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
feat: discover schemas by default, accept every database type and order columns physically
```

---

## A11 — `Metadata.typeFamily` et `filterOperations`

- **Modèle : Opus 5.5.** Ajout au contrat public : les noms d'enum sont définitifs.
- **Effort : high.**
- **Plan mode : oui.** Le SDL (noms, descriptions, granularité de l'enum) doit être validé.
- **Dépôt / branche** : `dashboard-template-api`, sur `qb-schemav2-adaptation` avant le tag 0.3.0 si possible, sinon `feat/type-family` depuis `main`. **Après A10.**

```text
Contexte : le frontend recopie une table type SQL → famille → opérations au modèle
PostgreSQL (dashboard-template-frontend/src/features/filter/utils/filterTypes.js:25-43,
config/filter/operations.json). Résultat : DOUBLE, TINYINT, U*INT, HUGEINT, BOOLEAN,
DECIMAL(p,s) n'y sont pas numériques, le graphique de la page indicateur est masqué et les
mesures reçoivent des opérateurs texte. La règle existe déjà côté serveur : sqlTypeFamily
et ALLOWED_OPERATIONS (src/utils/filter-tree.ts:124-182, :329-342). La recopier dans un
client, c'est la dérive constatée.

À faire :
1) SDL (typedefs/metadata.ts) :
     enum TypeFamily { INTEGER NUMBER DATE TIMESTAMP TEXT BOOLEAN OTHER }
     type Metadata { …, typeFamily: TypeFamily!, filterOperations: [FilterOperation!]! }
   INTEGER / NUMBER distingue les entiers des flottants et décimaux (pas d'un slider,
   format) ; DATE / TIMESTAMP distingue sélecteur de date et de date-heure ; OTHER →
   filterOperations = [IS_NULL, IS_NOT_NULL]. Descriptions SDL en français avec la
   correspondance complète des types. Une colonne catégorielle garde ses opérations
   (le front choisit le widget via isCategorical).
2) Calcul dans src/utils/metadata-mapping.ts (point unique du contrat), à partir de
   sqlTypeFamily et ALLOWED_OPERATIONS : aucune requête supplémentaire, disponible
   partout où Metadata est produit (getCatalogSchema, CatalogSchemaInfo.fields,
   DatasetWithMetadata.fields, groupByFieldInfo, measureFieldInfo, getMetaData).
3) Documentation : docs-site/api (guide des requêtes, dictionnaire des données, qui
   affiche typeFamily) et skill dashboard-api-client (section filtres : « router sur
   typeFamily, proposer filterOperations »).

Critères d'acceptation : typeFamily et filterOperations corrects pour chaque colonne des
schémas de test (DOUBLE → NUMBER, UBIGINT → INTEGER, TIMESTAMP → TIMESTAMP, BOOLEAN →
BOOLEAN) ; filterOperations = exactement ce que treeToSQL accepte (test croisé :
chaque opération listée est acceptée, chaque opération absente est refusée) ;
schema:diff = non cassant.

Tests : table de vérité ; test croisé ; intégration sur getCatalogSchema et DatasetWithMetadata.fields.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test &&
npm run schema:generate && npm run codegen && npm run schema:check && npm run schema:diff.
Conventions habituelles. Ne commite pas ; propose :
feat(schema): expose typeFamily and the allowed filter operations of each column
```

---

## A12 — Export : jeu complet, sans troncature silencieuse, filtres en POST

- **Modèle : Opus 5.5.** Conception de l'API d'export : pagination, signal de troncature, surface REST.
- **Effort : high.**
- **Plan mode : oui.** À trancher : 413 ou en-tête, `offset` ou clé de reprise, coût d'un comptage en Arrow.
- **Dépôt / branche** : `dashboard-template-api`, `feat/export-complete` depuis `main` (ou sur la branche avant le tag). **Après A10** (tri de repli).

```text
Contexte (prouvé) :
- EX1 : avec EXPORT_MAX_ROWS=100, GET /api/export?format=csv&limit=5000 sur 1 729 lignes →
  200, X-Row-Count: 100, 101 lignes, sans aucun signal (src/export/export-params.ts:262-269).
  Il n'y a pas d'offset : au-delà de MAX_ROWS, le jeu ne peut être récupéré qu'en le
  découpant à la main par des filtres.
- EX2 : filtres en query string ; un IN de 800 valeurs (URL de 22 480 caractères) → 431
  (limite d'en-têtes de Node), alors que MAX_IN_VALUES = 1 000. Derrière l'ingress, la
  limite est plus basse.
Code : src/export/{export-routes,export-params,build-export-query,export-runner}.ts ; tri
par défaut resolveEffectiveSort (cluster_by, clés primaires en départage, ORDER BY ALL en
dernier repli après A10).

À faire (à valider au plan) :
1) Troncature explicite. Requête en LIMIT n+1. Si la limite effective est dépassée alors
   que le client n'a pas donné `limit` : 413 {error, detail} avant le premier octet
   (csv/parquet : rowsChanged connu après COPY ; arrow : sonde COUNT(*) bornée, ou
   lecture du premier chunk au-delà — trancher). Si `limit` est explicite : en-tête
   X-Truncated: true. Toujours X-Total-Count quand le coût le permet ; documenter quand il
   est absent.
2) Reprise au-delà de MAX_ROWS : paramètre `after` (JSON du dernier tuple de l'ordre
   effectif, pagination par clé sur l'ordre déterministe) ou `offset` non plafonné ;
   privilégier la clé (coût constant) si le plan la montre fiable avec ORDER BY ALL ;
   en-tête X-Next-After sur une réponse tronquée.
3) POST /api/export, corps JSON {catalog, schema, fields, filters, sort, format, limit,
   after}, même validation (parseExportQuery factorisé), même rate limiter ; GET conservé
   pour les liens partageables. Limite du corps : celle d'express.json de /graphql (A1).
4) Documentation (docs-site/api/docs/api-guide/export.md) : récupération d'un jeu complet
   (boucle Python sur X-Next-After), POST pour les gros filtres, codes 413.

Critères d'acceptation : 413 sans `limit` au-delà de MAX_ROWS ; X-Truncated avec `limit`
explicite ; la concaténation des pages obtenues par `after` égale l'export non plafonné
(schéma de test, MAX_ROWS=100) ; POST avec un IN de 1 000 valeurs → 200 ; GET inchangé
sinon.

Tests : intégration pour chaque critère, pour chaque format ; reprise sur un schéma sans
clé primaire.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
feat(export): signal truncation, resume beyond MAX_ROWS and accept filters in a POST body
```

---

## A13 — Export : fichiers autodescriptifs, types, ressources, options

- **Modèle : Sonnet 5.** Ajouts bien délimités sur un module existant.
- **Effort : high.** Écart assumé : gestion de ressources (connexion, fichier temporaire, timeouts) sous abandon client.
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-api`, `feat/export-metadata` depuis `main`. **Après A12.**

```text
Contexte :
- EX4 : les fichiers exportés ne portent que les noms techniques ; ni libellé, ni unité, ni
  labelFor, ni DatasetInfo. Les métadonnées sont pourtant déjà chargées
  (build-export-query.ts:106).
- EX5 : src/export/arrow-writer.ts:137-139 écrit HUGEINT/UHUGEINT en Utf8.
- EX3 = M8 : export-runner.ts:139-141 garde la connexion pendant le transfert ; pas de
  Content-Length ; le timeout couvre le transfert (un client lent reçoit un fichier tronqué) ;
  TMP_DIR non borné.
- EX6 : pas de recette multi-datasets.
- EX7 : CSV sans BOM (Excel sous Windows décode mal les accents) ; Parquet en snappy par défaut.

À faire :
1) Parquet : COPY … (FORMAT PARQUET, KV_METADATA {…}) avec une clé JSON
   `dashboard.metadata` (lignes de metadata en camelCase, dont typeFamily si A11 est fait)
   et `dashboard.dataset` (DatasetInfo) ; vérifier la syntaxe exacte sur la version
   installée de DuckDB.
2) Arrow : métadonnées par champ (label, unit, displayFormat, description, isPrimaryKey,
   labelFor) et métadonnées du schéma (dataset) dans buildArrowLayout.
3) HUGEINT/UHUGEINT → Decimal128(38,0) (écriture des mots, comme DECIMAL).
4) M8 : connexion rendue dès la fin du COPY ; Content-Length (taille du fichier) ;
   TIMEOUT_MS pour la requête, TRANSFER_TIMEOUT_MS (config) pour l'envoi ; refus 507 si
   l'espace libre de TMP_DIR est sous un seuil configuré.
5) Options : bom=1 (CSV) ; compression=snappy|zstd|gzip (Parquet, liste blanche).
6) Doc export.md : lecture des métadonnées embarquées (pyarrow, apache-arrow), recette
   multi-datasets (boucle getCatalogs → export par schéma), requête GraphQL « dictionnaire ».

Critères d'acceptation : pyarrow relit les métadonnées embarquées (parquet et arrow) ;
colonne HUGEINT relue en decimal128(38,0) ; la connexion est rendue avant la fin d'un
transfert lent (test avec un client qui lit lentement) ; Content-Length exact ; BOM
présent avec bom=1 ; compression=zstd lisible.

Tests : intégration par format ; tests unitaires de l'arrow-writer (HUGEINT, métadonnées).

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test.
Conventions habituelles. Ne commite pas ; propose :
feat(export): embed column metadata, type 128-bit integers and release connections early
```

---

## A14 — `getAggregates` : clé-mesure multi-opérations

- **Modèle : Opus 5.5.** Conception d'une nouvelle requête publique et d'un constructeur SQL unique.
- **Effort : high.**
- **Plan mode : oui.** Le SDL, le grain temporel et `format: LONG` doivent être validés.
- **Dépôt / branche** : `dashboard-template-api`, `feat/get-aggregates` depuis `main` (0.4.0). **Après A2 et A5.**

```text
Contexte : getAggregatedFacts n'accepte qu'un groupBy, une mesure et une agrégation ;
aucune requête ne donne d'agrégat global ; le frontend moyenne lui-même dans <Chart>
(dashboard-template-frontend/src/features/chart/components/Chart/Chart.jsx:409, :517 :
aggregate 'mean'), sans tenir compte de defaultAggregation, sur la seule page chargée.
Design de référence : audit-api.md §4.2 et §4.3 (AggregateInput, AggregateSortInput,
AggregateColumn, AggregateResult, getAggregates) ; le relire.

À faire :
1) Implémenter getAggregates selon audit-api.md §4.2, avec un constructeur SQL unique
   buildAggregateQuery(params, metadata) ; getAggregatedFacts* réimplémentées dessus (un
   agrégat, un groupBy), marquées @deprecated (motif « use getAggregates »).
2) Deux ajouts issus de audit-integration.md (AF10) :
   - groupBy accepte un grain temporel : input GroupByInput { field: String!, grain:
     TimeGrain } avec enum TimeGrain { DAY WEEK MONTH QUARTER YEAR }, compilé en
     date_trunc ; interdit hors des familles DATE/TIMESTAMP ; trancher au plan entre
     groupBy: [GroupByInput!] et un argument séparé.
   - format: LONG (en plus d'OBJECTS/ARRAYS) : une ligne par (groupe, agrégat) :
     {<groupBy…>, measure: alias, value}. C'est la forme « tidy » pour tracer plusieurs
     agrégats comme des séries.
3) Règles : agrégation effective par agrégat (argument, puis defaultAggregation, puis SUM
   seulement si numérique, sinon BAD_USER_INPUT) ; familles contrôlées (SUM/AVG/MEDIAN
   numériques, MIN/MAX numériques ou dates, MODE/COUNT toutes) ; alias
   ^[a-z_][a-z0-9_]*$ uniques ; colonnes de libellés <col>__label par resolveLabelField ;
   tri par alias ou colonne de groupe, départage par les colonnes de groupe ; total =
   COUNT(*) sur la sous-requête groupée (groupe NULL compris) ; bornes
   AGGREGATES.MAX_AGGREGATES et MAX_GROUP_BY (config) ; score de complexité (base 10,
   +2 par agrégat, +5 par MEDIAN/MODE, +3 par colonne de groupe, longueur des listes lue
   dans les variables) ; clé de cache = paramètres résolus.
4) Doc (api-guide/queries.md, examples.md) et skill dashboard-api-client : recette
   « graphique en barres groupées » et « plusieurs mesures en séries (LONG) ».

Critères d'acceptation : l'exemple de audit-api.md §4.2 (SUM, AVG, MAX sur deux mesures)
en une requête SQL ; agrégat global sans groupBy (une ligne) ; grain MONTH sur une date ;
LONG = OBJECTS fondu ; getAggregatedFacts* renvoie les mêmes valeurs qu'avant A14 (tests de
non-régression) ; schema:diff non cassant.

Tests : unitaires du constructeur (SQL et paramètres), intégration sur main et geography,
familles refusées, bornes, cache (deux ordres d'agrégats → deux entrées).

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test &&
npm run schema:generate && npm run codegen && npm run schema:check && npm run schema:diff.
Conventions habituelles. Ne commite pas ; propose :
feat: add getAggregates with multiple measures, time grains and a long format
```

---

## A15 — Comparaisons multi-agrégats, `compareFacts` borné, export agrégé

- **Modèle : Opus 5.5.** Sémantique de jointure (explosion cartésienne) et extension de contrat.
- **Effort : high.**
- **Plan mode : oui.**
- **Dépôt / branche** : `dashboard-template-api`, `feat/compare-aggregates` depuis `main`. **Après A14.**

```text
Contexte :
- I5 : src/loaders/cross-database.ts:206-209, :247, :259, :331-335 — compareFacts joint
  directement sur des joinFields non uniques (N_A × N_B lignes par clé, même COUNT) ; la
  mesure `value` est codée en dur dans compareFacts ET compareAggregatedFacts, contrairement
  à ce qu'annonce le CHANGELOG 0.2.0 ; ORDER BY key non unique : pagination non
  déterministe ; offset non borné (resolvers/cross-database.ts:160-181).
- EX8 : l'export n'offre pas d'agrégats.

À faire :
1) compareFacts : argument `measure` (contrôlé contre metadata des deux côtés, défaut :
   BAD_USER_INPUT s'il est absent et qu'aucune colonne `value` n'existe) ; chaque côté est
   agrégé par joinFields AVANT la jointure (agrégation par défaut de la mesure) ; départage
   par toutes les clés ; offset ≤ MAX_OFFSET.
2) compareAggregatedFacts : arguments aggregates: [AggregateInput!] et groupBy: [String!]
   (réutilise buildAggregateQuery de A14) ; résultat data: [JSON!]! avec les colonnes
   <alias>_a, <alias>_b, <alias>_delta, <alias>_delta_pct, et aggregates: [AggregateColumn!]! ;
   l'ancienne forme (ComparedFact) reste pour compatibilité, @deprecated.
3) Export : paramètres groupBy et aggregates (ex. aggregates=value:sum,value:avg:moyenne)
   réutilisant buildAggregateQuery ; HUGEINT en Decimal128 (A13).

Critères d'acceptation : deux schémas de test avec des joinFields non uniques → une ligne
par clé ; valeurs identiques à un calcul DuckDB de référence ; mesure autre que `value`
comparable ; export agrégé relu par pyarrow.

Tests : intégration sur default.trade / macroeconomics.trade (codes nc8 partagés).

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test &&
npm run schema:generate && npm run codegen && npm run schema:check && npm run schema:diff.
Conventions habituelles. Ne commite pas ; propose :
feat: aggregate before comparing datasets, support any measure and aggregated exports
```

---

## A16 — Exploitation : arrêt gracieux, endpoints internes, dépendances

- **Modèle : Sonnet 5.** Motifs standard (plugin de drain d'Apollo, protection d'endpoints).
- **Effort : medium.**
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-api`, `fix/ops-hardening` depuis `main`.

```text
Contexte :
- I8 : src/server.ts:512-531, :543-548, src/index.ts:23-27 — l'arrêt ne ferme pas le
  serveur HTTP (pas d'ApolloServerPluginDrainHttpServer), ferme en parallèle Redis, le
  pool et Apollo pendant que des requêtes et des exports tournent, sans délai maximal :
  5xx et exports tronqués lors d'un rolling update.
- M2 : /metrics et /ready sont publics (src/server.ts:228-281).
- npm audit --omit=dev : body-parser et qs (dépendances d'express) ; npm audit fix suffit.

À faire :
1) httpServer = app.listen(…) ; ApolloServerPluginDrainHttpServer ; séquence SIGTERM :
   arrêt d'acceptation → drainage (exports compris) avec un délai
   SHUTDOWN_TIMEOUT_MS < terminationGracePeriodSeconds (Helm) → fermeture du pool → Redis.
2) /metrics : clé admin ou liste d'IP (config) ; /ready : état minimal (pas l'état du pool).
3) npm audit fix (sans --force) ; noter les versions dans le résumé.

Critères d'acceptation : un export lancé avant SIGTERM se termine ; une requête après
SIGTERM est refusée proprement ; le processus sort avant le délai ; /metrics → 401 sans clé.

Tests : intégration de l'arrêt (processus enfant), supertest pour /metrics.

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test && npm audit --omit=dev.
Conventions habituelles. Ne commite pas ; propose :
fix: drain HTTP and exports on shutdown and protect internal endpoints
```

---

## A17 — Tests qui passent pour de mauvaises raisons

- **Modèle : Sonnet 5.** Suppression et réécriture ciblées.
- **Effort : medium.**
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-api`, `test/cleanup` depuis `main`. **Après A1, A2, A5, A6.**

```text
Contexte (I9) :
- tests/integration/comprehensive.test.ts (1 371 lignes, 31 tests) n'importe rien de
  src/ : il teste des bouchons locaux de l'ancien modèle (DATABASE_ROUTING, inputSanitizer).
- tests/unit/test_db/database-di.test.ts (23 tests), avec tests/setup/di-container.ts et
  database-manager-injectable.ts, teste une réimplémentation propre aux tests.
- tests/unit/test_cache/cache-invalidation.test.ts simule redis.scan (d'où I1 invisible).
- tests/unit/test_db/schema-contract.test.ts:43-56 impose des NOT NULL que le writer ne
  déclare pas (dt_ducklake_manager/utils/types.py:30-37).
- tests/setup/setup-env.ts : variables jamais lues (DB_PATH, TEST_MODE, CACHE_TTL,
  MAX_QUERY_COMPLEXITY, RATE_LIMIT_MAX, METADATA_TIMEOUT, SELECT_OPTIONS_TIMEOUT,
  DISABLE_EXTERNAL_SERVICES) ; commentaire faux l. 11.

À faire : supprimer les tests et fichiers ci-dessus (≈ 2 500 lignes) ; vérifier que les
tests HTTP ajoutés par A1, A2, A5 et A6 couvrent B1, B2, B4, B5 et I1, sinon les ajouter ;
aligner le test de contrat sur le DDL réel du writer (ou sur D1 s'il est livré) ; nettoyer
setup-env.ts ; docstrings des aides de test en JSDoc (et non en Args:/Returns:).

Critères d'acceptation : npm test vert ; couverture de src/ stable ou en hausse
(npm run test:coverage, chiffres avant/après dans le résumé).

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test && npm run test:coverage.
Conventions habituelles. Ne commite pas ; propose :
test: remove self-referential suites and align the contract test with the writer
```

---

## A18 — Documentation, code mort, commentaires faux

- **Modèle : Sonnet 5.** Travail mécanique sur une liste fermée.
- **Effort : medium.**
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-api`, `docs/cleanup` depuis `main`. **En dernier** (les autres prompts modifient les mêmes pages).

```text
Contexte (audit-api.md I10, M9, M10, M14, §3.4, §3.6) :
- Doc publique périmée : README.md:26, :100 ; docs-site/api/docs/intro.md:39 ;
  api-guide/overview.md:42 ; toolbox/docs/architecture/security.md:52-59, overview.md:23,
  :103 ; configuration/security.md:70-79 ; configuration/cache.md:79 ;
  architecture/caching.md:49 (sanitization XSS/SQL supprimée, input-sanitizer.ts,
  /api/cache/invalidate/:database). Les renvois à specification-bdd.md (3 fichiers de src,
  5 de tests, 2 de doc) doivent pointer vers ../dashboard-template-database/docs/schema.md.
- Code mort : src/security/validation.ts ; createSimpleDepthLimitRule ; getSecurityManager,
  isOperationAllowed ; createLoadersForRequest, prime/PrimeData, clearAll ;
  getSchemaVersionStatus ; src/utils/index.ts ; listFactor, skipFailedRequests ; options
  YAML jamais lues (liste en audit-api.md §3.4) ; config/test/*.yaml ; argument fields de
  getAggregatedFacts* (ignoré mais présent dans la clé de cache).
- M10 : graphql-test-queries.graphql (17 opérations sur 92 invalides) ; script start qui
  lance tsx src/index.js au lieu de src/index.ts.
- M14 : middleware « cache HTTP public » (server.ts:192-201), écrasé par Apollo.
- §3.6 : commentaires faux (server.ts:192, :394-406 si encore présent,
  cache-invalidation.ts:68-70, dataset-info.ts:67-69, field-stats.ts:53-57,
  select-options.ts:469-470, resolvers/field-stats.ts:82-84, rate-limiter.ts:229-232,
  database-manager.ts:55-71) ; commentaires inline en anglais (resolvers/catalog.ts:94,
  :159-160) ; JSDoc manquantes (constructeurs DuckDBPool et DatabaseManager, isRemoteUri,
  COMPARISON_SQL, DEFAULT_SETTINGS) ; 7 avertissements TypeDoc ; interfaces
  DuckDBConnection/DuckDBPool redéclarées dans base-loader.ts:32-47 ;
  ServerContext.databaseManager: any.

À faire : corriger ou supprimer chaque élément, en revérifiant d'abord qu'il existe encore
(les prompts précédents en auront traité une partie). Supprimer l'argument fields des
agrégats = rupture de SDL : le marquer @deprecated s'il est déjà publié (après 0.3.0).
Régénérer graphql-test-queries.graphql depuis les exemples de la doc, ou le supprimer.

Critères d'acceptation : grep « sanitiz », « invalidate/:database » et
« specification-bdd » vides dans docs-site/, README et src/ ; TypeDoc sans avertissement ;
npm run docs:build vert (API de test démarrée, voir CLAUDE.md).

Vérification : npm run lint && npm run type:check && npm run test:setup && npm test &&
npm run docs:build:test-api.
Conventions habituelles. Ne commite pas ; propose :
docs: align documentation with the refactored API and remove dead code
```

---

## D1 — Base : types physiques, UTC, contrat `metadata`, documentation

- **Modèle : Sonnet 5.** Changements localisés dans le writer, avec un contrat déjà défini.
- **Effort : high.** Écart assumé : c'est le contrat de données de tous les consommateurs, et `NOT NULL` dans DuckLake reste à vérifier.
- **Plan mode : non.** Les décisions sont prises ; seule la faisabilité de `NOT NULL` est ouverte, et le prompt dit quoi faire dans chaque cas.
- **Dépôt / branche** : `dashboard-template-database`, branche `qb-api-integration` à créer depuis `qb-label-schema` (ne pas toucher aux notebooks déjà modifiés).

```text
Contexte (prouvé par une sonde en mémoire sur DuckLakeTablesBuilder) :
- BA2 : metadata.sql_type est le résultat de map_python_to_sql_type
  (dt_ducklake_manager/utils/types.py:177-277), pas le type physique. Decimal(10,2) →
  sql_type 'DECIMAL' pour une colonne DECIMAL(10,2) ; List → 'VARCHAR' pour une colonne
  VARCHAR[] (chemin CTAS sans clé ni partition, schema/persistence.py:366-376).
  L'API se fie à sql_type pour filtrer, typer et sérialiser.
- BA4 : updated_at est écrit en heure LOCALE naïve (datetime.now(), persistence.py:438,
  operations/_base.py:1670) ; l'API le publie suffixé Z (UTC) : 2 h d'écart l'été à Paris.
- BA9 : METADATA_COLUMNS (types.py:30-37) ne déclare pas NOT NULL sur name, label,
  sql_type, alors que docs/schema.md:34-36 les dit non nulles.
- BA3 : le writer accepte tout nom de colonne ; l'API les quote désormais (prompt A2), mais
  les noms hors snake_case restent pénibles pour les clients SQL et les URL.
- BA10 : aucun moyen de déclarer l'ordre métier des modalités ; le mécanisme label_for le
  permet déjà (code triable + colonne de libellés).

À faire :
1) Après chaque création ou ajout de colonne (build CTAS et DDL explicite, add_columns,
   update avec élargissement de type), écrire dans metadata.sql_type le type PHYSIQUE relu
   dans la table (DESCRIBE / duckdb_columns), ex. DECIMAL(10,2). Pour les types composites
   (List, Array, Struct) : refus explicite (ValueError, message clair) OU conversion
   explicite en VARCHAR JSON dans les deux chemins — choisir le refus sauf si un cas
   d'usage existant l'interdit, et le documenter.
2) updated_at en UTC : datetime.now(timezone.utc).replace(tzinfo=None) (la colonne reste
   TIMESTAMP) ; docs/schema.md : « updated_at est en UTC ».
3) NOT NULL : vérifier par un test si DuckLake accepte NOT NULL dans CREATE TABLE et
   ALTER. Si oui, l'ajouter à name, label, sql_type, is_categorical, is_primary_key ;
   sinon, contrôle à l'écriture (ValueError) et correction de docs/schema.md.
4) Avertissement (logger.warning, pas de refus) pour un nom de colonne hors
   ^[a-z_][a-z0-9_]*$, documenté dans docs/schema.md.
5) docs/schema.md : section « Ordre des modalités » (code triable + label_for) ; section
   « Types » : sql_type est le type physique.

Critères d'acceptation : la sonde (Decimal(10,2), List, noms accentués, sans clé
primaire) produit sql_type 'DECIMAL(10,2)' et un refus clair pour List ; updated_at =
UTC à la seconde près ; tests existants verts.

Tests (pytest, tests/unit/test_schema et test_operations) : type physique après build,
add_columns et élargissement ; refus des composites ; UTC (freezegun ou comparaison à
datetime.now(timezone.utc)) ; NOT NULL ou contrôle équivalent ; avertissement de nommage.

Vérification : uv run ruff check . && uv run ruff format --check . && uv run mypy dt_ducklake_manager && uv run pytest --cov=dt_ducklake_manager tests/
Conventions du dépôt (CLAUDE.md) : commentaires français, docstrings Google en anglais
avec Examples. Ne commite pas ; propose :
fix: record physical SQL types and UTC timestamps in the metadata contract
```

---

## F1 — Front : SDL de l'API épinglé, mock et contrôle des documents

- **Modèle : Sonnet 5.** Outillage de développement sur un existant clair.
- **Effort : medium.**
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-frontend`, branche `qb-api-0.3-adaptation` à créer depuis `qb-templatization`. **Après le tag API 0.3.0** (ou un commit d'API épinglé).

```text
Contexte (prouvé) : scripts/schema.graphql est une copie figée, éditée à la main, de
l'ancien SDL de l'API ; npm run check:gql valide les documents contre CETTE copie, donc
reste vert alors que 3 des 4 documents de src/lib/api/documents sont invalides contre le
SDL réel. Chargé avec le schema.graphql de l'API, scripts/mock-api-server.js échoue :
getCatalogSchema → erreur (fixtures en snake_case, sqlType non nul absent) ; fields
auto-mocké en "Hello World" et non aligné sur columns ; getSelectOptionsTree et
FieldStats.min/max (scalaire JSON) → erreur. Les fixtures (src/lib/api/fixtures/) portent
des types PostgreSQL ('double precision', 'text', 'integer') que la base ne produit pas,
et des extents sur du texte que l'API ne calcule plus. Le SDL officiel est suivi à la
racine de dashboard-template-api (schema.graphql) et publié en asset de chaque release.

À faire :
1) Script npm "sync:schema" : copie le SDL d'une version ÉPINGLÉE de l'API (variable
   API_SCHEMA_REF, ex. v0.3.0) depuis l'asset de release GitHub, ou depuis
   ../dashboard-template-api/schema.graphql si API_SCHEMA_PATH est défini ; écrit
   scripts/schema.graphql avec un en-tête « généré — ne pas éditer » et la version.
2) check:gql valide contre ce SDL (inchangé sinon).
3) Fixtures réécrites au contrat 0.3.0 : Metadata en camelCase avec types DuckDB (DOUBLE,
   BIGINT, DATE, VARCHAR, BOOLEAN), unit, displayFormat, family, parentName, labelFor,
   labelFields, typeFamily et filterOperations si l'API les expose (A11) ;
   DatasetWithMetadata.fields aligné sur columns ; extents numériques et dates seulement ;
   une hiérarchie à 2 niveaux pour getSelectOptionsTree ; des FieldStats par champ.
4) Résolveurs du mock (serveur ET transport en mémoire src/lib/api/transports/mock.js) :
   getFactTableWithMetadata (avec fields), getCatalogSchema, getSelectOptions,
   getSelectOptionsTree (searchTerm, maxDepth), getFieldStats ; suppression de
   getGroupedSelectOptions. Mock du scalaire JSON (valeurs des fixtures, jamais aléatoires).
5) Test vitest : chaque document de src/lib/api/documents s'exécute contre le mock serveur
   sans erreur.

Critères d'acceptation : npm run sync:schema puis npm run check:gql échoue sur les 3
documents actuels (preuve que le contrôle est rebranché), et F2 le rendra vert ;
npm run mock:api sert les nouvelles opérations sans erreur.

Vérification : npm run lint && npm test && npm run sync:schema && npm run check:gql
(échec attendu jusqu'à F2 : le signaler dans le résumé, sans corriger les documents ici).
Conventions du dépôt (CLAUDE.md) : commentaires français, JSDoc anglaise. Ne commite pas ;
propose :
build: sync the GraphQL schema from a pinned API release and update the mock server
```

---

## F2 — Front : documents 0.3.0, métadonnées, types, en-têtes, `fields`

- **Modèle : Opus 5.5.** Migration de contrat répartie dans plusieurs features, avec une restructuration de la configuration des opérations.
- **Effort : high.**
- **Plan mode : oui.** À valider : la nouvelle forme d'`operations.json` et la liste des consommateurs.
- **Dépôt / branche** : `dashboard-template-frontend`, `qb-api-0.3-adaptation`. **Après F1 et A11.**

```text
Contexte (prouvé contre l'API réelle 0.3.0) :
- src/lib/api/documents : GET_CATALOG_SCHEMA demande python_type, sql_type,
  is_categorical, is_primary_key (champs supprimés ou renommés en camelCase) ;
  GET_FACT_TABLE_WITH_METADATA déclare $structuredFilters: [Filter] (type supprimé,
  remplacé par FilterNode) ; GET_GROUPED_SELECT_OPTIONS vise une opération supprimée
  (remplacée par getSelectOptionsTree, traitée en F4).
- Modèle de types PostgreSQL (src/features/filter/utils/filterTypes.js:25-43,
  config/filter/operations.json indexé par integer/bigint/double precision…). Les types
  DuckDB de la base (DOUBLE, TINYINT, U*INT, HUGEINT, BOOLEAN, DECIMAL(p,s)) ne sont pas
  numériques : opérateurs texte sur les mesures, colonnes alignées à gauche,
  deriveEncoding (src/page-templates/utils/deriveEncoding.js:49-50) ne trouve aucun y et le
  graphique de la page indicateur est masqué. Opérations en minuscules (in, between…)
  alors que l'enum de l'API est en majuscules.
- L'API expose Metadata.typeFamily (INTEGER NUMBER DATE TIMESTAMP TEXT BOOLEAN OTHER) et
  Metadata.filterOperations ([FilterOperation!]!) : la règle type → opérations est celle
  du serveur, à ne PAS recopier.
- Transport (src/lib/api/transports/graphql.js) : envoie X-Catalog-Id / X-Schema-Id. L'API
  ne lit plus ces en-têtes et le CORS ne les autorise pas : ils font échouer le preflight.
- useFactTableWithMetadata (src/features/table/sources/) lance getCatalogSchema en
  parallèle puis restrictToColumns ; IndicatorPage lit un échantillon d'une ligne pour
  avoir columns. DatasetWithMetadata.fields ([Metadata!]!, aligné sur columns) les remplace.

À faire :
1) Documents au contrat 0.3.0 (camelCase ; $structuredFilters: FilterNode ; fields
   { name label sqlType typeFamily filterOperations isCategorical isPrimaryKey unit
   displayFormat labelFor labelFields parentName } dans getFactTableWithMetadata).
2) filterTypes.js : prédicats sur typeFamily (isNumeric = INTEGER|NUMBER, isDate =
   DATE|TIMESTAMP) ; suppression des tables PostgreSQL. operations.json devient un
   catalogue de LIBELLÉS indexé par valeur d'enum ({ "EQ": "=", "BETWEEN": {fr, en}… }) ;
   la liste proposée = metadata.filterOperations (moins celles que l'UI n'implémente pas,
   liste explicite) ; valeurs d'opération en majuscules dans tout le modèle interne
   (defaultValue, isComplete, filterEngine, defaultFilterEngine).
3) Tous les consommateurs en camelCase : useVariableMetadata/metadataToVariables,
   IndicatorExplorer, Table (type 'number' si typeFamily numérique et !isCategorical),
   deriveEncoding (x = DATE|TIMESTAMP, y = numérique non catégoriel), CriterionMenu,
   MultiCriterionMenu, ValueField.
4) Transport : plus d'en-têtes X-Catalog-Id / X-Schema-Id ; catalog et schema en
   arguments seulement.
5) Table et page indicateur : fields de DatasetWithMetadata ; suppression de la requête
   getCatalogSchema parallèle et de restrictToColumns quand fields est disponible ;
   IndicatorPage (structure prérendue) lit fields d'une requête limit: 1.
6) Tests vitest mis à jour (filterTypes.test.js, defaultFilterEngine.test.js…) ; npm run
   check:gql vert.

Critères d'acceptation : check:gql vert contre le SDL épinglé ; en mode mock, la page
indicateur affiche le graphique pour une mesure DOUBLE ; une mesure DOUBLE propose EQ…
BETWEEN, une DATE propose BEFORE/AFTER ; aucun en-tête X-Catalog-Id dans les requêtes.

Vérification : npm run lint && npm test && npm run check:gql && npm run validate:config.
Conventions du dépôt. Ne commite pas ; propose :
feat!: migrate to the 0.3.0 API contract (camelCase metadata, type families, dataset fields)
```

---

## F3 — Front : le filtre du dashboard envoyé à l'API, extraits de requête

- **Modèle : Opus 5.5.** La sémantique du filtre (connecteurs, précédence, groupes, négation) doit être identique des deux côtés.
- **Effort : high.**
- **Plan mode : oui.** À valider : le mapping exact et le sort des critères incomplets.
- **Dépôt / branche** : `dashboard-template-frontend`, `qb-api-0.3-adaptation`. **Après F2.**

```text
Contexte :
- Le filtre du MultiCriterionMenu n'est JAMAIS envoyé : IndicatorExplorer appelle
  useFactTableWithMetadata() sans argument (src/page-templates/components/IndicatorExplorer/
  IndicatorExplorer.jsx:117) et filtre les lignes chargées par evalFilterNode (:133) ;
  <Table> fait de même (src/features/table/hooks/useDataTableState.js:117-118). Graphique,
  tableau et KPI montrent un sous-ensemble de la première page (100 lignes).
- Il n'existe pas de conversion buildTree → FilterNode. Contrat de l'API (schema.graphql) :
  input FilterNode { connector: FilterConnector, negate: Boolean = false,
  criterion: FilterCriterion, children: [FilterNode!] } ; exactement un de criterion ou
  children ; racine = groupe ; groupes non vides ; connector = connecteur avec le nœud
  PRÉCÉDENT du groupe (ignoré pour le premier) ; FilterCriterion { variable, operation,
  value: JSON } ; value : scalaire, tableau non vide (IN/NOT_IN), {min, max} (BETWEEN),
  absente (IS_NULL…) ; dates en ISO 8601 ; entiers au-delà de 2^53 en chaîne. L'API REJETTE
  un critère incomplet (pas de placeholder « ? »).
- src/features/table/utils/querySnippets.js génère l'ancien contrat ([Filter],
  {key, operator: 'IN', values} :7, :48), un endpoint localhost:4000 et un
  Authorization: Bearer (:103, :136, :160) alors que l'API n'a pas d'authentification :
  aucun extrait ne fonctionne.

À faire :
1) toFilterNode(tree) dans src/features/filter/utils/filterEngine.js (fonction pure) :
   groupe → {connector, children} ; critère → {connector, criterion: {variable, operation,
   value}} ; dates JJ/MM/AAAA → YYYY-MM-DD ; plage « A → B » → {min, max} ; nombres en
   number ; critères incomplets OMIS (et groupes devenus vides supprimés) ; expression non
   équilibrée → null (pas de filtre) avec l'indicateur existant ; renvoie null pour un
   arbre vide.
2) IndicatorExplorer : structuredFilters = toFilterNode(filter.tree), passé à
   useFactTableWithMetadata (clé SWR stable : JSON de l'arbre) ; <Chart> reçoit les lignes
   filtrées par le serveur ; evalFilterNode n'est plus utilisé pour des données de l'API
   (il reste pour les données statiques passées en prop).
3) Filtres de colonne du tableau (TableFilterPopover) : options par getSelectOptions
   (liste complète, recherche serveur) quand la table est adossée à l'API ; sélection →
   critère IN ajouté au FilterNode envoyé.
4) querySnippets : FilterNode (critères IN des colonnes filtrées, combinés au filtre du
   menu), endpoint = NEXT_PUBLIC_API_URL, pas d'Authorization ; nouvel extrait « export »
   (curl -OJ …/api/export?format=parquet&filters=<url-encodé>).
5) Tests vitest de toFilterNode : AND/OR, sous-groupes, critère incomplet omis, dates,
   plages, IN ; test de contrat : chaque sortie est valide contre le SDL épinglé (validation
   graphql des variables).

Critères d'acceptation : en mode mock serveur (F1), un filtre du menu produit une requête
dont les variables valident contre le SDL ; contre l'API de test, filtrer « country IN
(France) » change total ; les extraits copiés s'exécutent tels quels contre l'API de test.

Vérification : npm run lint && npm test && npm run check:gql.
Conventions du dépôt. Ne commite pas ; propose :
feat: send the dashboard filter tree to the API as a FilterNode
```

---

## F4 — Front : options hiérarchiques, bornes et KPI depuis l'API

- **Modèle : Sonnet 5.** Branchement de requêtes existantes sur des composants existants.
- **Effort : medium.**
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-frontend`, `qb-api-0.3-adaptation`. **Après F3.**

```text
Contexte :
- SelectMenu groupé : getGroupedSelectOptions est supprimé de l'API ; la recherche du mode
  groupé est faite en local (src/components/filter/SelectMenu/useSelectOptions.js:58-72).
  L'API fournit getSelectOptionsTree(fieldName, maxDepth, searchTerm): JSON
  [{value, label, children?}] ; maxDepth: 2 sur la feuille = le format group-options ;
  searchTerm filtre les feuilles en gardant leurs ancêtres.
- useRangeBounds (src/components/filter/ConstraintField/useRangeBounds.js:21-32) est un
  bouchon local (bornes codées en dur par nom de champ) ; l'API fournit
  getFieldStats(fieldName, structuredFilters) { min max distinctCount nullCount } et
  Metadata.stats.
- KPI (IndicatorExplorer.jsx:162-171) : « observations » = metadata.count (taille de la
  PAGE) au lieu de metadata.total ; « période » et « amplitude » = extents de la page.

À faire :
1) Mode groupé : getSelectOptionsTree(fieldName, maxDepth: 2, searchTerm) mappé en
   [{group: {value: n.value, label: n.label}, options: n.children ?? []}] ; searchTerm dans
   la clé SWR (recherche serveur) ; filtrage local supprimé ; groupField déduit de
   Metadata.parentName quand il n'est pas fourni.
2) useRangeBounds → getFieldStats(fieldName, structuredFilters courant) ; step : INTEGER →
   1 ; DATE → 1 jour ; TIMESTAMP → 1 heure ; NUMBER → précision de displayFormat si elle
   existe, sinon (max - min) / 100 arrondi à une puissance de 10 ; les props min/max
   explicites restent prioritaires.
3) KPI : metadata.total ; bornes via getFieldStats (x et y, filtre courant).
4) Mock (F1) : fixtures cohérentes ; tests vitest des hooks et du mapping.

Critères d'acceptation : en mode groupé, une commune n'apparaît que sous son département ;
la recherche « beau » renvoie Beaune avec son département ; le slider d'une mesure reflète
min/max du jeu filtré ; KPI observations = total.

Vérification : npm run lint && npm test && npm run check:gql.
Conventions du dépôt. Ne commite pas ; propose :
feat: read option trees, field bounds and totals from the API
```

---

## F5 — Front : exports du tableau via `/api/export`

- **Modèle : Sonnet 5.** Construction d'URL et gestion des statuts HTTP.
- **Effort : medium.**
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-frontend`, `qb-api-0.3-adaptation`. **Après F3** (et A12 pour le POST et le 413).

```text
Contexte : les boutons CSV et « Parquet » de <Table> exportent côté client les seules
lignes chargées ; sans onExportParquet, le « Parquet » est du JSON nommé .parquet.json
(src/features/table/components/Table.jsx:196-203). L'API offre GET /api/export
(catalog, schema, fields, filters = JSON d'un FilterNode, sort = "col:asc,col2:desc",
format = csv|parquet|arrow, limit) et, après le prompt A12, POST /api/export (même corps
en JSON), 413 si le jeu dépasse MAX_ROWS sans limit, en-têtes X-Row-Count, X-Truncated,
Content-Disposition (exposés au CORS) ; après A13, bom=1 pour le CSV.

À faire :
1) Adossée à l'API, la table exporte via /api/export : fields = colonnes visibles, filters
   = FilterNode courant (F3), sort = tri courant, format csv (avec bom=1) ou parquet ;
   POST dès que l'URL dépasserait 4 000 caractères ; téléchargement en flux (fetch → blob
   → downloadBlob, nom tiré de Content-Disposition).
2) Gestion des statuts : 413 (message invitant à filtrer), 429 (Retry-After), 400 (detail
   de l'API) via le mécanisme d'annonce existant.
3) Hors API (données statiques) : export CSV client inchangé ; le faux Parquet JSON est
   supprimé (bouton masqué sans API).
4) Tests vitest : construction d'URL et de corps, choix GET/POST, statuts.

Critères d'acceptation : contre l'API de test, l'export Parquet d'un tableau filtré est
relu par DuckDB avec le bon nombre de lignes (= total) ; plus aucun fichier .parquet.json.

Vérification : npm run lint && npm test.
Conventions du dépôt. Ne commite pas ; propose :
feat: export the full filtered dataset through the API export endpoint
```

---

## F6 — Front : typage et mise en forme du graphique et du tableau par les métadonnées

- **Modèle : Sonnet 5.** Branchement de métadonnées existantes dans des composants existants.
- **Effort : high.** Écart assumé : `<Chart>` et `<MultiChart>` sont gros et le risque de régression visuelle est réel.
- **Plan mode : non.**
- **Dépôt / branche** : `dashboard-template-frontend`, `qb-api-0.3-adaptation`. **Après F2.**

```text
Contexte :
- detectType (src/features/chart/utils/typeDetection.js:12-34) échantillonne les valeurs :
  un code NC8 '01012100' passe pour un nombre et coerce le convertit en 1012100 (zéros de
  tête perdus) ; même risque pour les codes INSEE.
- unit et displayFormat (d3-format) sont ignorés : formatCell fait toLocaleString,
  deriveEncoding affirme que les métadonnées ne portent pas l'unité
  (src/page-templates/utils/deriveEncoding.js:64-65), formatExtent formate à une décimale.
- L'API fournit pour chaque colonne (DatasetWithMetadata.fields) : typeFamily,
  isCategorical, unit, displayFormat, label, labelFields.

À faire :
1) Prop `fields` sur <Chart> et <MultiChart> : si présente, le type de chaque colonne vient
   de typeFamily (DATE/TIMESTAMP → date ; INTEGER/NUMBER non catégoriel → number ; sinon
   categorical) et detectType n'est plus appelé ; sans fields, comportement inchangé.
2) Formateur unique src/utils/format/formatValue.js : d3-format(displayFormat) + unit,
   localisé par intlLocale ; utilisé par les axes, infobulles, formatCell (ColumnDef dérivé
   de fields), StatCard et formatExtent. displayFormat absent → comportement actuel.
3) Table : colonne de code avec labelFields → option d'affichage « code — libellé »
   (colonne de libellés présente dans les données).
4) Tests vitest : codes à zéros de tête gardés en catégoriel avec fields ; formats
   ",.2f" + "€", ".0%" ; absence de displayFormat.

Critères d'acceptation : un graphique groupé par nc8 garde '01012100' ; une mesure
displayFormat ".1%" s'affiche en pourcentage sur l'axe, l'infobulle et la cellule.

Vérification : npm run lint && npm test && npm run test:e2e (captures à mettre à jour si
elles changent volontairement ; le signaler).
Conventions du dépôt. Ne commite pas ; propose :
feat: type and format charts and tables from column metadata
```

---

## F7 — Front : séries agrégées côté serveur pour `<Chart>`

- **Modèle : Opus 5.5.** Choix d'architecture : quand agréger côté serveur ou côté client, et le branchement dans la sélection du type de graphique.
- **Effort : high.**
- **Plan mode : oui.**
- **Dépôt / branche** : `dashboard-template-frontend`, branche `qb-aggregates` depuis la branche de migration fusionnée. **Après A14** (API 0.4.0) **et F6.**

```text
Contexte : <Chart> agrège lui-même par une moyenne codée en dur (aggregate: 'mean' dans
buildStacks, src/features/chart/components/Chart/Chart.jsx:409, :517 ; BarMarks,
HeatmapMarks, MiniProjection), sans tenir compte de Metadata.defaultAggregation (un SUM de
population est moyenné), et sur la seule page chargée. L'API 0.4.0 expose
getAggregates(groupBy, aggregates, structuredFilters, sort, limit, format: OBJECTS|ARRAYS|LONG)
→ AggregateResult { columns, data, aggregates: [AggregateColumn {alias, measure,
aggregation, unit, displayFormat, extent, field}], groupFields, total } ; groupBy accepte
un grain temporel (MONTH…). Les lignes OBJECTS {x, hue, value_sum} sont directement le
format long de <Chart> (y = alias) ; LONG donne {groupes…, measure, value} pour tracer
plusieurs agrégats en séries hue.

À faire :
1) Document GET_AGGREGATES + hook useAggregates (SWR), fixtures et mock (F1).
2) Page indicateur (et prop optionnelle de <Chart> : `aggregate` = {measure, aggregation?}) :
   pour les graphiques qui regroupent (barres, piles, heatmap), requête getAggregates
   (groupBy = [x (+ grain si date), hue], agrégation par défaut de la mesure) et rendu SANS
   ré-agrégation (buildStacks avec aggregate: 'none' ou équivalent) ; KDE, violon et nuage
   restent sur les lignes brutes.
3) Plusieurs mesures : format LONG et hue = measure ; libellés des séries tirés de
   aggregates[].field.label ; unités et formats via le formateur de F6.
4) Tests vitest : choix serveur/client par type de graphique ; aucune double agrégation ;
   agrégation par défaut respectée (SUM vs AVG).

Critères d'acceptation : sur le schéma de test geography, un graphique en barres de
population par région égale le SUM calculé par DuckDB sur tout le jeu (pas sur la page) ;
basculer la mesure sur une mesure AVG change l'agrégation sans code spécifique.

Vérification : npm run lint && npm test && npm run check:gql && npm run test:e2e.
Conventions du dépôt. Ne commite pas ; propose :
feat: render grouped charts from server-side aggregates
```

---

## Jalons

| Étape                              | Condition                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Fusion de `qb-schemav2-adaptation` | A1 à A5 commités, `npm test` vert, `schema:check` et `codegen:check` verts ; A6 recommandé             |
| Tag 0.3.0                          | + A11 (et idéalement A9, A10, A12) ; `npm run schema:diff` relu ; asset `schema.graphql` publié        |
| Front branché sur l'API            | F1 → F3 fusionnés, épinglés sur 0.3.0 ; `CORS_ORIGINS` de production contenant l'origine du front (A4) |
| Production multi-réplicas          | A6, A7 (après D1), A8, A16                                                                             |
| 0.4.0                              | A14, A15, puis F7                                                                                      |
