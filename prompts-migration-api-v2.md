# Prompts d'implémentation — adaptation de l'API à la base reformatée (schéma v1) et évolutions

> Série de prompts à exécuter **dans l'ordre**, chacun dans une session Claude Code
> fraîche, depuis la racine de ce dépôt (`dashboard-template-api`). Spécifications
> cibles :
>
> - `revue-technique-api.md` (racine de ce dépôt) — architecture de l'API, révisée en
>   septembre 2026 (voir son §0 pour les écarts avec la version de juillet) ;
> - `../dashboard-template-database/specification-bdd.md` — spécification de référence
>   de la base (§2 schéma, §3 types, §8 impacts API). Le dépôt est cloné à côté de
>   celui-ci ; à défaut : https://github.com/qbolliet/dt-ducklake-manager.
>
> Chaque prompt demande leur lecture — ne pas les supprimer avant la fin de la série.
> Le nom de ce fichier (`-v2`) est historique : la base parle de **schéma v1**
> (`schema_version = 1`) et la refonte de l'API sortira en **0.3.0** (1.0.0 plus tard).
>
> **Prérequis global** : la refonte du package Python (`dt_ducklake_manager`, prompts
> 1 à 10 de `prompts-refonte-schema.md`) est terminée (release 0.3.x), et la skill
> `dashboard-api-client` contient la section « Database schema (target for the API) ».
> Les prompts 1 et 2 ne dépendent pas de la base et peuvent être exécutés tout de suite.
>
> **Étape 0 (faite le 2026-09-19)** : `.release-please-config.json` porte
> `"bump-minor-pre-major": true`, pour que les `feat!:` de la série produisent **0.3.0**
> et non 1.0.0. Ce réglage doit être sur `main` **avant** le merge du premier
> `feat!:` ; ne pas le retirer avant le passage volontaire à 1.0.0
> (`Release-As: 1.0.0`).
>
> **Conventions communes** (rappelées dans chaque prompt, en complément de CLAUDE.md) :
> TypeScript strict avec types explicites ; commentaires en FRANÇAIS (formulations
> nominales) ; docstrings JSDoc/TSDoc en ANGLAIS, convention Google, avec `@param` /
> `@returns` / `@throws` — c'est le style du code existant, l'imiter. Vérification en
> fin de prompt : `npm run lint`, `npm run type:check`, `npm run test:setup` puis
> `npm test` — corriger jusqu'au vert.
>
> **Pas de commit automatique** : Claude Code ne lance **jamais** `git add` / `git commit`
> (ni `push`) dans cette série — le travail reste dans l'arbre de travail pour être
> relu avant d'être commité. En fin de prompt, il **propose** un message de commit
> conventionnel (type imposé par le prompt, voir le tableau des jalons) dans son résumé,
> sous forme d'un bloc de code prêt à copier. Le commit est fait à la main après relecture,
> **avant de lancer le prompt suivant** : cela garde un diff propre par prompt (`git diff`
> ne montre que le travail à relire) et un historique conventionnel exploitable par
> release-please.
>
> **Pas de dépréciation dans cette série** : le projet n'est pas publié (spec bdd §8),
> tout ce qui disparaît est retiré directement. La politique `@deprecated` s'applique
> à partir de 0.3.0 (prompt 9).
>
> **Choix du modèle** : Opus pour les prompts qui exigent des décisions d'architecture,
> touchent des invariants de sécurité ou beaucoup de fichiers interdépendants
> (1, 2, 3, 4, 5, 8) ; Sonnet pour les tâches mécaniques bien spécifiées (6, 7, 9, 10).
> **Plan mode** : activé quand des choix d'implémentation doivent être validés avant
> d'écrire ; inutile quand la spécification ci-dessous est déjà un plan.

---

## Prompt 1 — Filtres en arbre : suppression de `filters`, `structuredFilters` → `FilterNode` + `treeToSQL`

**Modèle : Opus · Plan mode : OUI · Dépendances : aucune**

```text
Lis d'abord revue-technique-api.md (sections 2 et 5.5 — le contrat GraphQL cible et
les règles du treeToSQL y sont spécifiés). L'API est publique : l'argument filters
(String) est un prédicat SQL brut injecté tel quel dans le WHERE
(src/utils/utils.ts:48-49), l'operator des structuredFilters n'est pas contrôlé, et
l'argument fields est concaténé dans le SELECT sans validation
(src/loaders/base-loader.ts:289-291). Objectif : supprimer filters, remplacer la
liste plate [Filter] par un arbre de critères aligné sur le MultiCriterionMenu du
frontend (fonction buildTree de son filterEngine.js, dépôt voisin
../dashboard-template-frontend/src/features/filter/), et convertir cet arbre en SQL
par une fonction treeToSQL durcie côté serveur. Rupture assumée du contrat (projet
non publié, release 0.3.0 à venir) : pas de période de dépréciation.

1) Typedefs (src/schema/typedefs/common.ts) : remplace input Filter par le contrat
   de la revue §5.5 — enum FilterConnector { AND OR }, enum FilterOperation
   { EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN BEFORE AFTER CONTAINS STARTS IS_NULL
   IS_NOT_NULL }, input FilterCriterion { variable: String!, operation:
   FilterOperation!, value: JSON }, input FilterNode { connector: FilterConnector,
   criterion: FilterCriterion, children: [FilterNode!] } avec la règle « exactement
   un des deux champs criterion/children » documentée dans les descriptions SDL.
   Sur getFactTable, getFactTableWithMetadata, getAggregatedFacts,
   getAggregatedFactsWithMetadata et les queries compare* qui acceptent des filtres :
   supprime l'argument filters et change structuredFilters en FilterNode (racine =
   groupe). Le connector d'un nœud est le connecteur avec le nœud PRÉCÉDENT de son
   groupe (null/ignoré pour le premier) — même sémantique que connectorBefore dans le
   frontend.

2) Nouveau module src/utils/filter-tree.ts : treeToSQL(node, metadataByName) ->
   { sql: string, params: unknown[] }. Règles impératives (revue §5.5) :
   - SQL paramétré : les valeurs deviennent des placeholders ? et partent dans
     params ; SEULS les identifiants, validés par validateIdentifier, et les
     mots-clés SQL issus du mapping interne des FilterOperation sont interpolés.
   - Typage par le serveur, jamais par le client : metadataByName vient de la table
     metadata (loader existant, colonne sql_type). Écris une fonction pure
     sqlTypeFamily(sqlType) -> 'numeric' | 'date' | 'text' | 'boolean', exportée
     (elle sera réutilisée par la sérialisation et les stats), couvrant TOUS les
     types produits par la base (spec bdd §3) :
       numeric : TINYINT SMALLINT INTEGER BIGINT HUGEINT UTINYINT USMALLINT UINTEGER
                 UBIGINT FLOAT DOUBLE DECIMAL(p,s)
       date    : DATE TIMESTAMP (et variantes TIMESTAMP WITH TIME ZONE, TIMESTAMP_S…)
       text    : VARCHAR
       boolean : BOOLEAN
     Type non reconnu → erreur explicite (pas de famille par défaut).
     Opérations permises : numeric → EQ NEQ GT GTE LT LTE BETWEEN IN NOT_IN IS_NULL
     IS_NOT_NULL ; date → EQ NEQ BEFORE AFTER BETWEEN IS_NULL IS_NOT_NULL (valeurs ISO
     8601 validées) ; text → EQ NEQ CONTAINS STARTS IN NOT_IN IS_NULL IS_NOT_NULL
     (CONTAINS → LIKE '%v%' ESCAPE, STARTS → LIKE 'v%' ESCAPE, jokers % et _ échappés
     dans la valeur) ; boolean → EQ NEQ IS_NULL IS_NOT_NULL (valeur JSON booléenne).
     Colonne absente de metadata ou opération incompatible → GraphQLError
     BAD_USER_INPUT nommant la colonne, son type et les opérations permises.
   - Binding : vérifie par test que bindParam (src/db/pool.ts) lie correctement un
     entier > 2^31 et une comparaison sur une colonne UBIGINT ; au besoin, émets
     CAST(? AS <sql_type>) côté SQL (sql_type relu de metadata, donc sûr).
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
   treeToSQL + assemblage WHERE ; les loaders fact.ts (loadFacts, getCount),
   aggregated-facts.ts et cross-database.ts passent désormais (query, params) à
   connection.all — vérifie que tous les chemins (count, formats metadata/json)
   transmettent bien params. Vérifie que la clef de cache des loaders (dérivée de
   l'objet params du DataLoader) couvre le nouvel arbre (sérialisation stable).
   Supprime buildWhereClause, l'input Filter et le type StructuredFilter avec leurs
   tests. Cherche les autres call-sites éventuels et adapte-les au même moteur.

4) Validation des identifiants restants : chaque élément de fields passe par
   validateIdentifier dans buildSelectClause (base-loader.ts:289-291). Audite les
   autres interpolations d'identifiants client : sort[].field (buildSortClause),
   groupBy et measure (aggregated-facts), joinFields (cross-database) — ajoute
   validateIdentifier là où il manque, sans doubler l'existant.

5) Tests (unitaires sur treeToSQL + intégration resolvers) : arbre plat AND ; mixte
   AND/OR avec sous-groupes (vérifier le parenthésage exact du SQL généré et les
   params dans l'ordre) ; BETWEEN numérique et date ISO ; IN avec liste ; CONTAINS
   avec valeur contenant % et ' ; booléen ; opération incompatible avec le type ;
   type SQL inconnu ; colonne inconnue ; critère incomplet ; groupe vide ; nœud
   criterion+children ; profondeur > MAX_DEPTH ; nombre de critères > MAX_CRITERIA ;
   fields/sort/groupBy malformés ("a; DROP TABLE") ; filtre sur une colonne de
   mesure (doit passer) ; table de vérité de sqlTypeFamily.
   Adapte tous les tests existants qui utilisaient filters ou la forme plate.

Propose ton plan avant d'implémenter (SDL définitif, signature exacte de treeToSQL,
liste des call-sites à basculer vers le SQL paramétré). Conventions : commentaires
français nominaux, docstrings anglaises Google. Termine par npm run lint,
npm run type:check, npm run test:setup puis npm test, et résume les fichiers
touchés. Ne commite pas (je relis avant) : termine ton résumé par un message de
commit conventionnel proposé, de type feat!: (rupture du contrat de filtre).
```

_Pourquoi Opus + plan mode : conception d'un contrat public récursif, moteur de
conversion porteur de la sécurité SQL de toute l'API, bascule vers le SQL paramétré
dans plusieurs loaders — le plan verrouille le SDL et la liste des call-sites avant
d'écrire._

---

## Prompt 2 — Branchement effectif de la sécurité (rate limiting, complexité)

**Modèle : Opus · Plan mode : OUI · Dépendances : aucune (parallèle au prompt 1)**

```text
Lis d'abord revue-technique-api.md (section 2). Constat à vérifier puis corriger : le
rate limiter par IP (src/security/rate-limiter.ts), l'analyseur de complexité
(src/security/complexity-analyzer.ts) et la sanitization
(src/security/input-sanitizer.ts) ne sont invoqués que par
SecurityManager.createSecurityMiddleware (src/security/manager.ts:119-180), qui n'est
appliqué nulle part — le schéma est construit par makeExecutableSchema sans
middleware (src/schema/index.ts). Seuls le depth-limit, le pattern-validator et le
blocage des mutations sont actifs (plugin Apollo et validationRules dans
src/server.ts). L'API publique tourne donc sans rate limiting effectif.

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
   réécriture ambitieuse. Les scores devront être complétés par les prompts suivants
   pour les nouvelles queries (getSelectOptionsTree, getFieldStats, Metadata.stats) :
   rends l'ajout d'un score trivial (une entrée de config).

3) Sanitization XSS/SQL : tranche dans ton plan ce qui a encore un objet une fois le
   prompt 1 appliqué (les valeurs de filtre passent en SQL paramétré via treeToSQL,
   les identifiants sont validés, les patterns interdits déjà actifs). Recommandation
   par défaut : ne PAS brancher la sanitization sur le chemin GraphQL (double emploi,
   risque de corrompre des valeurs légitimes — les libellés stockés dans la base
   contiennent des apostrophes, ex. « Côte-d'Or ») et documenter ce choix dans le code
   de SecurityManager ; supprime createSecurityMiddleware s'il devient du code mort,
   avec ses tests.

4) Ajoute des tests d'intégration : dépassement de fenêtre → 429 puis récupération ;
   burst ; requête trop complexe rejetée avec message explicite ; vérifie aussi que
   /health et /ready ne sont PAS rate-limités.

Propose ton plan (points de branchement exacts, ce qui est supprimé) avant
d'implémenter. Conventions : commentaires français nominaux, docstrings anglaises
Google. Termine par npm run lint, npm run type:check, npm run test:setup, npm test.
Ne commite pas (je relis avant) : termine ton résumé par un message de commit
conventionnel proposé, de type fix(security):.
```

_Pourquoi Opus + plan mode : câblage de sécurité transversal, choix du niveau de la
pile et décision de suppression de code — le coût d'une erreur est élevé._

---

## Prompt 3 — Bascule sur la base v1 : données de test et suppression de la couche dimension

**Modèle : Opus · Plan mode : OUI · Dépendances : prompts 1-2**

```text
Lis d'abord ../dashboard-template-database/specification-bdd.md (sections 1, 2, 3 et
8 ; dépôt https://github.com/qbolliet/dt-ducklake-manager si le clone voisin est
absent) puis revue-technique-api.md (sections 0 et 5.1). La base a été reformatée :
chaque schéma DuckLake contient exactement trois tables (fact_table, metadata,
dataset_metadata), la fact_table stocke directement les LIBELLÉS des catégorielles,
et il n'existe AUCUNE table dim_* (ni label_map, ni hiérarchie de valeurs). Ce prompt
bascule l'API et ses données de test sur ce format en supprimant toute la couche
dimension ; l'enrichissement du contrat de métadonnées (camelCase, DatasetInfo…) est
l'objet du prompt 4. Projet non publié : suppressions directes, pas de @deprecated.

1) Données de test (tests/setup/setup-test-data.ts), réécrites pour reproduire
   EXACTEMENT le DDL de la spec bdd §2 :
   - metadata(name VARCHAR NOT NULL, label VARCHAR NOT NULL, sql_type VARCHAR NOT
     NULL, is_primary_key BOOLEAN NOT NULL, is_categorical BOOLEAN NOT NULL,
     parent_name, unit, display_format, family, description, default_aggregation) —
     plus de python_type ;
   - dataset_metadata(label, description, source, updated_at TIMESTAMP,
     schema_version INTEGER = 1, cluster_by VARCHAR JSON) — une ligne par schéma ;
   - fact_table avec libellés directs et une palette de types représentative de la
     spec §3 : DATE, TIMESTAMP, VARCHAR catégoriel, BIGINT (dont une valeur
     > 2^53 dans une colonne de mesure dédiée), UBIGINT ou UINTEGER, FLOAT, DOUBLE,
     BOOLEAN, et des NULL dans au moins une mesure.
   - Hiérarchie de colonnes region → departement → commune déclarée par parent_name
     (les trois is_categorical = true), avec au moins un arbre IRRÉGULIER (commune
     NULL sous un département, convention spec bdd §2.5) et un libellé contenant une
     apostrophe.
   - metadata réaliste : au moins une mesure avec unit + display_format (d3-format) +
     family + description + default_aggregation, une autre avec
     default_aggregation = 'AVG'.
   - Données écrites ORDER BY cluster_by, comme le fait le writer.
   - Conserve la structure multi-catalogues / multi-schémas existante (plusieurs
     schémas dans un catalogue, second catalogue partageant des LIBELLÉS pour les
     tests compare*) ; supprime la mention « la jointure correcte passe par
     dim_country ».
   - Ajoute un test de contrat (tests/unit/…) qui vérifie que chaque schéma de test
     a exactement les trois tables et les colonnes de metadata/dataset_metadata de la
     spec — il cassera si le setup dérive de la base réelle.

2) Suppression de la couche dimension, partout :
   - getDimensionTable, type Dimension, typedefs/resolvers dimension.ts, loader
     src/loaders/dimension.ts et son enregistrement dans les loaders/DI ;
   - CatalogSchemaInfo.dimensionNames et la requête « WHERE is_categorical = true »
     qui l'alimente (src/loaders/catalog.ts) ;
   - AggregatedFact.keyLabel, ComparedFact.keyLabel et leur field resolver
     (src/schema/resolvers/field-resolvers.ts) ;
   - Fact.dimensionDetails et DimensionDetail. ATTENTION (revue §5.1) : aujourd'hui
     enrichFactsWithDimensions range dans dimensionDetails TOUTES les colonnes-clés
     (dates, identifiants numériques compris) — les supprimer sans remplacement ferait
     disparaître les coordonnées de getFactTable. Nouveau contrat :
       type FieldValue { name: String!, value: JSON }
       type Fact { keys: [FieldValue!]!, measures: [FieldValue!]! }
     (Measure est renommé FieldValue). La partition reste pilotée par
     metadata.is_primary_key, sans AUCUNE requête de label ; renomme
     src/utils/dimension-enrichment.ts en fact-partition.ts (ou équivalent) et
     simplifie-le en conséquence ;
   - SelectOptionsLoader (src/loaders/select-options.ts) : plus de routage
     is_categorical → dim_<field>. Chemin unique : SELECT DISTINCT <field> FROM
     fact_table WHERE <field> IS NOT NULL [AND recherche] ORDER BY <field> LIMIT ?,
     label = value, searchTerm en paramètre (LOWER(...) LIKE ? avec jokers
     échappés). Supprime le catch { return []; } : les erreurs remontent en
     GraphQLError (champ inexistant → BAD_USER_INPUT). getSelectOptions garde sa
     signature. getGroupedSelectOptions reste en place pour l'instant (remplacé au
     prompt 5) mais doit continuer de fonctionner sur le nouveau loader ;
   - src/loaders/cross-database.ts : compareFacts joint directement A↔B sur les
     colonnes de joinFields (qui portent les libellés) — supprime getCategoricalMap et
     la résolution par dim dans buildSideSelect, conserve les CAST d'alignement de
     types ; compareAggregatedFacts agrège GROUP BY <groupBy> sans JOIN dim ;
     crossDatabaseSelectOptions = INTERSECT de SELECT DISTINCT CAST(<field> AS
     VARCHAR) sur chaque cible ;
   - getSharedDimensions est RENOMMÉ getSharedFields (le concept de dimension
     n'existe plus) et se résout par intersection des metadata des cibles (même name,
     même famille de type via sqlTypeFamily du prompt 1) ; documente dans la
     description SDL que seules les colonnes catégorielles communes sont retournées
     si c'est le comportement actuel — vérifie-le et conserve-le ;
   - python_type retiré du type Metadata (le renommage camelCase complet est au
     prompt 4 : ici, seulement la suppression).
   Cherche ensuite tout reliquat (grep -ri "dim_\|dimension" src tests config docs-site/docs)
   et supprime le code mort avec ses tests ; nettoie les entrées de complexité et de
   cache (config/*.yaml, clés de cache) qui ne visent plus rien.

3) Tests : reprends les tests des resolvers de faits (Fact.keys contient bien les
   colonnes-clés, y compris la date), select-options (libellé avec apostrophe,
   searchTerm, NULL exclus, champ inexistant → erreur), compare* sur les libellés des
   deux catalogues de test (valeurs communes et disjointes, delta, deltaPercent,
   division par zéro sur valueA = 0), getSharedFields. Supprime les tests des chemins
   dim.

Propose ton plan avant d'implémenter (forme exacte du setup de test, liste des
fichiers supprimés/renommés, nouveau contrat Fact). Conventions : commentaires
français nominaux, docstrings anglaises Google. Termine par npm run lint,
npm run type:check, npm run test:setup, npm test, et un résumé des suppressions.
Ne commite pas (je relis avant) : termine ton résumé par un message de commit
conventionnel proposé, de type feat!: (breaking change).
```

_Pourquoi Opus + plan mode : bascule structurelle (données de test dont dépendent
tous les prompts suivants + suppression d'une couche entière), avec un piège de
contrat (`Fact.keys`) à verrouiller avant d'écrire._

---

## Prompt 4 — Contrat de métadonnées : `Metadata` camelCase, `DatasetInfo`, garde de version, tri par défaut

**Modèle : Opus · Plan mode : OUI · Dépendances : prompt 3**

```text
Lis d'abord ../dashboard-template-database/specification-bdd.md (sections 2 et 8) et
revue-technique-api.md (sections 0, 4, 5.1 et 5.7). La table metadata est le contrat
entre la base et l'interface ; ce prompt l'expose complètement, ajoute les
métadonnées de jeu de données et exploite cluster_by. Rupture assumée.

1) Type Metadata en camelCase (src/schema/typedefs/metadata.ts) ; les colonnes NOT
   NULL de la base sont non-nullables :
     type Metadata {
       name: String!
       label: String!
       sqlType: String!
       isCategorical: Boolean!
       isPrimaryKey: Boolean!
       parentName: String
       unit: String
       displayFormat: String
       family: String
       description: String
       defaultAggregation: Aggregation
     }
   (defaultAggregation typé par l'enum Aggregation existante, qui couvre déjà les
   sept valeurs de la base.) Le mapping snake_case (colonnes DB) → camelCase se fait
   en UN seul endroit, dans les loaders de métadonnées (src/loaders/metadata.ts et
   src/loaders/catalog.ts) : remplace les SELECT * par une liste de colonnes
   explicite. Adapte tous les usages internes (fact-partition, treeToSQL du prompt 1,
   resolvers getFields/getCatalogSchema, groupByFieldInfo…).

2) DatasetInfo (le nom DatasetMetadata est déjà pris par la pagination,
   src/schema/typedefs/fact.ts:67 — ne pas le réutiliser) :
     type DatasetInfo {
       label: String
       description: String
       source: String
       updatedAt: String!      # ISO 8601
       schemaVersion: Int!
       clusterBy: [String!]!   # dataset_metadata.cluster_by, JSON décodé
     }
   Exposé :
   - en champ lazy `info: DatasetInfo!` sur CatalogSchemaInfo (même mécanique de
     résolution à la demande que fields dans src/schema/resolvers/catalog.ts) ;
   - en query directe getDatasetInfo(catalog: String, schema: String): DatasetInfo!.
   Nouveau loader datasetInfo (SELECT sur dataset_metadata, cache Redis même TTL que
   catalogMetadata, clé couverte par l'invalidation par préfixe catalog/schema —
   vérifie dans src/cache/cache-invalidation.ts).

3) Garde de version : config SUPPORTED_SCHEMA_VERSIONS (défaut [1]). Si la table
   dataset_metadata est absente (catalogue à l'ancien format) ou si schema_version
   n'est pas supportée : warning explicite à l'attach/reload du catalogue
   (src/db/database-manager.ts), et toute query touchant ce schéma lève une
   GraphQLError extensions.code = 'SCHEMA_VERSION_UNSUPPORTED' nommant le catalogue,
   le schéma et la version trouvée. Vérification mise en cache (pas une requête par
   appel). Aucun chemin de compatibilité.

4) getFields : ajoute un argument family: String (filtre d'égalité, même logique en
   mémoire que les filtres existants de src/schema/resolvers/catalog.ts).

5) Agrégation par défaut : sur getAggregatedFacts et getAggregatedFactsWithMetadata,
   l'argument aggregation devient optionnel sans valeur par défaut SDL ; absent, il
   vaut metadata.defaultAggregation de la mesure, puis SUM. La valeur effectivement
   appliquée fait partie de la clé de cache.

6) Tri par défaut et pagination déterministe (revue §5.7) : sans sort explicite,
   getFactTable, getFactTableWithMetadata et compareFacts trient par
   dataset_metadata.cluster_by (identifiants validés) ; avec un sort explicite, les
   clés primaires sont ajoutées en départage (sans doublon). Les agrégats trient par
   la clé de groupe si aucun sort n'est fourni.

7) Tests : Metadata complet et camelCase (y compris champs NULL), getFields(family),
   DatasetInfo en lazy et en query directe (clusterBy décodé, updatedAt ISO), garde de
   version (dataset_metadata supprimée ou schema_version = 99 dans un schéma de test
   dédié → SCHEMA_VERSION_UNSUPPORTED), agrégation par défaut (mesure AVG vs mesure
   sans défaut), pagination : deux pages successives sans sort sont disjointes et
   leur union égale la requête non paginée.

Propose ton plan avant d'implémenter (liste des fichiers touchés par le renommage,
emplacement de la garde de version). Conventions : commentaires français nominaux,
docstrings anglaises Google. Termine par npm run lint, npm run type:check,
npm run test:setup, npm test, et un résumé par module. Ne commite pas (je relis
avant) : termine ton résumé par un message de commit conventionnel proposé, de type
feat!:.
```

_Pourquoi Opus + plan mode : renommage transversal + nouveau contrat public + garde
de version appliquée au bon niveau (attach vs resolvers)._

---

## Prompt 5 — `getSelectOptionsTree` remplace `getGroupedSelectOptions`

**Modèle : Opus · Plan mode : non · Dépendances : prompt 4**

```text
Lis d'abord ../dashboard-template-database/specification-bdd.md (sections 2.5 et 8)
et revue-technique-api.md (section 5.1, paragraphe getSelectOptionsTree — la
sémantique y est figée). Une hiérarchie est une chaîne de colonnes de la fact_table
déclarée par metadata.parent_name (profondeur quelconque, forêt garantie par le
writer) ; les niveaux absents sont NULL et terminent la branche. L'actuel
getGroupedSelectOptions charge deux listes indépendantes non corrélées
(src/schema/resolvers/select-options.ts:95-103) : il est SUPPRIMÉ (type
GroupedSelectOptions compris), sans dépréciation.

1) Nouvelle query dans src/schema/typedefs/select.ts :
     getSelectOptionsTree(
       fieldName: String!    # niveau le plus profond affiché
       maxDepth: Int         # niveaux conservés en remontant depuis fieldName ; défaut = toute la chaîne
       searchTerm: String    # filtre (insensible à la casse) sur le niveau fieldName
       catalog: String
       schema: String
     ): JSON!
   Retour : [{ value, label, children? }] (label = value ; children absent sur les
   feuilles). Documente dans la description SDL la forme exacte et l'exemple
   region → departement → commune : maxDepth: 2 sur commune rend
   [{departement, children: [communes]}] — le format group-options.

2) Implémentation (loader dédié ou méthode du SelectOptionsLoader, cache Redis TTL
   SELECT_OPTIONS_CACHE_TIMEOUT) :
   - chaîne de colonnes : remonte parentName depuis fieldName via les métadonnées
     (prompt 4), tronquée à maxDepth ; maxDepth < 1 → BAD_USER_INPUT ; colonne sans
     parentName → arbre à un niveau ; garde-fou anti-cycle (le writer garantit une
     forêt, mais ne pas boucler si la base est corrompue) ;
   - UNE requête : SELECT DISTINCT c1, …, cn FROM fact_table WHERE c1 IS NOT NULL
     [AND LOWER(cn) LIKE ? ESCAPE …] ORDER BY c1, …, cn — identifiants validés ;
   - construction de l'arbre en TypeScript : une branche s'arrête au premier NULL
     (spec bdd §2.5) ; aucun nœud à libellé vide fabriqué ; quand searchTerm est
     fourni, seules les branches menant à une feuille retenue sont gardées ;
   - borne dure SELECT_OPTIONS.TREE_MAX_NODES (config, défaut 5000) : dépassement →
     BAD_USER_INPUT invitant à utiliser searchTerm ou maxDepth (pas de troncature
     silencieuse) ;
   - score de complexité ajouté dans config/security.yaml (mécanisme du prompt 2).

3) Tests sur la hiérarchie du setup de test : arbre complet (profondeur 3), maxDepth
   2 (vérifier qu'une commune n'apparaît que sous SON département — c'était le bug de
   l'ancienne query), branche irrégulière (commune NULL → le département est une
   feuille, pas de nœud vide), searchTerm (ancêtres conservés, autres branches
   élaguées), colonne sans parent, maxDepth invalide, champ inexistant, dépassement
   de TREE_MAX_NODES (config réduite dans le test).

Conventions : commentaires français nominaux, docstrings anglaises Google. Termine
par npm run lint, npm run type:check, npm run test:setup, npm test. Ne commite pas
(je relis avant) : termine ton résumé par un message de commit conventionnel proposé,
de type feat!: (suppression de getGroupedSelectOptions).
```

_Pourquoi Opus sans plan mode : la sémantique est figée par la revue, mais la
construction d'arbre (NULL, recherche avec ancêtres, bornes) demande de la rigueur._

---

## Prompt 6 — Données prêtes pour graphiques et tableaux : métadonnées de colonnes, sérialisation, extents

**Modèle : Sonnet · Plan mode : non · Dépendances : prompt 4**

```text
Lis d'abord revue-technique-api.md (sections 0 et 5.6). Le frontend consomme
getFactTableWithMetadata (format OBJECTS/ARRAYS) pour ses composants <Chart> et
DataTable ; il doit pouvoir choisir type d'axe, libellé d'en-tête, unité et format
sans seconde requête ni échantillonnage des données. Ne change rien au format de data
ni aux arguments existants.

1) Métadonnées des colonnes retournées : ajoute au type DatasetWithMetadata un champ
   fields: [Metadata!]! aligné sur columns (mêmes noms, même ordre), rempli depuis les
   métadonnées déjà chargées (loader metadata, pas de requête supplémentaire hors
   cache). Colonne calculée sans ligne metadata (ne devrait pas arriver sur une
   fact_table) → erreur explicite plutôt qu'un trou silencieux. Sur
   AggregatedFactsMetadata, ajoute measureFieldInfo: Metadata à côté de
   groupByFieldInfo.

2) Sérialisation garantie des types, dans UN convertisseur unique appliqué à tous les
   chemins JSON (getAll/getAsJsonArray/getWithMetadata de src/db/pool.ts, donc
   OBJECTS, ARRAYS, getFactTable, agrégats, compare*) :
   - commence par un test qui constate ce que getRowObjectsJson()/getRowsJson()
     renvoient aujourd'hui pour BIGINT, UBIGINT, HUGEINT, DECIMAL, DATE, TIMESTAMP,
     FLOAT sur les données de test (le BIGINT > 2^53 du setup inclus) ;
   - règle cible : entier dont la valeur est dans Number.isSafeInteger → nombre JSON ;
     au-delà → chaîne décimale (documenté dans la description SDL du scalaire JSON et
     dans la doc) ; DECIMAL → nombre ; FLOAT/DOUBLE → nombre (NaN/Infinity → null) ;
     DATE → "YYYY-MM-DD" ; TIMESTAMP → ISO 8601 avec séparateur T
     ("YYYY-MM-DDTHH:mm:ss[.sss]", suffixe Z seulement pour les types avec fuseau) ;
     BOOLEAN → booléen ; NULL → null ;
   - appuie-toi sur les types de colonnes du résultat DuckDB (result.columnTypes() ou
     équivalent de la version installée de @duckdb/node-api — vérifie l'API exacte)
     et sur sqlTypeFamily du prompt 1, pas sur typeof des valeurs.

3) Extents de page (DatasetMetadata.extents) : couvrent désormais les colonnes
   numériques (y compris les entiers convertis au point 2) ET les colonnes
   date/timestamp (bornes en chaînes ISO, comparaison chronologique). Documente dans
   la description SDL que ce sont les bornes de la PAGE, et renvoie vers
   Metadata.stats (prompt 7) pour les bornes globales.

4) Tests : fields aligné sur columns (ordre, projection via fields), measureFieldInfo,
   chaque règle de sérialisation (dont BIGINT > 2^53 en chaîne et BIGINT ordinaire en
   nombre), extents numérique et date, NULL.

Conventions : commentaires français nominaux, docstrings anglaises Google. Termine
par npm run lint, npm run type:check, npm run test:setup, npm test. Ne commite pas
(je relis avant) : termine ton résumé par un message de commit conventionnel proposé,
de type feat: (ou feat!: si la sérialisation change la forme de valeurs déjà
renvoyées — ce sera le cas pour les BIGINT).
```

_Pourquoi Sonnet sans plan mode : ajouts bien délimités ; le seul inconnu (sortie
exacte de `getRowObjectsJson`) est levé par le test de constat demandé en premier._

---

## Prompt 7 — Statistiques de colonnes (min/max pour les menus de filtre)

**Modèle : Sonnet · Plan mode : non · Dépendances : prompts 1, 4 et 6**

```text
Lis d'abord revue-technique-api.md (sections 4 et 5.6). L'interface a besoin du
min/max d'une colonne numérique ou date pour calibrer sliders, datepickers et axes —
aujourd'hui seul DatasetMetadata.extents existe et il porte sur la page retournée.
Implémente des statistiques de colonne à la demande :

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
     fields, DatasetWithMetadata.fields…), champs internes non exposés dans le SDL.
   - Query getFieldStats(fieldName: String!, catalog: String, schema: String,
     structuredFilters: FilterNode): FieldStats! — même arbre de filtres que les
     queries de faits (prompt 1) ; la variante filtrée sert à recalibrer les sliders
     après application des filtres courants.
   - Scores de complexité dans config/security.yaml (stats sur N colonnes = N
     requêtes).

2) Nouveau loader fieldStats (src/loaders/field-stats.ts) sur le modèle des loaders
   existants (BaseQueryLoader, cache Redis, clé incluant les filtres). Une seule
   requête : SELECT MIN(col), MAX(col), COUNT(DISTINCT col), COUNT(*) - COUNT(col)
   FROM fact_table [WHERE ...]. fieldName validé par validateIdentifier, filtres
   convertis par treeToSQL en SQL paramétré, valeurs sérialisées par le convertisseur
   du prompt 6. Pour une colonne texte ou booléenne, min/max restent calculés
   (ordre lexical) — documente-le. TTL long type SELECT_OPTIONS_CACHE_TIMEOUT pour la
   variante non filtrée, TTL court type FACT_CACHE_TIMEOUT pour la variante filtrée.
   L'invalidation existante par préfixe catalog/schema doit couvrir ce nouveau cache
   (vérifier le pattern de clé dans src/cache/cache-invalidation.ts).

3) Pas de lecture des statistiques du catalogue DuckLake (ducklake_file_column_stats)
   : elles sont par fichier, n'incluent pas les lignes inlinées dans le catalogue et
   restent larges après DELETE (spec bdd §5.2-5.3) — documente ce choix dans la
   docstring du loader.

4) Tests : stats d'une colonne numérique, d'une colonne date (format ISO), d'une
   colonne avec NULL (nullCount), du BIGINT > 2^53 (chaîne), variante filtrée (le
   min/max change), colonne inexistante → GraphQLError, stats en lazy sur
   getCatalogSchema, mise en cache (deux appels = une requête SQL).

Conventions : commentaires français nominaux, docstrings anglaises Google. Termine
par npm run lint, npm run type:check, npm run test:setup, npm test. Ne commite pas
(je relis avant) : termine ton résumé par un message de commit conventionnel proposé,
de type feat:.
```

_Pourquoi Sonnet sans plan mode : fonctionnalité additive bien délimitée, calquée sur
les patterns de loaders existants._

---

## Prompt 8 — Endpoint REST d'export Arrow / CSV / Parquet

**Modèle : Opus · Plan mode : OUI · Dépendances : prompts 1, 2 et 4**

```text
Lis d'abord revue-technique-api.md (sections 2, 5.2 et 5.7). Objectif : un endpoint
REST d'export volumineux qui contourne la sérialisation JSON de GraphQL (gain d'un
ordre de grandeur attendu). AVANT d'écrire du code, vérifie dans la documentation de
la version installée de @duckdb/node-api (voir package.json) les capacités réelles :
lecture par chunks/streaming des résultats, support Arrow éventuel, et la
faisabilité de COPY (SELECT ...) TO '<fichier>' (FORMAT PARQUET / CSV) depuis une
connexion du pool alors que les catalogues DuckLake sont attachés en READ_ONLY
(l'écriture vise un fichier local, pas le catalogue — à confirmer par un essai) — ton
plan doit trancher l'approche par format sur la base de cette vérification, pas de
suppositions.

Spécification du comportement :

1) Route GET /api/export, déclarée dans un module dédié src/db/export-routes.ts (ou
   src/export/) monté dans server.ts comme catalog-routes. Paramètres query :
   - catalog, schema (défauts habituels), fields (liste séparée par virgules),
     filters (JSON URL-encodé d'un FilterNode — le même arbre que les queries
     GraphQL, converti par le treeToSQL du prompt 1, mêmes bornes MAX_DEPTH /
     MAX_CRITERIA), sort (ex. "col:asc,col2:desc" ; défaut : cluster_by du schéma,
     prompt 4), format = arrow | csv | parquet (défaut arrow), limit (plafonné par la
     config).
   - Identifiants validés par validateIdentifier ; toute erreur de validation →
     400 JSON {error, detail}. Catalogue/schéma inconnu → 404 ; schéma de version
     non supportée → 409 avec le message de la garde du prompt 4.

2) Formats et en-têtes :
   - arrow  → Content-Type: application/vnd.apache.arrow.stream (IPC stream) ;
   - csv    → text/csv; charset=utf-8 (avec en-tête de colonnes ; dates ISO) ;
   - parquet→ application/vnd.apache.parquet ;
   - Content-Disposition: attachment; filename="<catalog>_<schema>_<YYYY-MM-DD>.<ext>"
   - X-Row-Count si le comptage est disponible sans surcoût notable.
   Arrow et Parquet doivent préserver les types de la base (UBIGINT, TIMESTAMP,
   FLOAT…) : vérifie-le au test de relecture.
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

5) Tests d'intégration sur le catalogue de test : export csv relu et comparé
   (lignes + en-têtes), export parquet relu via DuckDB (types conservés), export arrow
   relu via apache-arrow, filtres appliqués, fields projetés, ordre par défaut =
   cluster_by, limit plafonné, format inconnu → 400, dépassement de concurrence → 429.
   Ajoute la page de documentation correspondante dans docs-site (exemples curl +
   tailles indicatives) et référence l'endpoint dans le README.

Propose ton plan (choix technique par format, gestion des fichiers temporaires,
points de branchement des gardes) avant d'implémenter. Conventions : commentaires
français nominaux, docstrings anglaises Google. Termine par npm run lint,
npm run type:check, npm run test:setup, npm test. Ne commite pas (je relis avant) :
termine ton résumé par un message de commit conventionnel proposé, de type feat:.
```

_Pourquoi Opus + plan mode : streaming, gestion de ressources (connexions, fichiers
temporaires, aborts) et incertitude sur les capacités exactes de @duckdb/node-api —
le plan verrouille l'approche par format avant d'écrire._

---

## Prompt 9 — Versioning du schéma GraphQL (SDL versionné, CI, artefacts de release)

**Modèle : Sonnet · Plan mode : non · Dépendances : prompts 3 à 7 (schéma stabilisé)**

```text
Lis d'abord revue-technique-api.md (section 5.3). Politique retenue : évolution
continue du schéma GraphQL (pas de /v2 d'URL), SemVer du package = version de l'API
(conventional commits ; tant que l'API est en 0.x, .release-please-config.json porte
"bump-minor-pre-major": true et une rupture feat!/fix! monte la MINEURE — la refonte
sort en 0.3.0 ; 1.0.0 viendra plus tard par un Release-As explicite), directives
@deprecated avec préavis d'une version mineure minimum À PARTIR de 0.3.0 (la refonte
en cours supprime sans préavis : projet non publié). Outille cette politique :

1) SDL versionné, DISTINCT du SDL de la documentation. Faits vérifiés (revue §5.3) :
   docs-site/static/schema.graphql et schema.json sont des artefacts du build de la
   doc — réécrits à chaque npm run docs:schema / docs:build et à chaque déploiement
   (.github/workflows/docs.yml), produits depuis dist/ (donc périmés si npm run build
   n'a pas tourné : npm run docs:build ne compile pas), et lus par
   @graphql-markdown/docusaurus (docs-site/docusaurus.config.ts) et voyager. Ils
   RESTENT dans .gitignore : ne les retire pas.
   - Nouveau script npm "schema:generate" : écrit un fichier SUIVI schema.graphql à
     la racine du dépôt, généré depuis src/ (les typedefs TypeScript, via tsx, déjà en
     devDependency — plus de dépendance à dist/). Sortie déterministe : même source →
     mêmes octets (printSchema, fin de ligne LF, pas d'horodatage ; ajoute
     schema.graphql au .gitattributes en eol=lf si nécessaire, le dépôt est
     développé sous Windows). Attention au piège documenté dans
     generate-schema.mjs : makeExecutableSchema et printSchema doivent partager la
     même instance de graphql (sinon « from another module or realm ») — vérifie-le.
   - docs:schema dérive ensuite ses artefacts ignorés du même code (copie du SDL
     racine + introspection) au lieu de relire dist/ ; adapte l'étape du workflow
     docs.yml si « npm run build » n'y est plus nécessaire pour cela (il peut l'être
     encore pour TypeDoc — vérifie).
   - Script npm "schema:check" : lance schema:generate puis échoue si
     git diff --exit-code -- schema.graphql n'est pas vide (message : « lancer npm run
     schema:generate et commiter »). Branche-le dans le CI (point 3) ; pas dans
     lint-staged si cela ralentit trop les commits — tranche et justifie.
   - Vérifie qu'un npm run docs:build complet ne modifie PAS schema.graphql racine
     quand le code n'a pas changé (git status propre après build) : c'est le critère
     d'acceptation de ce point.

2) Script npm "schema:diff" : compare schema.graphql au SDL de la dernière release
   (git show $(git describe --tags --abbrev=0):schema.graphql ; si le tag ne contient
   pas encore le fichier — cas de la première release —, sortie informative et code
   0) avec @graphql-inspector/core (dépendance dev). Sortie lisible : breaking /
   dangerous / non-breaking. Code de sortie non nul en présence de breaking changes.

3) Workflow GitHub Actions schema-check.yml (sur pull_request) : build, schema:check,
   schema:diff contre le SDL du dernier tag ; le job échoue sur breaking change SAUF
   si un commit de la PR porte le marqueur de rupture conventionnel (feat!: / fix!: /
   BREAKING CHANGE) — auquel cas il loggue le diff comme avertissement (et le poste en
   commentaire de PR si c'est simple avec les permissions existantes). Réutilise les
   patterns des workflows existants (.github/workflows/) pour la version de Node et
   le cache npm.

4) Publication du contrat : étends le workflow de release existant (release-please)
   pour attacher schema.graphql (et l'introspection schema.json) comme assets de la
   GitHub Release à chaque tag (schema.json produit à la volée dans le job, il n'est
   pas suivi). Le CHANGELOG reste unique (release-please). Vérifie que
   .release-please-config.json porte bien "bump-minor-pre-major": true et que la PR
   de release ouverte par release-please propose 0.3.0 (et non 1.0.0) ; signale tout
   écart dans ta réponse sans modifier la config.
   Crée docs-site/docs/api-versioning.md : convention de commit pour les
   changements de schéma (feat(schema):, fix(schema):, feat!:), numérotation en 0.x
   (rupture → mineure) puis passage à 1.0.0 par un commit portant le pied
   « Release-As: 1.0.0 », politique de dépréciation/retrait à partir de 0.3.0, avec un
   exemple.

5) Validation : colle dans ta réponse le diff entre le SDL de main avant la série
   (git show 21d6dce, regénéré dans un worktree temporaire si nécessaire) et le SDL
   courant — il doit lister les ruptures attendues (filters supprimé, Filter →
   FilterNode, python_type et dimensionDetails retirés, Metadata camelCase,
   getGroupedSelectOptions → getSelectOptionsTree, getSharedDimensions →
   getSharedFields, Measure → FieldValue…).

Conventions habituelles. Termine par npm run lint, npm run type:check, npm test, et
un essai local de schema:check et schema:diff. Ne commite pas (je relis avant) :
termine ton résumé par un message de commit conventionnel proposé, de type ci:.
```

_Pourquoi Sonnet sans plan mode : outillage standard entièrement spécifié
(graphql-inspector, workflows calqués sur l'existant)._

---

## Prompt 10 — Documentation : deux sites, codegen, dictionnaire des données, skill

**Modèle : Sonnet · Plan mode : OUI · Dépendances : prompts 3 à 9**

```text
Lis d'abord revue-technique-api.md (sections 5.4 et 5.6). Objectif : séparer la
documentation en deux sites statiques, combler les manques identifiés et remettre la
skill cliente en cohérence avec l'API refondue. L'existant : un seul Docusaurus
(docs-site/) avec trois sidebars (docs, code-reference générée par TypeDoc,
graphql-api générée par @graphql-markdown/docusaurus) + graphql-voyager + SDL généré.

1) Split en deux sites — propose au plan l'option la moins coûteuse à maintenir
   entre (a) deux configs Docusaurus dans docs-site/ avec deux commandes de build et
   deux sorties, et (b) deux instances séparées (docs-site-code/, docs-site-api/) —
   puis implémente :
   - Site « boîte à outils » (réutilisable entre projets) : code-reference TypeDoc,
     guides d'architecture génériques, versioning/politique de dépréciation.
   - Site « API & données » (projet-spécifique) : référence GraphQL
     (graphql-markdown), voyager, page d'export REST (prompt 8), dictionnaire des
     données (point 2). Adapte le workflow .github/workflows/docs.yml pour builder
     et déployer les deux (deux chemins de publication sur GitHub Pages).

2) Dictionnaire des données auto-généré : script docs-site/scripts/
   generate-data-dictionary.mjs qui interroge l'API en cours d'exécution (ou, à
   défaut, la base de test) via getCatalogs, getDatasetInfo et getCatalogSchema, et
   produit une page markdown par (catalogue, schéma) : titre et description du jeu de
   résultats (DatasetInfo), source, date de mise à jour, colonnes de tri
   (clusterBy), tableau des colonnes (name, label, sqlType, unit, displayFormat,
   family, description, defaultAggregation, isCategorical, isPrimaryKey) groupé par
   family, et les hiérarchies reconstruites depuis parentName (region → departement →
   commune). Intégré au build du site « API & données » avec une variable
   d'environnement API_URL ; si l'API est injoignable, le build n'échoue pas mais
   loggue un avertissement et conserve les pages précédentes (même stratégie
   cleanOutputDir que la doc existante).

3) GraphQL Code Generator (Apollo Codegen est déprécié — utiliser @graphql-codegen) :
   - côté API : ajoute @graphql-codegen/cli + typescript + typescript-resolvers,
     config codegen.ts pointant sur schema.graphql (prompt 9), script npm "codegen".
     Utilise les types générés dans AU MOINS les resolvers de select-options et de
     metadata (démonstration du pattern, migration complète progressive) — les
     interfaces manuelles correspondantes sont supprimées. Le scalaire JSON reçoit un
     vrai GraphQLScalarType (graphql-type-json ou équivalent) mappé dans la config.
   - côté clients : page de doc « Consommer l'API en TypeScript » montrant une
     config codegen cliente pointant sur le schema.graphql publié en release, avec un
     exemple de query typée et le typage du JSON de getSelectOptionsTree
     (SelectOptionNode { value, label, children? }).

4) Mise à jour de la skill C:\Users\bolli\.claude\skills\dashboard-api-client\
   SKILL.md : réécris la référence de l'API pour qu'elle décrive l'API refondue telle
   qu'implémentée (relis le SDL, ne te fie pas à la skill) : FilterNode et ses règles
   par famille de type ; Fact { keys, measures } avec FieldValue ; Metadata camelCase
   et ses champs d'UI ; DatasetInfo (et non « DatasetMetadata » comme l'écrit la
   section cible actuelle) ; CatalogSchemaInfo.info ; getSelectOptionsTree
   (argument fieldName, sémantique de maxDepth, recette de conversion en
   group-options [{group: {value, label}, options}] pour un SelectMenu) ;
   DatasetWithMetadata.fields ; règles de sérialisation (BIGINT en chaîne au-delà de
   2^53, dates ISO) ; FieldStats / stats / getFieldStats ; getSharedFields ;
   agrégation par défaut ; tri par défaut ; endpoint /api/export avec exemples ;
   limites de conception (profondeur 7, offset 10 000) ; politique de versioning.
   Supprime les éléments disparus (Filter, dimensionDetails, getDimensionTable,
   keyLabel, python_type, GroupedSelectOptions, dimensionNames) et la section
   transitoire « Database schema (target for the API) », dont le contenu utile est
   fondu dans la référence (garde un court paragraphe sur les trois tables et la
   convention NULL des hiérarchies).

Propose ton plan (option de split retenue, arborescence cible des deux sites) avant
d'implémenter. Vérifie que les deux sites buildent (npm run docs:build adapté) et
que le script du dictionnaire tourne contre l'API de test. Conventions habituelles.
Ne commite pas (je relis avant) : termine ton résumé par un message de commit
conventionnel proposé, de type docs:.
```

_Pourquoi Sonnet + plan mode : travail guidé mais avec un choix de structure
(split a/b) à valider avant d'engager l'arborescence._

---

## Ordre d'exécution et jalons

| #   | Prompt                                                                 | Modèle | Plan mode | Après   | Commit proposé |
| --- | ---------------------------------------------------------------------- | ------ | --------- | ------- | -------------- |
| 1   | Filtres en arbre (FilterNode + treeToSQL, suppression de filters)      | Opus   | oui       | —       | `feat!:`       |
| 2   | Branchement sécurité (rate limit, complexité)                          | Opus   | oui       | —       | `fix:`         |
| 3   | Bascule base v1 : données de test + suppression couche dimension       | Opus   | oui       | 1, 2    | `feat!:`       |
| 4   | Contrat de métadonnées (camelCase, DatasetInfo, garde, tri par défaut) | Opus   | oui       | 3       | `feat!:`       |
| 5   | getSelectOptionsTree remplace getGroupedSelectOptions                  | Opus   | non       | 4       | `feat!:`       |
| 6   | Graphiques/tableaux : fields, sérialisation, extents                   | Sonnet | non       | 4       | `feat!:`       |
| 7   | Stats de colonnes (min/max)                                            | Sonnet | non       | 1, 4, 6 | `feat:`        |
| 8   | Export REST Arrow/CSV/Parquet                                          | Opus   | oui       | 1, 2, 4 | `feat:`        |
| 9   | Versioning du schéma (SDL suivi, CI, artefacts)                        | Sonnet | non       | 3-7     | `ci:`          |
| 10  | Docs : deux sites, codegen, dictionnaire, skill                        | Sonnet | oui       | 3-9     | `docs:`        |

Jalons entre prompts : `npm run lint` + `npm run type:check` + `npm run test:setup`

- `npm test` verts, puis relecture du travail (laissé non commité par Claude Code) et
  **un commit conventionnel par prompt, fait à la main** à partir du message proposé
  dans le résumé de fin de prompt. La release (0.3.0,
  déclenchée par release-please via les `feat!:`) ne se publie qu'une fois les prompts
  1 à 9 terminés, pour que la rupture sorte en une seule version avec son changelog
  complet et le SDL en artefact. Les prompts 1-2 peuvent être exécutés immédiatement ;
  le prompt 1 étant breaking, son déploiement se coordonne avec le frontend (ci-dessous).

## Coordination avec le frontend (`dashboard-template-frontend`)

À planifier côté frontend, en une passe après le prompt 6 (ou au fil de l'eau sur une
branche) :

- **Filtres** : `MultiCriterionMenu` → `FilterNode` (mapping mécanique depuis
  `buildTree` : `connectorBefore` → `connector`, sans `depth`/`group`/`sql_type`/
  `is_categorical`).
- **Group-options** : le mode groupé du `SelectMenu` consomme
  `getSelectOptionsTree(fieldName, maxDepth: 2)` converti en
  `[{group: {value, label}, options: node.children}]` ; la fixture
  `MOCK_GROUPED_OPTIONS` garde sa forme (c'est la sortie du mapping). Clôt le point de
  `problèmes_additionnels_select_group_options.txt`.
- **Tableau** : `resolveLabels` n'existe pas (inutile, la base stocke les libellés) ;
  `factTableQuery.js` / `useFactTableWithMetadata.js` lisent
  `DatasetWithMetadata.fields` (`label` pour l'en-tête, `sqlType`/`unit`/
  `displayFormat` pour l'alignement et le format).
- **Graphiques** : `<Chart>` accepte une prop `fields` (depuis
  `DatasetWithMetadata.fields`) qui court-circuite `detectType` dans
  `typeDetection.js` (`sqlType` → famille `date | number | categorical`, même
  table que `sqlTypeFamily` côté API ; `isCategorical` prioritaire pour le
  catégoriel) ; `unit`/`displayFormat` alimentent axes et tooltips.
- **Métadonnées** : tous les accès `sql_type` / `is_categorical` / `is_primary_key`
  passent en camelCase ; `Fact.dimensionDetails` → `Fact.keys`.
- **Serveur de mock** : régénérer `scripts/schema.graphql` du frontend depuis le
  `schema.graphql` suivi de l'API (prompt 9), et non depuis
  `docs-site/static/schema.graphql` (ignoré et périmé).
