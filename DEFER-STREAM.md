# Chantier : livraison incrémentale `@defer` / `@stream`

> Statut : **à l'étude, bloqué côté Apollo Server** (voir [Prérequis bloquants](#prérequis-bloquants)).
> Rédigé le 2026-10-25, après le passage à graphql 17.0.2 (PR #68).

## En bref

`@defer` et `@stream` permettent de renvoyer **une première réponse tout de suite**, puis le
reste par morceaux dans la même réponse HTTP (`multipart/mixed`). Pour un dashboard, cela
veut dire afficher le tableau ou le graphique dès que les données sont prêtes. Les parties
coûteuses arrivent ensuite : statistiques de colonnes, nombre total de lignes, métadonnées
riches.

C'est un chantier **sur trois couches** (Apollo Server, cette API, le frontend), avec une
fonctionnalité encore **expérimentale** dans GraphQL.js 17.

Recommandation :

1. Faire d'abord un **spike de faisabilité** (prompt 1), limité dans le temps.
2. Ne lancer l'implémentation (prompts 2 et 3) que si le spike est concluant, ou quand
   Apollo Server supportera officiellement graphql 17.

## Ce que fournit GraphQL.js 17

- `experimentalExecuteIncrementally()` renvoie soit un `ExecutionResult` classique, soit
  `{ initialResult, subsequentResults }`.
  - `subsequentResults` est un itérable asynchrone de messages `pending`, `incremental` et
    `completed`, identifiés par un `id` (format actuel de la proposition de spec).
- `legacyExecuteIncrementally()` produit l'ancien format des alphas v17. C'est une passerelle
  de migration.
- `execute()` reste mono-résultat. Une opération contenant `@defer` y est exécutée en
  entier, comme si la directive n'était pas là.
- Les directives `@defer` et `@stream` (`GraphQLDeferDirective`, `GraphQLStreamDirective`)
  ne font **pas** partie de `specifiedDirectives`. Il faut les **ajouter au schéma**, sinon
  la validation répond `Unknown directive "@defer"`.
- Un resolver de liste peut renvoyer un **itérable asynchrone**. Combiné à `@stream`, on peut
  envoyer les lignes au fil de leur lecture.
- La validation est plus stricte :
  - `@defer`/`@stream` sont interdits sur les racines de mutation et de subscription ;
  - les fragments nommés sont suivis jusqu'à l'opération.

## Prérequis bloquants

### 1. Apollo Server 5.5.1 n'active pas la livraison incrémentale avec graphql 17.0.2

`node_modules/@apollo/server/dist/esm/incrementalDeliveryPolyfill.js` :

```js
if (graphql.version === '17.0.0-alpha.9' && 'experimentalExecuteIncrementally' in graphql) { … }
```

Avec la version stable 17.0.2, Apollo revient silencieusement à `execute()` : une requête
avec `@defer` est donc exécutée en une seule réponse. Le support officiel de graphql 17 est
suivi dans [apollographql/apollo-server#8220](https://github.com/apollographql/apollo-server/issues/8220).
Ce ticket est ouvert et sans calendrier.

Pistes à évaluer dans le spike :

| Piste                                                  | Principe                                                                                                                                                                   | Risques                                                                                                                                                                                                       |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Attendre Apollo**                                 | Une version d'Apollo avec `peer graphql ^17` active le format actuel. On retire aussi l'override de `package.json`.                                                        | Aucun délai annoncé.                                                                                                                                                                                          |
| **B. Option `legacyExperimentalExecuteIncrementally`** | `new ApolloServer({ legacyExperimentalExecuteIncrementally: legacyExecuteIncrementally })`, qui sert le format historique (`Accept: multipart/mixed; deferSpec=20220824`). | Ne marche qu'avec les clients qui demandent ce format. Il faut vérifier que la forme produite par `legacyExecuteIncrementally` en 17.0.2 est bien celle qu'Apollo attend. Le format est appelé à disparaître. |
| **C. Plugin ou patch d'Apollo**                        | Réécrire la détection de version (`patch-package`) ou exécuter nous-mêmes dans un plugin.                                                                                  | Fragile à chaque mise à jour d'Apollo. **Déconseillé.**                                                                                                                                                       |
| **D. Changer de serveur**                              | GraphQL Yoga (Envelop) supporte graphql 17, `@defer` et `@stream` nativement.                                                                                              | Migration du serveur : plugins de cycle de vie, `formatError`, drainage à l'arrêt, `expressMiddleware`. Chantier distinct, à ne lancer que si Apollo reste bloqué durablement.                                |

### 2. Le frontend utilise `graphql-request`

`dashboard-template-frontend` (`graphql-request@^7`) ne lit pas les réponses
`multipart/mixed`. Il faut, au choix :

- un client qui gère la livraison incrémentale (urql avec `fetchExchange`, Apollo Client) ;
- une couche `fetch` + parseur multipart (`meros`) autour des requêtes concernées.

Ces requêtes concernées sont celles qui utilisent `@defer`. Les autres requêtes peuvent
rester sur `graphql-request` : sans `@defer`, la réponse reste un JSON classique.

## Cas d'usage dans cette API

| Requête                            | Ce qui serait différé ou streamé                                                                     | Gain attendu                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getCatalogSchema` / `getMetaData` | `Metadata.stats` (bornes, distribution ; résolu à la demande, une requête SQL par colonne)           | Les libellés et la structure des filtres s'affichent tout de suite, les sliders se calibrent ensuite.                                                                                                                          |
| `getFactTableWithMetadata`         | Les métadonnées de colonnes et le total, derrière les lignes                                         | Le tableau s'affiche avant les en-têtes enrichis.                                                                                                                                                                              |
| `getAggregates`                    | Le nombre total de groupes (`includeRowCount`)                                                       | Le graphique s'affiche avant la pagination. Il faut d'abord **exposer le total comme un champ** (aujourd'hui c'est un argument) pour pouvoir le différer.                                                                      |
| `getFactTable` (lignes)            | `@stream(initialCount: N)` avec un resolver qui renvoie un itérable asynchrone sur un curseur DuckDB | Les premières lignes s'affichent plus tôt. C'est le gain le plus incertain : DuckDB matérialise souvent le résultat. **À mesurer** avant d'investir, et à comparer à la pagination et aux exports en streaming déjà existants. |

Le gain réel se mesure avec les métriques ajoutées dans #68 (`/metrics` →
`graphql.phases`, et `graphql.resolvers` avec `GRAPHQL_TRACE_RESOLVERS=true`) :
`Metadata.stats` est-il le resolver dominant ?

## Implications techniques

### Schéma et contrat

- Ajouter `GraphQLDeferDirective` et `GraphQLStreamDirective` au schéma exécutable
  (`src/schema/index.ts`). Cela change le SDL :
  - régénérer `schema.graphql` et `src/generated/graphql.ts` ;
  - `schema:diff` doit classer le changement comme **sûr** (directives ajoutées) ;
  - mettre à jour la doc de l'API (guide des requêtes et référence GraphQL générée).

### Sécurité (`src/security/`)

- **Complexité** : l'analyseur compte déjà les fragments inline. Un fragment différé doit
  **garder son coût**, car le travail total est le même. Il faut un test qui le vérifie.
- **Nouveau vecteur de DoS** : beaucoup de `@defer` dans une opération, c'est beaucoup de
  payloads et de cycles d'exécution. Il faut :
  - une règle de validation qui limite le nombre de `@defer` par opération (nouvelle clé
    `SECURITY`, par exemple `MAX_DEFERS`) ;
  - une borne sur `@stream(initialCount:)` : au plus `API.PAGINATION.MAX_LIMIT`, et
    l'`initialCount` doit être pris en compte dans le coût.
- **Profondeur** : `depth-limit.ts` parcourt les fragments inline. À vérifier avec des
  fragments nommés différés.
- Contrôle du type d'opération : rien ne change (`@defer` est déjà interdit hors query par
  graphql 17).

### Transport HTTP

- **Compression** : le middleware `compression` (`src/server.ts`) met la réponse en tampon.
  Il annulerait l'intérêt du streaming. Il faut l'exclure quand l'en-tête `Accept` contient
  `multipart/mixed`, ou forcer un `flush()` à chaque partie.
- **Ingress / reverse proxy** : couper la mise en tampon pour ces réponses (par exemple
  `nginx.ingress.kubernetes.io/proxy-buffering: "off"`). Il faut le prévoir dans
  `helm/dashboard-template-api/values.yaml` et dans la doc de déploiement.
- **Arrêt progressif** : une réponse incrémentale reste ouverte plus longtemps. Il faut
  vérifier que `ApolloServerPluginDrainHttpServer` et le budget de drainage (`drainBudgetMs`)
  la laissent se terminer, et ajouter un test dans `graceful-shutdown.test.ts`.
- **Délais** : les timeouts de requête (`src/utils/timeout.ts`) et les limites de requête
  doivent couvrir toute la durée du flux, pas seulement la réponse initiale.

### Exécution et données

- **DataLoader** : les fragments différés s'exécutent après la réponse initiale. Leurs
  chargements ne seront donc pas regroupés avec ceux de la réponse initiale, d'où plus de
  requêtes SQL. Il faut le mesurer : différer ne doit pas coûter plus cher au total.
- **Cache Redis** : il est au niveau des loaders, donc rien ne change. Le cache HTTP ne
  s'applique pas aux réponses `multipart/mixed`.
- **Annulation** : si le client se déconnecte pendant le flux, les parties restantes ne
  doivent pas continuer à interroger DuckDB. graphql 17 accepte un `abortSignal`, mais
  Apollo ne le transmet pas encore.

### Erreurs, journalisation, métriques

- Il faut vérifier que `formatError` (masquage en production, suppression des suggestions,
  `errorId`) et `didEncounterErrors` s'appliquent aussi aux erreurs des **payloads
  suivants**. Aujourd'hui, `willSendResponse` ne voit que `singleResult`.
- `metrics.responseTimes` et le canal `graphql:execute` mesurent la réponse initiale, pas la
  fin du flux. Il faut ajouter une mesure de fin de flux (dernier payload).

### Tests

- Tests d'intégration capables de parser `multipart/mixed` avec supertest (petit parseur
  dans `tests/helpers/`).
- Cas à couvrir :
  - réponse initiale puis payloads différés ;
  - erreur dans un fragment différé (masquée en production) ;
  - limite `MAX_DEFERS` ;
  - une requête sans `Accept: multipart/mixed` reçoit une réponse 406 ou unique ;
  - compression désactivée sur ces réponses ;
  - arrêt progressif pendant un flux.

## Phasage proposé

1. **Spike (go / no-go)**, une demi-journée à une journée. Il doit répondre à trois questions :
   - la piste B fonctionne-t-elle de bout en bout ?
   - `Metadata.stats` différé apporte-t-il un gain mesurable ?
   - quelle librairie côté frontend ?
2. **Backend** :
   - directives dans le schéma ;
   - garde-fous de sécurité ;
   - transport (compression, proxy) ;
   - erreurs et métriques sur les payloads suivants ;
   - tests et docs.
3. **Frontend** : client incrémental limité aux vues qui en profitent (filtres et sliders
   d'abord).
4. **Nettoyage** quand Apollo supportera graphql 17 :
   - retirer l'override de `package.json` ;
   - passer du format historique (piste B) au format actuel.

## Prompts

Chaque prompt est autonome : il peut être lancé dans une nouvelle session Claude Code, à la
racine du dépôt indiqué. Pour régler la session :

- modèle : `/model` ;
- niveau d'effort : `/effort` ;
- plan mode : `Shift+Tab` jusqu'à « plan mode on ».

### Prompt 1 : spike de faisabilité (dépôt `dashboard-template-api`)

- **Modèle** : Opus 5.5 (`claude-opus-5-5`). Il faut lire le code d'Apollo et de GraphQL.js
  dans `node_modules`, ce qui demande un raisonnement fin.
- **Effort** : `high`.
- **Plan mode** : **oui**. Le spike touche au serveur et doit rester jetable : valider
  l'approche avant d'écrire.

```text
Lis DEFER-STREAM.md à la racine. Je veux un spike de faisabilité de @defer avec graphql 17.0.2
et @apollo/server 5.5.1, sur une branche jetable `spike/defer` (ne merge rien).

1. Vérifie dans node_modules/@apollo/server comment l'option `legacyExperimentalExecuteIncrementally`
   est utilisée, et si `legacyExecuteIncrementally` de graphql 17.0.2 produit exactement la forme
   attendue (format deferSpec=20220824). Regarde aussi si une version d'Apollo plus récente que
   5.5.1 ou une PR liée à apollographql/apollo-server#8220 existe.
2. Prototype minimal : ajoute GraphQLDeferDirective au schéma exécutable, branche l'option, et
   démontre avec un test d'intégration supertest (parseur multipart/mixed minimal) qu'une requête
   `getCatalogSchema { name ... @defer { stats { ... } } }` renvoie une réponse initiale puis un
   payload différé. Désactive la compression pour multipart/mixed dans le prototype.
3. Mesure sur les catalogues de test (npm run test:setup) le temps jusqu'à la réponse initiale et
   jusqu'à la fin, avec et sans @defer, et le nombre de requêtes SQL (GRAPHQL_TRACE_RESOLVERS=true
   et /metrics).
4. Vérifie si formatError, didEncounterErrors et le masquage des suggestions s'appliquent aux
   erreurs des payloads différés.

Livrable : une section « Résultats du spike » ajoutée à DEFER-STREAM.md avec un go / no-go
argumenté (piste B viable ou non, gain mesuré, risques), et rien d'autre de modifié sur main.
```

### Prompt 2 : implémentation backend (dépôt `dashboard-template-api`, après un spike « go »)

- **Modèle** : Opus 5.5 (`claude-opus-5-5`). Le travail touche à la sécurité, au transport
  et aux erreurs, sur plusieurs couches.
- **Effort** : `high` (`xhigh` si le spike a laissé des zones d'ombre sur les erreurs différées).
- **Plan mode** : **oui**. Le plan doit lister les fichiers, les nouvelles clés de config et
  les tests avant toute écriture.

```text
Lis DEFER-STREAM.md (y compris « Résultats du spike ») et CLAUDE.md. Implémente le support de
@defer (et @stream seulement si le spike l'a jugé utile) sur une branche `qb-defer-stream`, selon
la piste retenue par le spike :

- directives dans le schéma exécutable ; régénère schema.graphql et src/generated/graphql.ts
  (npm run schema:generate, npm run codegen) et vérifie que schema:diff classe le changement
  comme sûr ;
- sécurité : un fragment différé garde son coût de complexité (test) ; nouvelle règle de
  validation qui limite le nombre de @defer par opération (clé SECURITY.MAX_DEFERS dans
  config/security.yaml, documentée) ; borne et coût de @stream(initialCount) ;
- transport : pas de compression pour multipart/mixed ; annotation de proxy-buffering désactivé
  dans le chart Helm et la doc de déploiement ; drainage à l'arrêt couvrant les flux (test dans
  graceful-shutdown) ;
- erreurs et métriques : masquage en production, suppression des suggestions et errorId sur les
  payloads suivants ; durée jusqu'au dernier payload dans /metrics ;
- tests d'intégration multipart (helper dans tests/helpers/) et docs (guide des requêtes de
  l'API, configuration).

Respecte le style du code existant (commentaires en français, docstrings en anglais). Lance
type:check, lint, schema:check, codegen:check et toute la suite de tests avant de proposer un
commit ; ne pousse pas sans me demander.
```

### Prompt 3 : adaptation du frontend (dépôt `dashboard-template-frontend`)

- **Modèle** : Sonnet 5.5 (`claude-sonnet-5-5`). C'est une intégration côté client bien
  délimitée une fois le contrat backend fixé.
- **Effort** : `medium`.
- **Plan mode** : **oui**. Il faut choisir la librairie (urql, Apollo Client ou `meros` +
  fetch) et le périmètre des vues avant de toucher au code.

```text
Le backend dashboard-template-api supporte désormais @defer (voir ../dashboard-template-api/DEFER-STREAM.md
et son guide des requêtes). Ce frontend utilise graphql-request, qui ne lit pas les réponses
multipart/mixed.

Propose puis implémente, pour les seules vues qui en profitent (d'abord les filtres et sliders qui
lisent Metadata.stats), une lecture incrémentale : compare urql (fetchExchange), Apollo Client et
une couche fetch + meros sur le poids ajouté, la compatibilité Next.js 16 / React 19 (SSR et
composants serveur) et l'effort de migration, puis retiens l'option la plus légère. Les autres
requêtes restent sur graphql-request. Affiche un état intermédiaire (squelette) tant que le
fragment différé n'est pas arrivé, gère l'erreur d'un payload différé sans casser la vue, et
ajoute les tests correspondants. Ne pousse rien sans me demander.
```

### Prompt 4 : nettoyage quand Apollo supportera graphql 17 (dépôt `dashboard-template-api`)

- **Modèle** : Sonnet 5.5 (`claude-sonnet-5-5`). C'est une mise à jour de dépendances avec
  des vérifications mécaniques.
- **Effort** : `medium`.
- **Plan mode** : non. Le périmètre est connu ; il suffit de s'arrêter si une étape révèle
  un changement de comportement.

```text
Vérifie si une version publiée de @apollo/server déclare `peer graphql` compatible avec ^17
(npm view @apollo/server peerDependencies, apollographql/apollo-server#8220). Si oui : mets-la à
jour, retire l'entrée `overrides` de package.json, vérifie avec `npm ls graphql` qu'une seule
instance reste, et si @defer est en place, passe du format historique (legacyExperimentalExecuteIncrementally)
au format actuel en adaptant le frontend si nécessaire. Évalue aussi si
hideSchemaDetailsFromClientErrors d'Apollo couvre désormais la coercion des variables
(apollographql/apollo-server#8086) : si oui, il peut remplacer la suppression des suggestions de
formatGraphQLError. Lance toutes les vérifications de CLAUDE.md et la suite de tests, puis
résume ce qui a changé. Si aucune version compatible n'existe, dis-le simplement et ne modifie rien.
```
