# Prompts d'implémentation — adaptation de l'API au schéma v2 et évolutions

> Série de prompts à exécuter **dans l'ordre**, chacun dans une session Claude Code
> fraîche, depuis la racine de ce dépôt (`dashboard-template-api`). La spécification
> cible est dans `refonte_dashboard_template_api/revue-technique-api.md` (API) et
> `refonte_dashboard_template_api/revue-technique-bdd.md` §8 (schéma v2 de la base) :
> chaque prompt demande leur lecture — ne pas les supprimer avant la fin de la série.
>
> **Prérequis global** : la migration v2 du package Python (`dt_ducklake_manager`,
> prompts 1 à 7 de `prompts-migration-schema-v2.md`) doit être terminée, et la skill
> `dashboard-api-client` doit contenir la section « Database schema v2 ».
>
> **Conventions communes** (rappelées dans chaque prompt, en complément de CLAUDE.md) :
> TypeScript strict avec types explicites ; commentaires en FRANÇAIS (formulations
> nominales) ; docstrings JSDoc/TSDoc en ANGLAIS, convention Google, avec `@param` /
> `@returns` / `@throws` — c'est le style du code existant, l'imiter. Vérification en
> fin de prompt : `npm run lint`, `npm run type:check`, `npm run test:setup` puis
> `npm test` — corriger jusqu'au vert.
>
> **Choix du modèle** : Opus pour les prompts qui exigent des décisions d'architecture,
> touchent des invariants de sécurité ou beaucoup de fichiers interdépendants
> (1, 2, 3, 4, 7) ; Sonnet pour les tâches mécaniques bien spécifiées (5, 6, 8, 9).
> **Plan mode** : activé quand des choix d'implémentation doivent être validés avant
> d'écrire ; inutile quand la spécification ci-dessous est déjà un plan.

---

## Prompt 1 — Filtres en arbre : suppression de `filters`, `structuredFilters` → `FilterNode` + `treeToSQL`

**Modèle : Opus · Plan mode : OUI · Dépendances : aucune**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-api.md (sections 2 et
5.5 — le contrat GraphQL cible et les règles du treeToSQL y sont spécifiés). L'API
est publique : l'argument filters (String) est un prédicat SQL brut injecté tel quel
dans le WHERE (src/utils/utils.ts:48-49), l'operator des structuredFilters n'est pas
contrôlé, et l'argument fields est concaténé dans le SELECT sans validation
(src/loaders/base-loader.ts:289-291). Objectif : supprimer filters, remplacer la
liste plate [Filter] par un arbre de critères aligné sur le MultiCriterionMenu du
frontend (fonction buildTree de son filterEngine.js), et convertir cet arbre en SQL
par une fonction treeToSQL durcie côté serveur. Rupture assumée du contrat (l'API
part en release majeure v2) : pas de période de dépréciation pour filters ni pour
l'ancienne forme plate.

1) Typedefs (src/schema/typedefs/common.ts) : remplace input Filter par le contrat
   de la revue §5.5 — enum FilterConnector { AND OR }, enum FilterOperation
   { EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN BEFORE AFTER CONTAINS STARTS IS_NULL
   IS_NOT_NULL }, input FilterCriterion { variable: String!, operation:
   FilterOperation!, value: JSON }, input FilterNode { connector: FilterConnector,
   criterion: FilterCriterion, children: [FilterNode!] } avec la règle « exactement
   un des deux champs criterion/children » documentée dans les descriptions SDL.
   Sur getFactTable, getFactTableWithMetadata, getAggregatedFacts et
   getAggregatedFactsWithMetadata : supprime l'argument filters et change
   structuredFilters en FilterNode (racine = groupe). Le connector d'un nœud est le
   connecteur avec le nœud PRÉCÉDENT de son groupe (null/ignoré pour le premier) —
   même sémantique que connectorBefore dans le frontend.

2) Nouveau module src/utils/filter-tree.ts : treeToSQL(node, metadataByName) ->
   { sql: string, params: unknown[] }. Règles impératives (revue §5.5) :
   - SQL paramétré : les valeurs deviennent des placeholders ? et partent dans
     params ; SEULS les identifiants, validés par validateIdentifier, et les
     mots-clés SQL issus du mapping interne des FilterOperation sont interpolés.
   - Typage par le serveur, jamais par le client : metadataByName vient de la table
     metadata (loader existant). La famille de type de la colonne (numérique / date
     ou timestamp / texte, dérivée de sqlType) détermine les opérations autorisées :
     numérique → EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN IS_NULL IS_NOT_NULL ;
     date → EQ NEQ BEFORE AFTER BETWEEN IS_NULL IS_NOT_NULL (valeurs ISO 8601
     validées) ; texte → EQ NEQ CONTAINS STARTS IN NOT_IN IS_NULL IS_NOT_NULL
     (CONTAINS → LIKE '%v%', STARTS → LIKE 'v%', avec échappement des jokers % et _
     dans la valeur). Colonne absente de metadata ou opération incompatible →
     GraphQLError BAD_USER_INPUT nommant la colonne, son type et les opérations
     permises.
   - Formes de value : scalaire pour les comparaisons ; tableau non vide pour
     IN/NOT_IN ; { min, max } pour BETWEEN ; absent pour IS_NULL/IS_NOT_NULL. Toute
     autre combinaison est rejetée — pas d'équivalent du placeholder « ? » de
     dégradation du frontend : un critère incomplet est une erreur.
   - Structure : nœud avec criterion ET children (ou ni l'un ni l'autre) rejeté ;
     groupe sans enfant rejeté ; parenthésage des sous-groupes comme dans le
     treeToSQL du frontend (la racine n'est pas parenthésée).
   - Bornes anti-abus dans config/security.yaml : FILTER_TREE.MAX_DEPTH (défaut 5)
     et FILTER_TREE.MAX_CRITERIA (défaut 50), dépassement → BAD_USER_INPUT.

3) Propagation : buildWhereClause (src/utils/utils.ts) est remplacé par le couple
   treeToSQL + assemblage WHERE ; les loaders fact.ts (loadFacts, getCount) et
   aggregated-facts.ts passent désormais (query, params) à connection.all — vérifie
   que tous les chemins (count, formats metadata/json) transmettent bien params.
   Vérifie que la clef de cache des loaders (dérivée de l'objet params du
   DataLoader) couvre le nouvel arbre. Supprime buildWhereClause, l'input Filter et
   le type StructuredFilter avec leurs tests. Si d'autres call-sites utilisent
   encore buildWhereClause (cherche-les), adapte-les au même moteur.

4) Validation des identifiants restants : chaque élément de fields passe par
   validateIdentifier dans buildSelectClause (base-loader.ts:289-291). Audite les
   autres interpolations d'identifiants client : sort[].field (buildSortClause),
   groupBy et measure (aggregated-facts), joinFields (cross-database) — ajoute
   validateIdentifier là où il manque, sans doubler l'existant.

5) Tests (unitaires sur treeToSQL + intégration resolvers) : arbre plat AND ; mixte
   AND/OR avec sous-groupes (vérifier le parenthésage exact du SQL généré et les
   params dans l'ordre) ; BETWEEN numérique et date ISO ; IN avec liste ; CONTAINS
   avec valeur contenant % et ' ; opération incompatible avec le type ; colonne
   inconnue ; critère incomplet ; groupe vide ; nœud criterion+children ;
   profondeur > MAX_DEPTH ; nombre de critères > MAX_CRITERIA ; fields/sort/groupBy
   malformés ("a; DROP TABLE") ; filtre sur une colonne de mesure (doit passer).
   Adapte tous les tests existants qui utilisaient filters ou la forme plate.

Propose ton plan avant d'implémenter (SDL définitif, signature exacte de treeToSQL,
liste des call-sites à basculer vers le SQL paramétré). Conventions : commentaires
français nominaux, docstrings anglaises Google. Termine par npm run lint,
npm run type:check, npm run test:setup puis npm test, et résume les fichiers
touchés. Commit conventionnel feat!: (rupture du contrat de filtre).
```

_Pourquoi Opus + plan mode : conception d'un contrat public récursif, moteur de
conversion porteur de la sécurité SQL de toute l'API, bascule vers le SQL paramétré
dans plusieurs loaders — le plan verrouille le SDL et la liste des call-sites avant
d'écrire._

---

## Prompt 2 — Branchement effectif de la sécurité (rate limiting, complexité)

**Modèle : Opus · Plan mode : OUI · Dépendances : aucune (parallèle au prompt 1)**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-api.md (section 2).
Constat à vérifier puis corriger : le rate limiter par IP
(src/security/rate-limiter.ts), l'analyseur de complexité
(src/security/complexity-analyzer.ts) et la sanitization
(src/security/input-sanitizer.ts) ne sont invoqués que par
SecurityManager.createSecurityMiddleware (src/security/manager.ts:119-180), qui n'est
appliqué nulle part — le schéma est construit par makeExecutableSchema sans
middleware (src/schema/index.ts). Seuls le depth-limit, le pattern-validator et le
blocage des mutations sont actifs (plugin Apollo dans src/server.ts:286-351 et
validationRules:377-397). L'API publique tourne donc sans rate limiting effectif.

Objectif : rendre la protection effective, au bon niveau de la pile, sans créer de
double emploi.

1) Rate limiting : branche-le au niveau Express (middleware app.use sur /graphql,
   AVANT expressMiddleware), pas au niveau des resolvers — un rejet doit coûter le
   moins possible. Réutilise la classe existante (fenêtre + burst, clé IP/user-agent,
   TRUSTED_PROXIES) plutôt que d'introduire une dépendance externe. Réponse 429 avec
   Retry-After et corps JSON {error, retryAfterMs}. Le middleware doit être
   réutilisable tel quel par le futur endpoint /api/export (exporte une factory).

2) Analyse de complexité : branche-la dans le plugin Apollo existant
   (didResolveOperation, à côté de securityManager.validateRequest) pour rejeter
   avant exécution les requêtes dépassant MAX_ALLOWED, avec les scores custom de
   config/security.yaml. Si tu constates que l'implémentation existante n'est pas
   utilisable telle quelle dans ce hook, propose dans ton plan l'alternative la plus
   simple (par exemple la règle de validation graphql-query-complexity) — pas de
   réécriture ambitieuse.

3) Sanitization XSS/SQL : tranche dans ton plan ce qui a encore un objet une fois le
   prompt 1 appliqué (les valeurs de filtre passent en SQL paramétré via treeToSQL,
   les identifiants sont validés, les patterns interdits déjà actifs). Recommandation par
   défaut : ne PAS brancher la sanitization sur le chemin GraphQL (double emploi,
   risque de corrompre des valeurs légitimes contenant des quotes) et documenter ce
   choix dans le code de SecurityManager ; supprime createSecurityMiddleware s'il
   devient du code mort, avec ses tests.

4) Ajoute des tests d'intégration : dépassement de fenêtre → 429 puis récupération ;
   burst ; requête trop complexe rejetée avec message explicite ; vérifie aussi que
   /health et /ready ne sont PAS rate-limités.

Propose ton plan (points de branchement exacts, ce qui est supprimé) avant
d'implémenter. Conventions : commentaires français nominaux, docstrings anglaises
Google. Termine par npm run lint, npm run type:check, npm run test:setup, npm test.
```

_Pourquoi Opus + plan mode : câblage de sécurité transversal, choix du niveau de la
pile et décision de suppression de code — le coût d'une erreur est élevé._

---

## Prompt 3 — Adaptation au schéma v2 : type Metadata, DatasetInfo, données de test

**Modèle : Opus · Plan mode : OUI · Dépendances : prompts 1-2 ; base v2 disponible**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-bdd.md (section 8) et
refonte_dashboard_template_api/revue-technique-api.md (sections 4 et 5.1). La base
DuckLake passe au schéma v2 : table metadata enrichie (plus de python_type ; nouvelles
colonnes parent_name, unit, display_format, family, description,
default_aggregation), nouvelle table dataset_metadata (label, description, source,
updated_at, schema_version=2), labels directement dans la fact_table, tables dim_*
uniquement opt-in (label_maps et hiérarchies de valeurs). Cette étape adapte les
métadonnées de l'API ; les select-options et le cross-database sont traités dans les
prompts 4 et 5. C'est une release majeure : les renommages cassants sont non
seulement permis mais souhaités.

1) Type Metadata v2 en camelCase (fenêtre unique pour corriger la convention de
   nommage, src/schema/typedefs/metadata.ts) :
     type Metadata {
       name: String!
       label: String
       sqlType: String
       isCategorical: Boolean
       isPrimaryKey: Boolean
       parentName: String
       unit: String
       displayFormat: String
       family: String
       description: String
       defaultAggregation: String
     }
   python_type disparaît. Le mapping snake_case (colonnes DB) → camelCase (GraphQL)
   se fait en un seul endroit, dans le loader de métadonnées (src/loaders/metadata.ts
   et src/loaders/catalog.ts, catalogMetadata) — pas dans chaque resolver. Adapte
   tous les usages internes (dimension-enrichment.ts lit is_primary_key, les
   resolvers getFields/getCatalogSchema, field-resolvers.ts lit is_categorical...).

2) Métadonnées de jeu de données : nouveau type GraphQL DatasetInfo { label: String,
   description: String, source: String, updatedAt: String, schemaVersion: Int! }.
   ATTENTION : le nom DatasetMetadata est déjà pris par les métadonnées de pagination
   (src/schema/typedefs/fact.ts:67) — ne pas le réutiliser. Expose DatasetInfo :
   - en champ lazy `info: DatasetInfo` sur CatalogSchemaInfo (même mécanique de
     résolution à la demande que fields/dimensionNames dans
     src/schema/resolvers/catalog.ts) ;
   - en query directe getDatasetInfo(catalog: String, schema: String): DatasetInfo.
   Nouveau loader datasetInfo (SELECT sur dataset_metadata, cache Redis même TTL que
   catalogMetadata).

3) getFields : ajoute un argument family: String (filtre d'égalité, même logique en
   mémoire que les filtres existants dans src/schema/resolvers/catalog.ts:204-229).

4) Garde de version : si la table dataset_metadata est absente ou schema_version < 2,
   les queries de métadonnées lèvent une GraphQLError explicite ("catalogue au format
   v1 — exécuter la migration", extensions.code = 'SCHEMA_VERSION_MISMATCH') et un
   warning est loggé à l'attach du catalogue. Pas de chemin de compatibilité v1 : la
   décision (revue-technique-api.md §5.1) est une API v2-only.

5) Données de test : réécris tests/setup/setup-test-data.ts pour produire des
   catalogues v2 : labels directs dans la fact_table (plus de codes), metadata avec
   les colonnes v2 renseignées de façon réaliste (au moins une colonne avec unit +
   displayFormat + family, une hiérarchie de colonnes via parent_name du type
   region→departement, une colonne date, une mesure numérique), dataset_metadata
   remplie, PLUS deux tables opt-in pour les prompts suivants : une dim_<col> de
   label_map (value ≠ label, ex. codes pays) et une dim_<col> hiérarchique
   (value, label, parent_value, path, depth) sur une colonne taxonomie. Mets à jour
   tous les tests cassés par le renommage camelCase et la disparition de
   python_type ; les tests des mécanismes v1 supprimés sont retirés.

Propose ton plan avant d'implémenter (liste des fichiers touchés par le renommage,
forme exacte du setup de test). Conventions : commentaires français nominaux,
docstrings anglaises Google. Termine par npm run lint, npm run type:check,
npm run test:setup, npm test, et un résumé par module. Commit conventionnel feat!:
(breaking change).
```

_Pourquoi Opus + plan mode : renommage transversal + nouveau contrat public + refonte
des données de test dont dépendent tous les prompts suivants._

---

## Prompt 4 — Select-options v2 : DISTINCT, group-options corrélées, hiérarchies

**Modèle : Opus · Plan mode : OUI · Dépendances : prompt 3**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-bdd.md (sections 4 et 8)
et refonte_dashboard_template_api/revue-technique-api.md (sections 4 et 5.1).
Objectif : adapter les select-options au schéma v2 (labels dans la fact_table, dims
uniquement opt-in) et corriger getGroupedSelectOptions qui, aujourd'hui, charge deux
listes indépendantes SANS les corréler (src/schema/resolvers/select-options.ts:95-103).

1) SelectOptionsLoader (src/loaders/select-options.ts) : supprime le routage
   is_categorical → dim. Chemin unique : SELECT DISTINCT <field> FROM fact_table
   [WHERE recherche] ORDER BY <field> LIMIT ?. label = value, SAUF si une table
   dim_<field> existe (label_map opt-in déclarée au build) : alors LEFT JOIN pour
   récupérer le label (les valeurs absentes de la dim gardent value comme label).
   L'existence de dim_<field> se vérifie via information_schema (ou
   duckdb_tables()), résultat mis en cache avec le même TTL que les options. Le
   searchTerm s'applique au label ET à la value (LOWER LIKE). Supprime le
   catch { return []; } : les erreurs remontent en GraphQLError (un champ inexistant
   doit se voir, pas retourner une liste vide).

2) getGroupedSelectOptions v2 — rupture assumée de la signature et du type de retour
   (src/schema/typedefs/select.ts) :
     getGroupedSelectOptions(
       optionsField: String!
       groupField: String        # optionnel : défaut = metadata.parentName de optionsField
       limit: Int = 50           # nombre max d'options par groupe
       groupLimit: Int = 50      # nombre max de groupes
       searchTerm: String = ""   # filtre sur les options
       catalog: String
       schema: String
     ): [GroupedOptions!]!

     type GroupedOptions {
       group: SelectOption!
       options: [SelectOption!]!
     }
   Implémentation : un seul SELECT DISTINCT groupe, option FROM fact_table (labels
   via LEFT JOIN dims si déclarées pour l'un ou l'autre champ), regroupement en
   mémoire par groupe, tri par label de groupe puis label d'option. Si groupField est
   absent ET que metadata.parentName de optionsField est NULL, GraphQLError
   BAD_USER_INPUT explicite. C'est le format [{group, options}] attendu par
   l'interface.

3) Hiérarchies de valeurs (cas B — dim_<col> hiérarchique value/label/parent_value/
   path/depth) : deux nouvelles queries dans select.ts :
   - getSelectOptionsFlat(fieldName: String!, pathPrefix: String, limit: Int = 500,
     catalog: String, schema: String): [HierarchicalOption!]! avec
     type HierarchicalOption { value: String!, label: String!, parentValue: String,
     path: String!, depth: Int! }. Lecture directe de la dim hiérarchique, filtre
     WHERE path LIKE '<pathPrefix>%' si fourni, ORDER BY path. GraphQLError explicite
     si la table n'existe pas ou n'a pas les colonnes hiérarchiques.
   - getSelectOptionsTree(fieldName: String!, catalog: String, schema: String): JSON
     — reconstruit l'arbre imbriqué en TypeScript à partir de la liste plate
     ({value, label, children: [...]}), taille bornée par nature (options de menu).

4) Dépréciations douces (une version de préavis avant retrait) :
   - getDimensionTable : @deprecated ; si dim_<name> existe (label_map), la
     retourne ; sinon reconstruit l'identité value=label par SELECT DISTINCT.
   - Fact.dimensionDetails : @deprecated ; renvoie l'identité (label = value) sans
     aucune requête — adapte src/utils/dimension-enrichment.ts pour ne plus résoudre
     de labels (le découpage measures/coordonnées via metadata isPrimaryKey est
     conservé, c'est lui qui alimente Fact.measures).
   - AggregatedFact.keyLabel : @deprecated ; renvoie key (src/schema/resolvers/
     field-resolvers.ts:119-146 se réduit à cela).

5) Tests : options simples avec et sans label_map, searchTerm sur value et sur
   label, group-options corrélées (vérifier qu'une option n'apparaît que sous SON
   groupe), groupField dérivé de parentName, erreur si ni groupField ni parentName,
   flat + tree sur la dim hiérarchique du setup (pathPrefix, profondeur), erreurs
   explicites sur champ inexistant. Les données de test v2 du prompt 3 couvrent tous
   ces cas.

Propose ton plan avant d'implémenter (signatures définitives, stratégie de détection
des dims, points de suppression dans dimension-enrichment). Conventions :
commentaires français nominaux, docstrings anglaises Google. Termine par
npm run lint, npm run type:check, npm run test:setup, npm test.
```

_Pourquoi Opus + plan mode : refonte du contrat public des menus, choix de
signatures, correction fonctionnelle des group-options — le cœur de l'interface
data-driven._

---

## Prompt 5 — Simplification cross-database et enrichissement

**Modèle : Sonnet · Plan mode : non · Dépendances : prompts 3 et 4**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-bdd.md (section 8,
« Impacts API ») et refonte_dashboard_template_api/revue-technique-api.md
(section 5.1). Au schéma v2, la fact_table contient directement les labels : les
jointures cross-catalogue n'ont plus besoin de résoudre codes→labels via les tables
dim_*. Simplifie src/loaders/cross-database.ts en conservant les signatures GraphQL
et la sémantique de retour (delta, deltaPercent, pagination) :

1) compareFacts : supprime getCategoricalMap et la résolution par dim dans
   buildSideSelect — la jointure A↔B se fait directement sur les colonnes de
   joinFields (qui portent déjà les labels). Conserve les CAST éventuels pour
   aligner les types entre catalogues.

2) compareAggregatedFacts : les CTE agrègent directement GROUP BY <groupBy>, sans
   JOIN dim ; jointure finale sur la clé inchangée.

3) crossDatabaseSelectOptions : intersection par INTERSECT de
   SELECT DISTINCT CAST(<field> AS VARCHAR) sur chaque cible, plus aucun chemin dim.

4) Nettoyage : après les prompts 4 et 5, vérifie ce qui reste utilisé de
   src/loaders/dimension.ts (loader dimensionValue notamment) et de
   src/utils/dimension-enrichment.ts ; supprime le code mort avec ses tests
   (getDimensionTable déprécié garde son chemin de lecture des label_maps).
   getSharedDimensions : renomme sa logique interne si elle mentionne les dims
   inférées ; son contrat (champs communs à plusieurs cibles) se résout maintenant
   par l'intersection des metadata (name + sqlType compatibles).

5) Tests : compare deux catalogues v2 du setup de test (valeurs communes et
   disjointes, delta et deltaPercent, division par zéro sur valueA=0), intersection
   d'options, getSharedDimensions sur metadata. Supprime les tests des chemins dim.

Conventions : commentaires français nominaux, docstrings anglaises Google. Termine
par npm run lint, npm run type:check, npm run test:setup, npm test, et un résumé des
suppressions.
```

_Pourquoi Sonnet sans plan mode : suppression de code balisée par une spec précise,
signatures publiques inchangées._

---

## Prompt 6 — Statistiques de colonnes (min/max pour les menus de filtre)

**Modèle : Sonnet · Plan mode : non · Dépendances : prompt 3**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-api.md (section 4).
L'interface a besoin du min/max d'une colonne numérique ou date pour calibrer
sliders, datepickers et axes — aujourd'hui seul DatasetMetadata.extents existe et il
est calculé sur la page retournée uniquement (jamais les dates). Implémente des
statistiques de colonne à la demande :

1) Nouveau type et nouvelles entrées dans les typedefs :
     type FieldStats {
       "Min de la colonne (nombre ou date ISO), null si colonne vide"
       min: JSON
       max: JSON
       distinctCount: Int!
       nullCount: Int!
     }
   - Champ lazy `stats: FieldStats` sur le type Metadata : résolu par un field
     resolver seulement quand il est sélectionné. Le parent Metadata doit connaître
     son catalogue/schéma : attache _catalog/_schema aux objets Metadata dans les
     resolvers qui les produisent (getCatalogSchema, getMetaData, CatalogSchemaInfo.
     fields), champs internes non exposés dans le SDL.
   - Query getFieldStats(fieldName: String!, catalog: String, schema: String,
     structuredFilters: FilterNode): FieldStats — même arbre de filtres que les
     queries de faits (prompt 1) ; la variante filtrée sert à recalibrer les sliders
     après application des filtres courants.

2) Nouveau loader fieldStats (src/loaders/field-stats.ts) sur le modèle des loaders
   existants (BaseQueryLoader, cache Redis, clé incluant les filtres). Une seule
   requête : SELECT MIN(col), MAX(col), COUNT(DISTINCT col), COUNT(*) - COUNT(col)
   FROM fact_table [WHERE ...]. fieldName validé par validateIdentifier, filtres
   convertis par treeToSQL (prompt 1) en SQL paramétré. Sérialisation : dates/timestamps en ISO 8601,
   BIGINT en nombre ou chaîne selon la précision (même convention que le reste du
   code — vérifier comment pool.ts convertit les BigInt). TTL long type
   SELECT_OPTIONS_CACHE_TIMEOUT pour la variante non filtrée, TTL court type
   FACT_CACHE_TIMEOUT pour la variante filtrée. L'invalidation existante par préfixe
   catalog/schema doit couvrir ce nouveau cache (vérifier le pattern de clé dans
   src/cache/cache-invalidation.ts).

3) Optimisation optionnelle, seulement si triviale : DuckLake maintient des
   statistiques de colonnes dans son catalogue — si une fonction du type
   <alias>.table_column_stats est disponible dans la version installée ET fiable
   après DELETE, l'utiliser pour la variante non filtrée, sinon s'en tenir au
   MIN/MAX (rapide sur colonnaire). Documente le choix dans la docstring du loader.

4) Tests : stats d'une colonne numérique, d'une colonne date (format ISO), d'une
   colonne avec NULL (nullCount), variante filtrée (le min/max change), colonne
   inexistante → GraphQLError, mise en cache (deux appels = une requête SQL).

Conventions : commentaires français nominaux, docstrings anglaises Google. Termine
par npm run lint, npm run type:check, npm run test:setup, npm test.
```

_Pourquoi Sonnet sans plan mode : fonctionnalité additive bien délimitée, calquée sur
les patterns de loaders existants._

---

## Prompt 7 — Endpoint REST d'export Arrow / CSV / Parquet

**Modèle : Opus · Plan mode : OUI · Dépendances : prompts 1 et 2 (sécurité), 3**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-api.md (sections 2 et
5.2). Objectif : un endpoint REST d'export volumineux qui contourne la sérialisation
JSON de GraphQL (gain d'un ordre de grandeur attendu). AVANT d'écrire du code,
vérifie dans la documentation de la version installée de @duckdb/node-api (voir
package.json) les capacités réelles : lecture par chunks/streaming des résultats,
support Arrow éventuel, et la faisabilité de COPY (SELECT ...) TO '<fichier>'
(FORMAT PARQUET / CSV) depuis une connexion du pool — ton plan doit trancher
l'approche par format sur la base de cette vérification, pas de suppositions.

Spécification du comportement :

1) Route GET /api/export, déclarée dans un module dédié src/db/export-routes.ts (ou
   src/export/) monté dans server.ts comme catalog-routes. Paramètres query :
   - catalog, schema (défauts habituels), fields (liste séparée par virgules),
     filters (JSON URL-encodé d'un FilterNode — le même arbre que les queries
     GraphQL, converti par le treeToSQL du prompt 1, mêmes bornes MAX_DEPTH /
     MAX_CRITERIA), sort (ex. "col:asc,col2:desc"), format = arrow | csv | parquet
     (défaut arrow), limit (plafonné par la config).
   - Identifiants validés par validateIdentifier ; toute erreur de validation →
     400 JSON {error, detail}. Catalogue/schéma inconnu → 404.

2) Formats et en-têtes :
   - arrow  → Content-Type: application/vnd.apache.arrow.stream (IPC stream) ;
   - csv    → text/csv; charset=utf-8 (avec en-tête de colonnes) ;
   - parquet→ application/vnd.apache.parquet ;
   - Content-Disposition: attachment; filename="<catalog>_<schema>_<YYYY-MM-DD>.<ext>"
   - X-Row-Count si le comptage est disponible sans surcoût notable.
   Approches candidates à trancher au plan : parquet/csv via COPY TO fichier
   temporaire (répertoire tmp dédié, stream vers la réponse, suppression garantie
   en finally y compris sur abort client) ; arrow via lecture par chunks du
   résultat et écriture RecordBatch avec la bibliothèque apache-arrow (nouvelle
   dépendance acceptée), ou tout support natif plus direct découvert dans
   @duckdb/node-api.

3) Garde-fous propres (section EXPORT dans config/api.yaml) :
   - MAX_ROWS (défaut 5_000_000) appliqué par LIMIT dans la requête ;
   - MAX_CONCURRENT_PER_IP (défaut 2) : 429 au-delà, compteur décrémenté en finally ;
   - TIMEOUT_MS (défaut 120000) : interruption propre + fin de stream ;
   - rate limiter du prompt 2 appliqué à la route (factory réutilisée) ;
   - la connexion du pool est TOUJOURS rendue (finally), y compris sur abort client
     (req.on('close')).

4) Pas de cache Redis (flux volumineux) mais Cache-Control: no-store explicite.

5) Tests d'intégration sur le catalogue de test v2 : export csv relu et comparé
   (lignes + en-têtes), export parquet relu via DuckDB, export arrow relu via
   apache-arrow, filtres appliqués, fields projetés, limit plafonné, format inconnu
   → 400, dépassement de concurrence → 429. Ajoute la page de documentation
   correspondante dans docs-site (exemples curl + tailles indicatives) et référence
   l'endpoint dans le README.

Propose ton plan (choix technique par format, gestion des fichiers temporaires,
points de branchement des gardes) avant d'implémenter. Conventions : commentaires
français nominaux, docstrings anglaises Google. Termine par npm run lint,
npm run type:check, npm run test:setup, npm test.
```

_Pourquoi Opus + plan mode : streaming, gestion de ressources (connexions, fichiers
temporaires, aborts) et incertitude sur les capacités exactes de @duckdb/node-api —
le plan verrouille l'approche par format avant d'écrire._

---

## Prompt 8 — Versioning du schéma GraphQL (CI + artefacts de release)

**Modèle : Sonnet · Plan mode : non · Dépendances : prompts 3-4 (schéma stabilisé)**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-api.md (section 5.3).
Politique retenue : évolution continue du schéma GraphQL (pas de /v2 d'URL),
directives @deprecated avec préavis d'une version mineure minimum, SemVer du package
= version de l'API (breaking schéma → majeur via conventional commits feat!/fix!).
Outille cette politique :

1) Script npm "schema:diff" : compare le SDL courant (généré par npm run
   docs:schema, sortie docs-site/static/schema.graphql) au SDL de la dernière
   release (git show $(git describe --tags --abbrev=0):docs-site/static/schema.graphql)
   avec @graphql-inspector/core (dépendance dev). Sortie lisible : breaking /
   dangerous / non-breaking. Code de sortie non nul en présence de breaking changes.

2) Workflow GitHub Actions schema-check.yml (sur pull_request) : build, génération
   du SDL, schema:diff contre le SDL du dernier tag ; le job échoue sur breaking
   change SAUF si un commit de la PR porte le marqueur de rupture conventionnel
   (feat!: / BREAKING CHANGE) — auquel cas il poste/loggue le diff comme
   avertissement au lieu d'échouer. Réutilise les patterns des workflows existants
   (.github/workflows/test.yml et docs.yml) pour la matrice Node et le cache npm.

3) Publication du contrat : étends le workflow de release existant (release-please)
   pour attacher docs-site/static/schema.graphql (et schema.json) comme assets de la
   GitHub Release à chaque tag. Le CHANGELOG reste unique (release-please) : ajoute
   au CONTRIBUTING (ou crée docs-site/docs/api-versioning.md) la convention de
   commit pour les changements de schéma (feat(schema):, fix(schema):, feat!:) et la
   politique de dépréciation/retrait, avec un exemple.

4) Vérifie que le schéma courant compile et que le diff contre l'état pré-v2 liste
   bien les breaking changes attendus (python_type retiré, GroupedSelectOptions
   remplacé...) — colle ce diff dans ta réponse comme validation.

Conventions habituelles. Termine par npm run lint, npm run type:check, npm test, et
un essai local du script schema:diff.
```

_Pourquoi Sonnet sans plan mode : outillage standard entièrement spécifié
(graphql-inspector, workflows calqués sur l'existant)._

---

## Prompt 9 — Documentation : deux sites, codegen, dictionnaire des données, skill

**Modèle : Sonnet · Plan mode : OUI · Dépendances : prompts 3-8**

```text
Lis d'abord refonte_dashboard_template_api/revue-technique-api.md (section 5.4).
Objectif : séparer la documentation en deux sites statiques et combler les manques
identifiés. L'existant : un seul Docusaurus (docs-site/) avec trois sidebars
(docs, code-reference générée par TypeDoc, graphql-api générée par
@graphql-markdown/docusaurus) + graphql-voyager + SDL généré.

1) Split en deux sites — propose au plan l'option la moins coûteuse à maintenir
   entre (a) deux configs Docusaurus dans docs-site/ avec deux commandes de build et
   deux sorties, et (b) deux instances séparées (docs-site-code/, docs-site-api/) —
   puis implémente :
   - Site « boîte à outils » (réutilisable entre projets) : code-reference TypeDoc,
     guides d'architecture génériques, versioning/politique de dépréciation.
   - Site « API & données » (projet-spécifique) : référence GraphQL
     (graphql-markdown), voyager, page d'export REST (prompt 7), dictionnaire des
     données (point 2). Adapte le workflow .github/workflows/docs.yml pour builder
     et déployer les deux (deux chemins de publication sur GitHub Pages).

2) Dictionnaire des données auto-généré : script docs-site/scripts/
   generate-data-dictionary.mjs qui interroge l'API en cours d'exécution (ou, à
   défaut, la base de test) via les queries getCatalogs, getDatasetInfo et
   getCatalogSchema, et produit une page markdown par (catalogue, schéma) : titre et
   description du dataset (DatasetInfo), date de mise à jour, tableau des colonnes
   (name, label, sqlType, unit, displayFormat, family, description,
   defaultAggregation, isCategorical, parentName). Intégré au build du site
   « API & données » avec une variable d'environnement API_URL ; si l'API est
   injoignable, le build n'échoue pas mais loggue un avertissement et conserve les
   pages précédentes (même stratégie cleanOutputDir que la doc existante).

3) GraphQL Code Generator (Apollo Codegen est déprécié — utiliser @graphql-codegen) :
   - côté API : ajoute @graphql-codegen/cli + typescript + typescript-resolvers,
     config codegen.ts pointant sur le SDL généré, script npm "codegen". Utilise les
     types générés dans AU MOINS les resolvers de select-options et de metadata
     (démonstration du pattern, migration complète progressive) — les interfaces
     manuelles correspondantes sont supprimées.
   - côté clients : page de doc « Consommer l'API en TypeScript » montrant une
     config codegen cliente pointant sur le schema.graphql publié en release
     (prompt 8), avec un exemple de query typée.

4) Mise à jour de la skill C:\Users\bolli\.claude\skills\dashboard-api-client\
   SKILL.md : décris l'API v2 (Metadata camelCase et ses nouveaux champs, DatasetInfo,
   GroupedOptions [{group, options}], getSelectOptionsFlat/Tree, FieldStats/stats,
   endpoint /api/export avec exemples, dépréciations et politique de versioning).
   Retire la section transitoire « Database schema v2 (à venir côté API) » devenue
   réalité.

Propose ton plan (option de split retenue, arborescence cible des deux sites) avant
d'implémenter. Vérifie que les deux sites buildent (npm run docs:build adapté) et
que le script du dictionnaire tourne contre l'API de test. Conventions habituelles.
```

_Pourquoi Sonnet + plan mode : travail guidé mais avec un choix de structure
(split a/b) à valider avant d'engager l'arborescence._

---

## Ordre d'exécution et jalons

| #   | Prompt                                                            | Modèle | Plan mode | Après          |
| --- | ----------------------------------------------------------------- | ------ | --------- | -------------- |
| 1   | Filtres en arbre (FilterNode + treeToSQL, suppression de filters) | Opus   | oui       | —              |
| 2   | Branchement sécurité (rate limit, complexité)                     | Opus   | oui       | —              |
| 3   | Schéma v2 : Metadata, DatasetInfo, tests                          | Opus   | oui       | 1, 2 + base v2 |
| 4   | Select-options v2 + hiérarchies                                   | Opus   | oui       | 3              |
| 5   | Cross-database simplifié                                          | Sonnet | non       | 3, 4           |
| 6   | Stats de colonnes (min/max)                                       | Sonnet | non       | 3              |
| 7   | Export REST Arrow/CSV/Parquet                                     | Opus   | oui       | 1, 2, 3        |
| 8   | Versioning du schéma (CI + artefacts)                             | Sonnet | non       | 3, 4           |
| 9   | Docs : deux sites, codegen, dictionnaire, skill                   | Sonnet | oui       | 3-8            |

Jalons entre prompts : `npm run lint` + `npm run type:check` + `npm run test:setup`

- `npm test` verts, puis **un commit conventionnel par prompt** (`fix:`/`feat:` ;
  `feat!:` aux prompts 1 et 3 qui portent les ruptures). La release majeure
  (release-please la déclenchera via les `feat!:`) ne se publie qu'une fois les
  prompts 1 à 8 terminés, pour que la rupture v2 sorte en une seule version avec son
  changelog complet et le SDL en artefact. Les prompts 1-2 (sécurité) peuvent être
  exécutés immédiatement, sans attendre la migration v2 de la base — le prompt 1 étant
  désormais breaking (suppression de `filters`, nouvelle forme de `structuredFilters`),
  son déploiement doit être coordonné avec la mise à jour du frontend
  (`MultiCriterionMenu` → `FilterNode` : mapping mécanique depuis `buildTree`,
  `connectorBefore` → `connector`, sans `depth`/`group`/`sql_type`/`is_categorical`).
