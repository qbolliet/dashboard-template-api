# Revue technique — API GraphQL (dashboard-template-api)

> Date : juillet 2026. Périmètre : ce dépôt (API GraphQL Apollo Server 5 + Express 5 +
> `@duckdb/node-api`). Document compagnon de `revue-technique-bdd.md` (spécification
> « schéma v2 » côté base) : il répond aux questions posées sur l'API, analyse le code
> existant et sert de **spécification cible** pour la série de prompts
> (`prompts-migration-api-v2.md`).

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
  `measures`, `dimensionDetails`, `metadata`, `total`...), et là GraphQL apporte
  réellement quelque chose (le `COUNT(*)` de `total` pourrait n'être exécuté que s'il
  est demandé).
- **Un point d'entrée unique multi-sources** : plusieurs catalogues/schémas servis par
  le même endpoint, avec composition (`compareFacts`, `getSharedDimensions`).
- **Le contrat typé introspectable** : toute votre chaîne de documentation (SDL généré,
  graphql-markdown, voyager) et le futur codegen découlent gratuitement du schéma.
- **Le chargement paresseux par selection set** : `getCatalogs` ne charge
  `fields`/`dimensionNames` que si demandés (`src/schema/typedefs/catalog.ts:20-27`) —
  idiome GraphQL propre, impossible à exprimer aussi simplement en REST.

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
  vos resolvers sont de type RPC (`getFactTable`, `getAggregatedFacts`...). L'avantage
  net de GraphQL est donc _modéré_, mais les coûts étant déjà payés et les bénéfices
  (projection, contrat, outillage) réels, **une migration vers REST serait une pure
  perte**.

### Sur vos deux questions précises

- **« GraphQL simplifie les associations entre schémas »** : nuance. Les jointures
  cross-schéma sont faites **en SQL dans les loaders** (`src/loaders/cross-database.ts`),
  pas par la composition GraphQL — un endpoint REST `/compare` ferait la même chose.
  Le bénéfice réel est l'_unicité de surface_ : un seul schéma typé qui expose à la
  fois les données, les métadonnées et les comparaisons. C'est un bon point, mais ce
  n'est pas un argument « GraphQL-only ».
- **La citation REST vs GraphQL** : vos trois critères (bande passante, sources
  multiples, requêtes clients très variables) sont précisément ceux d'un dashboard
  data-driven multi-catalogues. Ce que vous « perdez » (cache HTTP, streaming,
  simplicité sécurité) est identifié et couvert (Redis, endpoint REST, `src/security/`).

### Alternatives écartées — d'accord avec vous

- **Cube.js** : le _concept_ (couche sémantique pilotant l'UI) est exactement le vôtre —
  mais votre table `metadata` **est** déjà cette couche sémantique, en plus simple et
  sous votre contrôle. La renforcer (schéma v2) vaut mieux que d'adopter une dépendance
  dont la pérennité vous inquiète à raison.
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
- CORS restreint, en-têtes HSTS/nosniff/DENY, compression, timeouts applicatifs.

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
par IP, timeout) — intégrés au prompt 6.

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
  `havingFilters: [Filter]`) ; pas urgent, non inclus dans la série de prompts.
- Bémol mineur : le format `measures: [{name, value}]` est verbeux en JSON ; pour les
  tableaux volumineux, `getFactTableWithMetadata(format: ARRAYS)` répond déjà au
  besoin de compacité.

---

## 4. Frontend data-driven : état des lieux besoin par besoin

| Besoin UI                                                       | Aujourd'hui                                                                                                                                                                     | Reste à faire (v2)                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Liste colonnes + labels pour un select                          | ✅ `getFields` → `{value, label}`, filtrable par type/catégorie                                                                                                                 | Ajouter le filtre `family`                                                                                                   |
| Type d'une variable → opérateurs de filtre + type de menu       | ✅ `Metadata.sql_type`                                                                                                                                                          | Exposer `unit`, `display_format`, `family`, `description`, `default_aggregation`, `parent_name` (v2) ; retirer `python_type` |
| Min/max des numériques et dates (calibrage sliders/datepickers) | ❌ **Manque.** `DatasetMetadata.extents` n'est calculé que sur la _page retournée_ (`src/db/pool.ts:643-651`), uniquement pour les valeurs `number` — **jamais pour les dates** | Nouveau champ `stats` (min/max/distinctCount) — voir ci-dessous                                                              |
| Modalités d'une catégorielle → select-menu                      | ✅ `getSelectOptions`                                                                                                                                                           | v2 : `SELECT DISTINCT` partout, labels via `label_maps` opt-in                                                               |
| Données `Array[Row]` + méta pour graphiques                     | ✅ `getFactTableWithMetadata` (OBJECTS/ARRAYS, extents de page, total, pagination)                                                                                              | rien                                                                                                                         |
| Group-options hiérarchiques                                     | ⚠️ `getGroupedSelectOptions` retourne **deux listes indépendantes non corrélées** (`src/schema/resolvers/select-options.ts:95-103`)                                             | Refonte : `[{group, options}]` corrélé + hiérarchies n niveaux (v2)                                                          |

### Min/max : matérialiser dans `metadata` ou calculer ?

**Ne pas matérialiser dans la table `metadata`.** C'est une donnée _dérivée_ : le
writer devrait la maintenir à chaque update (risque d'obsolescence silencieuse —
exactement la classe de bugs que la v2 élimine en supprimant les bascules
catégorielles). Votre intuition « métadonnées classiques très simples à calculer »
est la bonne :

1. DuckLake maintient des **statistiques de colonnes dans le catalogue**
   (min/max par fichier, stats globales par table) — lecture quasi gratuite, à
   vérifier selon la version (attention au comportement après DELETE).
2. Même sans elles, `SELECT MIN(col), MAX(col)` sur du Parquet avec zone-maps est
   rapide à l'échelle de vos volumes.

**Design recommandé** : un champ `stats: FieldStats` (min, max, distinctCount) sur le
type `Metadata`, **résolu paresseusement** (calculé seulement si présent dans le
selection set), avec cache Redis long — invalidé par le flux existant (votre updater
nocturne appelle déjà `/api/cache/invalidate-all`, la fraîcheur est donc garantie par
construction). Le front récupère alors colonnes + types + bornes en **une seule
requête** `getCatalogSchema`. En complément : un argument `structuredFilters` optionnel
sur une query `getFieldStats` pour recalibrer les sliders après filtrage. Prompt 5.

---

## 5. Vos modifications commentées

### 5.1 Adaptation au schéma v2 (Metadata, select-options, compare\*)

Validé sur toute la ligne, avec trois précisions :

- **`getGroupedSelectOptions` : ce n'est pas un simple changement de forme.** La
  version actuelle charge les deux champs _indépendamment en parallèle_ — aucun
  mapping parent→enfants n'est calculé. Votre sortie `[{group, options}]` exige un
  `SELECT DISTINCT parent, enfant` corrélé : c'est une **correction fonctionnelle**,
  pas cosmétique. Elle se généralise à n niveaux via `metadata.parent_name` (cas A de
  la revue bdd §4), et le `groupField` peut même devenir optionnel (dérivé de
  `parent_name`).
- **Collision de nom à anticiper** : le schéma GraphQL a déjà un type
  `DatasetMetadata` (métadonnées de pagination, `src/schema/typedefs/fact.ts:67`). La
  table `dataset_metadata` v2 devra être exposée sous un autre nom (`DatasetInfo`).
- **v1 et v2 en parallèle ?** Recommandation : **API v2-only** (bump majeur). Vous
  contrôlez les deux côtés, le script de migration (prompt 6 côté bdd) convertit les
  catalogues, et `schemaVersion` exposé dans `getCatalogs` permet à l'API de refuser
  proprement (erreur explicite) un catalogue non migré. Maintenir un double chemin de
  code (dim/DISTINCT) recréerait la complexité que la v2 supprime.
- Dépréciation douce : `getDimensionTable`, `Fact.dimensionDetails`,
  `AggregatedFact.keyLabel` marqués `@deprecated` dans le SDL et renvoyant l'identité
  (value == label) pendant une version, puis retrait.
- **Fenêtre à saisir** : le type `Metadata` est en snake_case (`python_type`,
  `is_categorical`...), contraire à la convention GraphQL. La v2 étant déjà breaking,
  c'est LE moment de passer en camelCase (`sqlType`, `isCategorical`,
  `displayFormat`...) — plus jamais l'occasion ne sera aussi peu coûteuse.

### 5.2 Export REST Arrow / CSV / Parquet

**Pleinement validé — c'est la bonne réponse** à la fois au plafond de pagination
(`MAX_OFFSET: 10000`, `config/api.yaml:39`) et à l'ordre de grandeur perdu en
sérialisation JSON. Design recommandé :

- `GET /api/export` (GET, pas POST : curlable, partageable, cacheable) avec
  `catalog`, `schema`, `fields`, `filters` (JSON de `structuredFilters`), `sort`,
  `format=arrow|csv|parquet`.
- Content-Types : `application/vnd.apache.arrow.stream`, `text/csv`,
  `application/vnd.apache.parquet` + `Content-Disposition` avec nom de fichier daté.
- Réutilisation de `validateIdentifier` + `buildWhereClause` **après** la sécurisation
  du §2 (le prompt 1 est un prérequis).
- Garde-fous propres : plafond de lignes configurable, limite de streams concurrents
  par IP, timeout, intégration au rate limiter existant.
- Implémentation : DuckDB fait le gros du travail (`COPY (SELECT ...) TO ... (FORMAT
parquet/csv)` vers fichier temporaire streamé, ou streaming par chunks via
  `@duckdb/node-api` + `apache-arrow` pour l'IPC Arrow) — les noms d'API exacts sont à
  vérifier dans la doc de la version installée, le prompt 6 l'exige explicitement.

### 5.3 Versioning du schéma GraphQL

- **Pas de `/v2` d'URL** : la norme GraphQL est l'évolution continue du schéma +
  directives `@deprecated` + retrait après préavis. Le SemVer du package (release-please
  déjà en place) **est** la version de l'API : breaking schéma → majeur.
- **Changelog : un seul.** release-please génère déjà le CHANGELOG.md depuis les
  conventional commits — les changements de schéma y figurent naturellement
  (`feat(schema):`, `feat!:`). Un second changelog manuel du schéma dériverait
  (double maintenance). À la place, **générer le diff SDL automatiquement** à chaque
  release et publier `schema.graphql` (déjà produit par `npm run docs:schema`) comme
  artefact de release.
- **Le manque réel : un garde-fou CI.** `graphql-inspector diff` contre le SDL de la
  release précédente, qui échoue le CI sur breaking change non signalé (commit sans
  `!`). C'est ce qui rend la politique de dépréciation opposable. Prompt 7.

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
   utilisez `@graphql-codegen`. Et il y a **deux** usages, dont un que vous n'avez pas
   mentionné :
   - _côté clients_ : documenter une config codegen type dans la skill / le site de
     doc (les tiers génèrent leurs types depuis le SDL publié) ;
   - _côté API elle-même_ : `@graphql-codegen/typescript-resolvers` générerait les
     types de vos resolvers depuis le SDL — aujourd'hui vos interfaces TS
     (`SelectOptionsArgs`, etc.) sont écrites à la main et peuvent dériver du schéma.
     Gain de robustesse interne réel.
3. **Le manque le plus intéressant : un dictionnaire des données auto-généré** depuis
   `metadata` + `dataset_metadata` (une page par schéma : colonnes, labels, types,
   unités, familles, descriptions). C'est la moitié « projet-spécifique » de votre
   split de sites, et elle est data-driven par construction — la doc des données se
   régénère quand les données changent, personne ne la maintient à la main.

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
   relu depuis la table `metadata` (`sqlType`), qui détermine la famille (numérique /
   date / texte) et donc les opérations autorisées. Colonne inconnue ou opération
   incompatible avec le type → `GraphQLError BAD_USER_INPUT` explicite.
2. **SQL paramétré** : `treeToSQL` retourne `{sql, params}` (placeholders `?`) plutôt
   que des chaînes échappées — `@duckdb/node-api` supporte les paramètres, seuls les
   identifiants (validés par `validateIdentifier`) sont interpolés.
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

---

## 6. Points faibles relevés hors de vos questions

1. **Sécurité écrite mais non branchée** (rate limiting, complexité, sanitization) —
   détaillé au §2 ; c'est le point le plus important de cette revue.
2. **Erreurs avalées dans les select-options** : `loadSelectOptions` fait
   `catch { return []; }` (`src/loaders/select-options.ts:79-81`) — un champ
   inexistant, une table absente ou une panne DB sont indistinguables d'une liste
   vide côté front. Remonter une `GraphQLError` explicite (corrigé au prompt 3).
3. **`MAX_OFFSET: 10000`** : limite de conception acceptable pour un dashboard, à
   documenter comme telle ; l'export REST couvre le besoin au-delà.
4. **Interfaces TS dupliquées du SDL** à la main (cf. §5.4, codegen resolvers) ; de
   même, le scalaire `JSON` est déclaré sans resolver custom (passthrough par défaut) —
   fonctionne, mais un vrai `GraphQLScalarType` (ex. `graphql-type-json`) rendrait la
   sérialisation explicite.
5. Les données de test (`tests/setup/setup-test-data.ts`) devront être régénérées au
   format v2 — c'est le premier prérequis technique de toute la série de prompts.

---

## 7. Synthèse

**Forces** : la projection de colonnes effective jusqu'au SQL ; la table `metadata`
comme contrat UI (à renforcer en v2) ; le cache Redis systématique sur tous les
loaders avec invalidation pilotée par l'updater ; la chaîne de doc générée depuis le
schéma ; release-please en place ; le blocage des mutations et le depth-limit actifs.

**Faiblesses** : rate limiting / complexité / sanitization **codés mais non branchés** ;
`filters` SQL brut, `operator` et `fields` non contrôlés (correctif n°1) ;
group-options non corrélées ; pas de min/max de colonne pour les menus ; pas d'export
volumineux ; pas de garde-fou CI sur les breaking changes du schéma ; types resolvers
manuels.

**Évolutions majeures anticipables sans refonte** : ajout de HAVING, subscriptions
GraphQL (données quasi statiques : inutile aujourd'hui), fédération si d'autres
services apparaissent, nouveau format d'export — toutes s'insèrent dans
l'architecture actuelle. Le seul scénario qui imposerait une refonte serait
l'abandon de DuckLake, et la couche loaders isole déjà le SQL du schéma GraphQL.
