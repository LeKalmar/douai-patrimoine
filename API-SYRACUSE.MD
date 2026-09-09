# API du portail Syracuse — Réseau des bibliothèques Douai/Cuincy

**Cible** : `https://www.bm-douai.fr` — portail Archimed **Syracuse / Ermes** (ASP.NET, services WCF `.svc`, index Solr).
**Objet** : se raccorder à l'API pour récupérer les données du catalogue et refaire l'affichage.
**Statut** : tous les endpoints marqués « vérifié » ont été appelés en direct le **2026-09-08** et ont répondu.

> **Seconde campagne de vérification, 2026-09-08 (soir).** Une relecture orientée « peut-on
> remplacer nos exports XML ? » a confirmé l'essentiel de ce document, **infirmé deux points**
> (§9 et §12, corrigés ci-dessous) et découvert trois choses qui n'y figuraient pas : la
> signature de `GetHoldings` (§16), la correspondance `ARCHI` ↔ `RscId` (§17) et surtout le
> champ Solr `timestamp` (§19), qui rend possible une synchronisation incrémentale.
> Tout ce qui suit à partir du §16 provient de cette seconde campagne.

---

## 1. Résumé en dix lignes

Il n'y a pas d'API publique documentée, mais le front du portail est un client JavaScript qui parle à
des services JSON. Ces services sont **appelables directement, sans authentification, sans clé, sans
cookie de session**. Le point d'entrée principal est :

```
POST https://www.bm-douai.fr/Portal/Recherche/Search.svc/Search
Content-Type: application/json; charset=utf-8
Body: {"query": { ... }}
```

Il renvoie, dans un même document JSON, **les données structurées** (`d.Results[].Resource`) **et** le
HTML déjà mis en forme par le portail (`d.HtmlResult`). C'est exactement ce qu'il faut pour garder les
données et jeter le style. Le catalogue complet fait **307 823 notices**.

**Le seul vrai obstacle est CORS** : voir §12.

---

## 2. Comment ces endpoints ont été trouvés

Utile si l'on doit refaire l'exercice sur un autre portail Syracuse.

| Fichier | Ce qu'il donne |
|---|---|
| `…_files/search_list.js` | **Non minifié.** Contient `doSearch()`, la construction de la requête, le format de `FacetFilter`. C'est la pièce maîtresse. |
| `…_files/portal-front-all.js` | Minifié. Contient `$.ajaxSetup({type:"POST", contentType:"application/json"})` et la liste complète des `.svc`. |
| HTML de la page de recherche | `ErmesManager.BasePath = '/'`, `ErmesManager.WsQueryString = ''` → les URL de service sont à la racine du domaine. |
| HTML de la page d'accueil | URL `SearchRss` avec leurs clés. |

Commande utile pour inventorier les services d'un portail Syracuse :

```bash
grep -ohE '[A-Za-z0-9_/.-]*\.svc/[A-Za-z0-9_]+' *.js | sort -u
```

---

## 3. Endpoint principal : `Search.svc/Search` — *vérifié*

### Requête

```http
POST /Portal/Recherche/Search.svc/Search HTTP/1.1
Host: www.bm-douai.fr
Content-Type: application/json; charset=utf-8
```

```json
{
  "query": {
    "QueryString": "gaudin",
    "Page": 0,
    "PageRange": 3,
    "ScenarioCode": "DEFAULT",
    "SearchLabel": "",
    "InitialSearch": true,
    "SearchContext": 0,
    "ResultSize": 10
  }
}
```

Aucun en-tête d'authentification n'est nécessaire. Un `User-Agent` et un `Referer` de navigateur sont
recommandés par politesse, mais ne sont pas exigés.

### Champs de `query`

| Champ | Type | Rôle |
|---|---|---|
| `QueryString` | string | Requête. Accepte la **syntaxe Solr** (§7). `*:*` = tout le catalogue. |
| `Page` | int | Page, **0-based**. |
| `ResultSize` | int | Résultats par page. **Valeurs acceptées : 5, 10, 25, 50** (§11). |
| `ScenarioCode` | string | Corpus interrogé (§8). |
| `SortField` / `SortOrder` | string / int | Tri (§6). |
| `FacetFilter` | **string** contenant du JSON | Filtres à facettes (§5). |
| `ForceSearch` | bool | À mettre à `true` dès qu'on modifie facettes ou tri. |
| `PageRange` | int | Nombre de pages dans le widget de pagination. Sans effet sur les données. |
| `InitialSearch` | bool | `true` au premier appel. |
| `SearchContext` | int | `0`. |
| `QueryGuid` | string | Renvoyé par le serveur ; à réinjecter pour garder le contexte de recherche. |

### Réponse

Enveloppe systématique :

```json
{ "errors": [], "message": null, "success": true, "d": { ... } }
```

**Toujours tester `success`** : en cas d'erreur le HTTP reste **200** avec `"success": false`,
`"d": null` et un message générique (`"Votre recherche a échoué."`) qui ne dit pas ce qui cloche.

Clés de `d` :

| Clé | Contenu |
|---|---|
| `Results` | **Tableau des notices** — la donnée utile. |
| `SearchInfo` | `NBResults`, `Page`, `PageMax`, `SearchTime`, `TotalTime`. |
| `FacetCollectionList` | Facettes et leurs valeurs, avec les compteurs (§5). |
| `Query` | La requête **normalisée par le serveur** — à réinjecter pour paginer (§4). |
| `HtmlResult` | La liste de résultats en HTML, telle que le portail l'affiche. Contient les **URL de couverture** (§10). |
| `Sorts` | Tris disponibles (§6). |
| `SpellChecking` | Suggestion orthographique. |
| `Statistics`, `ScenarioDisplayMode`, `GeniusSearchSettings` | Accessoires. |

### Une entrée de `Results[]`

| Clé | Contenu |
|---|---|
| `Resource` | **L'objet de données** (voir ci-dessous). |
| `FriendlyUrl` | URL publique de la notice : `/Default/doc/SYRACUSE/{RscId}/{slug}`. |
| `CustomResult` | Fragment HTML « notice courte » (titre + métadonnées + résumé). |
| `CompactResult` | Fragment HTML format carte. |
| `HighLights` | Termes de la requête surlignés. |
| `SeekForHoldings` | `true` si la notice a des exemplaires → à passer à `CheckAvailability` (§9). |
| `HasPrimaryDocs` / `PrimaryDocs` | Documents numériques attachés. |
| `GroupedResults` / `WorksKeyResults` | Notices regroupées (œuvres, éditions multiples). |

### `Resource` — le contrat de données

Les noms sont abrégés. Correspondance relevée sur des notices réelles :

| Champ | Signification | Exemple |
|---|---|---|
| `Ttl` | Titre | `"Athlétisme / Florian Gaudin-Winer"` |
| `Crtr` | Auteur principal (avec sa fonction) | `"Gaudin-Winer, Florian. Auteur"` |
| `Ctrb` | Contributeurs | `"Dubreuil, Corinne. Illustrateur"` |
| `Desc` | Résumé | *(texte, souvent tronqué avec `…`)* |
| `Dt` | Année (ou date pour un billet de blog) | `"2014"` |
| `Pbls` | Éditeur + lieu | `"Milan. Toulouse"` |
| `Subj` | Sujets | `"Sports"` |
| `Type` | Type lisible | `"Livre"`, `"Titre de série"` |
| `Frmt` | Code format interne | `MONO`, `TITS`, `AGDA`, `BLOG` |
| `Id` | Identifiant commercial, **préfixé** | `"isbn:978-2-7459-6779-4"` |
| `RscId` | **Identifiant notice** dans la base | `"939725"` |
| `RscBase` | Base | `SYRACUSE`, `CALENDAR`, `BLOG` |
| `RscUid` | Identifiant global | `154101` |
| `Site` | Site propriétaire | `2` |
| `Cmts`, `CmtsCt`, `Tags`, `ViewCount`, `BasketCount` | Contributions et compteurs | |

`Crtr` et `Ctrb` arrivent en **texte libre avec la fonction accolée** (`"Nom, Prénom. Auteur"`), pas
en liste structurée. Prévoir un nettoyage si l'on veut afficher l'auteur seul.

`Desc` peut être `null` — c'est fréquent sur le fonds ancien.

---

## 4. Pagination — *vérifié*

`Page` est 0-based, `SearchInfo.PageMax` est le dernier index de page. La méthode fiable, et celle
qu'emploie le portail lui-même, consiste à **réinjecter le `Query` renvoyé** par la réponse
précédente plutôt qu'à reconstruire la requête :

```python
query = previous["d"]["Query"]
query["Page"] = 2
query["ForceSearch"] = True
post(SEARCH_URL, {"query": query})
```

Reconstruire une requête de zéro fonctionne aussi, mais on perd le `QueryGuid` et les valeurs
normalisées, et le risque d'erreur silencieuse augmente.

---

## 5. Facettes — *vérifié*

`FacetCollectionList[]` donne pour chaque facette : `FacetId`, `FacetField`, `FacetLabel`, et
`FacetList[]` (`Label`, `Count`, `IsSelected`).

**Pour filtrer**, `FacetFilter` est une **chaîne de caractères contenant du JSON** (pas un objet), dont
les clés sont l'id de facette **préfixé d'un underscore** :

```json
"FacetFilter": "{\"_82\": \"Gaudin, Thierry\"}",
"ForceSearch": true,
"Page": 0
```

Le préfixe `_` est un contournement volontaire présent dans `search_list.js` : il empêche le
navigateur de retrier automatiquement des clés numériques. Il est obligatoire.

Plusieurs valeurs pour une même facette se joignent avec `||` :
`"{\"_90\": \"Douai La Micheline||Douai Marceline Desbordes-Valmore\"}"`.

### Ids relevés sur le scénario `DEFAULT`

| Id | Champ Solr | Libellé |
|---|---|---|
| 79 | `SubjectSuggest_exact` | Suggestions |
| 80 | `TypeOfDocument_exact` | Type de document |
| 81 | `Audience_exact` | Public visé |
| 82 | `Author_exact` | Auteur |
| 83 | `Classification_exact` | Classification |
| 84 | `class_exact` | Classification locale |
| 86 | `FormDescription_exact` | Support |
| 87 | `Contributor_exact` | Contributeur |
| 88 | `Funds_exact` | Section |
| 89 | `Language_exact` | Langue |
| 90 | `LocationSite_exact` | Site |
| 91 | `NewItemFlag_exact` | Nouveauté |
| 92 | `SeriesTitle_exact` | Collection |
| 95 | `SubjectTopic_exact` | Sujet |
| 96 | `Publisher_exact` | Éditeur |
| 97 | `YearOfPublicationGroup_exact` | Année (par tranches) |
| 98 | `CallNumber_exact` | Cote |
| 526 | `NewItemFlagBySite_exact` | Nouveauté par bibliothèque |
| 611 | `YearOfPublication_exact` | Année de publication |

Ces ids sont **de la configuration, pas une norme**. Ils peuvent changer si un collègue modifie le
paramétrage dans le back-office, et ils diffèrent d'un scénario à l'autre. **Les lire dans
`FacetCollectionList` à l'exécution** plutôt que les coder en dur — ou, mieux, passer par la syntaxe
Solr (§7), qui utilise les noms de champs et reste stable.

---

## 6. Tri — *vérifié*

`d.Sorts` liste les tris disponibles. `SortOrder` : `0` = croissant, `1` = décroissant.

| `SortField` | Libellé |
|---|---|
| `Title_sort` | Titre |
| `Author_sort` | Auteur |
| `YearOfPublication_int_sort` | Année de publication |
| `Popularity_sort` | Popularité |
| `%RANDOM%_random_sort` | Aléatoire |

⚠️ **Un `SortField` inconnu fait échouer toute la requête** (`success: false`), il n'est pas ignoré.
Il n'existe pas de tri par date d'ajout au catalogue : pour une page « nouveautés », utiliser la
facette / le champ `NewItemFlag_exact` (§7).

---

## 7. Syntaxe Solr dans `QueryString` — *vérifié*

`QueryString` est passé à Solr. C'est le levier le plus puissant de cette API, et le plus stable
puisqu'il ne dépend pas des ids de configuration.

| Requête | Résultats |
|---|---|
| `*:*` | 307 823 *(catalogue complet)* |
| `"la peste"` *(phrase exacte)* | 105 |
| `camus AND peste` | 12 |
| `Author_exact:"Gaudin, Thierry"` | 8 |
| `TypeOfDocument_exact:Livre` | 179 213 |
| `Language_exact:français` | 160 599 |
| `Funds_exact:"Adulte"` | 101 742 |
| `LocationSite_exact:"Douai La Micheline"` | 6 257 |
| `YearOfPublication_exact:2024` | 4 863 |
| `NewItemFlag_exact:*` | 1 882 *(les nouveautés)* |

Tout champ `*_exact` du tableau du §5 est interrogeable ainsi. Les valeurs contenant un espace ou une
virgule doivent être entre guillemets.

Attention : `title:` n'existe pas (renvoie 0 sans erreur). Une requête sur un champ inexistant ne
lève pas d'erreur, elle renvoie simplement zéro résultat — vérifier les compteurs plutôt que de se
fier au succès de l'appel.

---

## 8. Scénarios (corpus) — *vérifié*

`POST /Portal/Recherche/Search.svc/ListAllScenario` avec un corps `{}` renvoie la liste :

| `ScenarioCode` | Libellé | Base | Volume |
|---|---|---|---|
| `DEFAULT` | Partout | `SYRACUSE` | 307 823 |
| `CALENDAR_AGENDA` | Agenda du réseau | `CALENDAR` | 144 |
| `BLOG` | Billets | `BLOG` | 51 |

Les trois répondent au même endpoint `Search.svc/Search`, seul `ScenarioCode` change. Utile pour
alimenter une page d'accueil (agenda + billets + nouveautés) avec un seul client.

⚠️ **Limite importante pour l'agenda** : le `Resource` d'un événement `CALENDAR` **ne contient ni date
ni lieu** — il n'a que `Ttl`, `Subj`, `Type`, `RscId`. Les dates (`"Le 07/11/2026 de 17:00 à 18:15"`),
la catégorie et le lieu ne sont disponibles que dans le HTML (`CustomResult` / `HtmlResult` / flux RSS)
et doivent être extraits par parsing. C'est le principal endroit où le contrat de données est
insuffisant.

---

## 9. Disponibilité des exemplaires — `ILSClient.svc/CheckAvailability` — *vérifié*

`Search` ne renvoie **pas** la disponibilité : le portail la demande dans un second appel, après
affichage de la liste. À reproduire.

```http
POST /Portal/Services/ILSClient.svc/CheckAvailability
```

```json
{
  "RecordIdArray": [
    {"RscId": "939725", "Docbase": "SYRACUSE", "RscType": "MONO"}
  ],
  "searchQuery": { ...le Query renvoyé par Search... }
}
```

`RecordIdArray` accepte plusieurs notices en un appel — batcher toute la page. N'y mettre que les
notices dont `SeekForHoldings` vaut `true`.

Réponse : `d[]`, une entrée par notice, avec `Id: {Docbase, RscId}` et :

```json
"ItemHoldings": {
  "Availability": 1,
  "HoldingLabel": "1 exemplaire disponible",
  "RecordId": "939725",
  "Mode": "display-standard",
  "Error": false,
  "WhenHoldBack": null
}
```

`Availability` : **`1` = disponible, `3` = indisponible** (valeurs observées ; `HoldingLabel` porte le
texte affichable et vaut mieux que d'interpréter le code).

> ⚠️ **Correction (2026-09-08, seconde campagne).** Ce document affirmait que `ItemHoldings`
> contient un tableau `Holdings[]` avec le détail par exemplaire. **C'est faux.** Vérifié sur
> l'appel réel : `ItemHoldings` ne porte que `ActionLabel, Availability, Docbase, Error,
> ErrorMessage, HoldingLabel, Id, Mode, RecordId, WhenHoldBack` — aucun tableau `Holdings`. Le
> `HtmlView` associé ne contient lui aussi qu'un agrégat (« 2 exemplaires disponibles ») et un
> lien « Plus d'infos sur la disponibilité », sans aucune donnée exemplaire.
>
> **Le détail par exemplaire (code-barre, cote, section…) vient de `ILSClient.svc/GetHoldings`,
> dont la signature est documentée au §16.** C'est la découverte la plus utile de la seconde
> campagne : c'est le seul endroit de toute l'API où un code-barre est exposé.

---

## 10. Couvertures — *vérifié*

Les URL de couverture **ne sont pas dans `Resource`**. Elles sont dans `HtmlResult`, sous cette forme :

```
https://covers.syracuse.cloud/Cover/VDOU/MONO/T9TDK8o0yoWonhZ_A3ve6Q2/9782745967794/MEDIUM?fallback=…
                                    ^skin ^fmt  ^jeton signé          ^EAN/ISBN      ^taille
```

Le segment `T9TDK8o0yoWonhZ_A3ve6Q2` est un **jeton signé côté serveur : l'URL n'est pas
reconstructible** à partir de l'ISBN. Il faut la lire dans le HTML.

Extraction : parcourir `HtmlResult`, chaque notice est un bloc
`<div class="notice … rscId_{id}_{base}" data-id="{id}">`, la couverture est le premier
`src="https://covers.syracuse.cloud/…"` qui suit.

```python
COVER_RE = re.compile(r'data-id="(\d+)"|src="(https://covers\.syracuse\.cloud/[^"]+)"')
# on associe chaque URL au dernier data-id rencontré
```

**Le jeton ne dépend pas de la taille** : `MEDIUM` peut être remplacé par `SMALL` ou `LARGE` dans une
URL déjà obtenue. `MEDIUM` ≈ 6 Ko (160 px), `LARGE` ≈ 45 Ko. Le service redirige (301) vers les
visuels Amazon.

Toutes les notices n'ont pas de couverture (fonds ancien sans ISBN) : sur un échantillon, 4 sur 5.
Le paramètre `fallback=` de l'URL pointe vers l'image générique par type de document, et le service
l'applique tout seul — pas besoin de gérer le cas d'erreur côté client.

---

## 11. Pièges vérifiés

| Piège | Détail |
|---|---|
| **`ResultSize` a une liste blanche** | Seules **5, 10, 25, 50** sont honorées. `20`, `30`, `40`, `100` sont **silencieusement ramenées à 10** — pas d'erreur, juste moins de résultats que demandé. Ce sont les tailles configurées dans le back-office ; elles peuvent différer sur un autre portail. |
| **Les erreurs sortent en HTTP 200** | Toujours tester `success`. Le message est générique et n'indique pas le champ fautif. |
| **Un `SortField` invalide casse la requête** | Contrairement à un champ Solr inconnu, qui renvoie 0 résultat sans erreur. |
| **`FacetFilter` est une string, pas un objet** | Et les clés portent un préfixe `_`. |
| **Les ids de facettes sont de la configuration** | Les lire à l'exécution ou préférer la syntaxe Solr. |
| **Données mêlées à du HTML** | Dates d'agenda, détail des exemplaires, couvertures : uniquement dans les champs HTML. |
| **API non contractuelle** | Aucune garantie de stabilité : c'est l'API interne du front. Une mise à jour Syracuse par Archimed peut la changer sans préavis. |

---

## 12. CORS — l'obstacle principal

**Vérifié** : le portail ne renvoie **aucun en-tête `Access-Control-Allow-Origin`**. Le pré-vol
`OPTIONS` répond `200` avec seulement `allow: POST`.

Conséquence : **une page servie depuis un autre domaine (ou `file://`, ou `localhost`) ne peut pas
appeler ces endpoints depuis le navigateur.** Le JavaScript du portail y arrive uniquement parce
qu'il s'exécute sur `www.bm-douai.fr` (même origine).

> ⚠️ **Nuance (2026-09-08, seconde campagne) — pour *ce* projet, CORS n'est pas un obstacle.**
> Ce constat vaut pour un front navigateur appelant le portail en direct. Or nos builds sont des
> scripts Node et le site dispose déjà de sept fonctions serverless (`api/*.mjs`). **Côté serveur,
> il n'y a pas de CORS.** `fetch` natif suffit (Node ≥ 18), donc la contrainte « zéro dépendance
> npm » du projet est respectée. Le vrai obstacle est ailleurs : voir §18.

Trois contournements, par ordre de pertinence :

1. **Injecter le nouveau front dans le portail lui-même** (module « code personnalisé » / template de
   skin du back-office Syracuse). On est alors en même origine, CORS disparaît, et c'est le seul
   chemin viable pour une mise en production sans serveur supplémentaire.
2. **Proxy côté serveur** — quelques dizaines de lignes, relaie `POST /api/search` vers Syracuse et
   ajoute l'en-tête CORS. C'est le choix naturel pour un POC développé en local, et il permet en
   prime de mettre un cache.
3. **Extraction préalable en JSON statique** — si le POC ne fait que démontrer une maquette, figer
   quelques centaines de notices dans un fichier suffit et supprime toute dépendance réseau.

---

## 13. Autres endpoints

Relevés dans `portal-front-all.js`, appelables sur le même modèle (`POST`, JSON). Deux ont été
vérifiés et sont signalés comme tels ; les autres n'ont pas été testés, et plusieurs exigent une
session authentifiée (compte lecteur).

| Endpoint | Usage |
|---|---|
| `Portal/Recherche/Search.svc/GetRecord` | Notice détaillée — **testé, fonctionne** : `{"query":{"Id":0,"Index":N,"NBResults":1,"SearchQuery":{…,"ResultSize":-1}}}` où `Index` est la position **1-based** dans le jeu de résultats. Renvoie `Result`, `HtmlResult`, `ReboundResults`. |
| `Search.svc/RefreshFacet` | Recharger une facette seule (champ `FacetContains` pour filtrer ses valeurs). |
| `Search.svc/GetHierarchicalFacet` | Facettes arborescentes. |
| `Search.svc/Suggest`, `Search.svc/SolrSuggest` | Autocomplétion. La signature n'a pas été trouvée — mon essai a échoué. |
| `Search.svc/SearchRss` | **Flux RSS d'une recherche mémorisée** — testé, fonctionne : `GET /Portal/Recherche/Search.svc/SearchRss?key={md5}&useSearchSort=false&useSearchResultSize=true`. Deux clés sont exposées dans le HTML de la page d'accueil. Pas de CORS à gérer côté serveur, mais les descriptions sont du HTML et les clés ne se fabriquent pas. |
| `Sarasvati.svc/More` | Enrichissements (résumés, jaquettes, recommandations). |
| `ILSClient.svc/GetHoldings`, `GetListHoldings` | Détail complet des exemplaires — **testé, signature trouvée, voir §16**. C'est le seul endpoint exposant les codes-barres et les cotes. |
| `ILSClient.svc/PlaceReservation`, `PlaceMultipleReservation` | Réservation. **Compte requis.** |
| `OpenFind.svc/*` | Panier, sélections, commentaires, tags. **Compte requis.** |
| `logon.svc/logon`, `logoff` | Authentification lecteur. |
| `Agenda.svc/*`, `BDP.svc/*`, `Sdi.svc/*` | Agenda, expositions, alertes. |

---

## 14. Recommandation d'architecture

Pour un POC de restylage, le découpage qui demande le moins de travail :

```
  navigateur (nouveau front)
        │  POST /api/search   {q, page, size, facets, sort}
        ▼
  proxy local  ──── cache disque ────┐
        │                            │  évite de retaper le portail
        ▼                            │  à chaque rechargement
  Search.svc/Search  ────────────────┘
  ILSClient.svc/CheckAvailability   (2e appel, batché)
  HtmlResult ──► extraction des couvertures
```

Séquence par page de résultats : **un appel `Search`**, puis **un appel `CheckAvailability`** pour
toutes les notices de la page d'un coup, et les couvertures sont extraites du `HtmlResult` déjà reçu.
Soit deux requêtes réseau par page, pas davantage.

Un modèle de sortie propre, à partir de `Resource` :

```json
{
  "id": "939725", "base": "SYRACUSE",
  "titre": "Athlétisme / Florian Gaudin-Winer",
  "auteur": "Gaudin-Winer, Florian. Auteur",
  "annee": "2014", "editeur": "Milan. Toulouse",
  "type": "Livre", "isbn": "978-2-7459-6779-4",
  "resume": "Tu aimes courir, marcher, sauter, lancer ?…",
  "url": "https://www.bm-douai.fr/Default/doc/SYRACUSE/939725/athletisme-florian-gaudin-winer",
  "couverture": "https://covers.syracuse.cloud/Cover/VDOU/MONO/T9TDK…/9782745967794/LARGE",
  "disponibilite": "1 exemplaire disponible", "disponible": true
}
```

Une implémentation de référence testée est disponible dans **`poc-api/syracuse.py`** (Python, stdlib
seule) : `search()`, `next_page()`, `get_record()`, `availability()`, `covers()`, `normalize()`,
`facet_list()`, plus un proxy CORS et une CLI. Elle vaut surtout comme documentation exécutable des
formats de requête.

---

## 15. Précautions

- **`robots.txt` du portail** : `User-agent: * → Disallow: /` (seuls Googlebot et Bingbot sont
  autorisés, ce dernier avec `Crawl-delay: 30`). Cela vise les robots d'indexation et n'a pas de
  valeur contraignante pour un usage interne au réseau, mais c'est un signal explicite que
  l'aspiration automatisée n'est pas souhaitée. **Ne pas moissonner les 307 823 notices.**
- **Mettre un cache** dans le proxy dès le POC, et espacer les appels. Les temps de réponse observés
  sont de 300 à 800 ms côté Solr — la charge n'est pas anodine.
- **API non contractuelle.** Elle fonctionne aujourd'hui et convient parfaitement à un POC ; pour une
  mise en production, l'existence de ce document est un bon argument pour demander à Archimed soit
  une validation de cet usage, soit l'ouverture d'un accès officiel (SRU/OAI-PMH, souvent disponible
  en option sur Syracuse mais non exposé ici).
- Aucun de ces appels n'écrit quoi que ce soit : tout ce qui est décrit ici est en lecture seule. Les
  endpoints d'écriture (réservation, panier, commentaires) existent mais exigent un compte lecteur et
  n'ont pas été touchés.

---
---

# Seconde campagne — 2026-09-08

*Question posée : peut-on remplacer les exports XML (`bib.xml`, `notices.xml`/`exemplaires.xml`)
par cette API, et le faire tourner sur Vercel ? Réponse courte : **non en remplacement, oui en
complément incrémental**. Le détail suit.*

---

## 16. `ILSClient.svc/GetHoldings` — le détail par exemplaire — *vérifié*

Absent du §13 faute de signature. Trouvée dans `portal-front-all.js`, fonction
`getHoldingsFullLegacy`, où le corps est passé tel quel :

```bash
grep -o 'getHoldingsFullLegacy:function(e,t){.\{0,1400\}' portal-front-all.js
```

### Requête

```http
POST /Portal/Services/ILSClient.svc/GetHoldings
Content-Type: application/json; charset=utf-8
```

```json
{"Record": {"RscId": "209546", "Docbase": "SYRACUSE"}}
```

La clé **`Record`** est obligatoire — `{"RecordId":…}`, `{"recordId":…}` et `{"Id":{…}}` renvoient
tous `success:false` avec le message générique `ILSClientService`. Une seule notice par appel :
**il n'y a pas de version batchée** (contrairement à `CheckAvailability`). C'est ce qui rend tout
moissonnage coûteux (§20).

Réponse : ~14 Ko, ~0,2 s. `d.HoldingColumns` donne les colonnes configurées côté back-office
(ici : `Site | 921$c | Section | Cote | Type | Statut | WhenBack`), et `d.Holdings[]` un objet par
exemplaire.

### Champs utiles de `Holdings[]`

| Champ | Exemple | Équivalent dans nos exports |
|---|---|---|
| `Barcode` | `"1041447"` | `995$f` / `915$b` / `Code-barres (valeur)` |
| `Cote` | `"BD MOR"`, `"D104213"` | `930$g` — **mais joint**, voir ci-dessous |
| `AlternativeCote` | `null` | — |
| `Section` / `SectionCode` | `"Jeunesse"` / `"J"` | `Section (Libellé)` / `(Code)` |
| `Site` / `SiteCode` | `"Douai Réserve Patrimoniale"` / `"VDOUC"` | `Bibliothèque (Libellé)` |
| `Statut` | `"En rayon"`, `"Exclu du prêt / non réservable, Consultation sur place"` | approximation de `Pièges` |
| `Type` | `"Livre"` | `Type de document (Libellé)` |
| `IsAvailable`, `IsLoanable`, `IsReservable`, `IsSerial` | booléens | — (donnée vivante, absente des exports) |
| `HoldingId` | `"592411"` | identifiant d'exemplaire interne |
| `RecordId` | `"209546"` | = `RscId` de la notice |
| `Other[]` | `[{Key:"921$c",Value:""}, …]` | inclut l'adresse de la bibliothèque |

**Attention à la cote** : l'API renvoie une chaîne **déjà jointe**, là où `bib.xml` l'éclate en
`Cote n° 1/2/3` (→ `930$g`/`930$h`/`930$i`). Sans conséquence pour la détection d'étage
(`magasinDigitRun()` opère de toute façon sur la cote jointe), mais on ne peut pas reconstituer le
découpage en trois champs à partir de l'API.

Le `Statut` remplace imparfaitement les pièges : c'est un **libellé d'affichage**, pas les codes
`921$a`/`$b` que `PIEGE_A_LABELS`/`PIEGE_B_LABELS` savent résoudre dans `build-inventory.mjs`.

---

## 17. Correspondance avec les données du site — *vérifié*

### Réserve : `_noticeId` = `"ARCHI"` + `RscId`

Le `001` MARC de `data/inventaire.json` est le `RscId` du portail préfixé de `ARCHI` :

| `_noticeId` (site) | `RscId` (portail) | Code-barre retrouvé | Cote API vs XML |
|---|---|---|---|
| `ARCHI1000008` | `1000008` | oui | `D104214` = `D104214` ✓ |
| `ARCHI1000019` | `1000019` | oui | `D104219-1` = `D104219-1` ✓ |
| `ARCHI1014843` | `1014843` | oui | `D104026` = `D104026` ✓ |
| `ARCHI211992` | `211992` | oui | `I-16-1566-1-1` = `I-16-1566-1-1` ✓ |
| `ARCHI955899` | `955899` | oui | `D102886` = `D102886` ✓ |

5/5, cotes strictement identiques. Les 15 518 `_noticeId` de `data/inventaire.json` portent tous
ce préfixe. **Conséquence gratuite** : l'URL publique d'une notice est reconstructible sans aucun
appel réseau —

```js
`https://www.bm-douai.fr/Default/doc/SYRACUSE/${noticeId.replace(/^ARCHI/, '')}`
```

Le slug est facultatif (HTTP 200 sans lui, vérifié). C'est le gain le moins cher de tout ce
document : une concaténation dans `js/inventaire.js`, zéro requête, zéro risque.

### Magasins : pas d'identifiant de notice — le code-barre est le seul pont

`bib.xml` ne porte **aucun identifiant de notice**. Sa propriété `Identifiant` est un identifiant
d'**exemplaire**, en bijection avec le code-barre :

| Code-barre | `Identifiant` (bib.xml) | `RscId` réel de la notice |
|---|---|---|
| `1289255` | `1000003` | `983876` |
| `1289254` | `1000010` | `1000008` |

Les valeurs sont numériquement proches, ce qui invite à la confusion — ce sont bien deux espaces
d'identifiants distincts. Propriétés complètes relevées sur `bib.xml` (400 items) : `Auteur`,
`Bibliothèque (Code|Libellé)`, `Bibliothèque d'origine`, `Bibliothèque propriétaire`,
`Code-barres (valeur)`, `Cote n° 1|2|3`, `Editeur`, `Etat  (Code|Libellé)`, `ISBN`, `ISSN`,
`Identifiant`, `Imagette`, `Piège 921$a (Code|Libellé)`, `Piège 921$b (Code|Libellé)`,
`Piège 921$c|d|e|f`, `Pièges`, `Section (Code|Libellé)`, `Titre`, `Titre : volume`,
`Titre de partie et N° de partie`, `Titre de série`, `Tome`. Aucun champ de notice.

**Conséquence pour la synchronisation** (§20) : côté magasins, on peut créer et mettre à jour un
exemplaire par son code-barre, mais on ne peut pas détecter une **disparition** (code-barre détaché
d'une notice, exemplaire supprimé). Côté réserve, `_noticeId` existe, donc les disparitions y sont
détectables.

---

## 18. Ce que l'API ne sait pas faire

Le vrai obstacle au remplacement des exports — pas CORS (§12).

### On ne peut pas chercher par code-barre

Vérifié sur le code-barre `1289254` (notice `ARCHI1000008`, « Saint Martin de Tours ») :

| Requête | Résultats |
|---|---|
| `Barcode_exact:1289254` | 0 |
| `Barcode:1289254` | 0 |
| `ItemBarcode:1289254` | 0 |
| `1289254` *(recherche libre)* | 1 — mais une **autre** notice sans rapport |

Un code-barre n'existe que dans `GetHoldings`, c'est-à-dire **une fois la notice déjà connue**.
Construire l'index code-barre → exemplaire qu'utilisent nos outils suppose donc d'appeler
`GetHoldings` sur toutes les notices, une par une (§20).

> **Ça ne casse pas le récolement.** `recolement.html:1795` résout un scan par `catalog[barcode]`,
> un accès en mémoire dans un index construit au chargement depuis `data/magasins.json` — 0 ms,
> hors ligne. La page ne fait aucune recherche. Interroger l'API à chaque scan serait de toute
> façon indésirable : 300 ms par livre, dépendance réseau dans un magasin d'étage, et charge sur
> le portail proportionnelle au travail effectué. Ce qu'il faut brancher sur l'API, ce n'est pas
> le scan — c'est la **fraîcheur du catalogue local**.

### On peut, en revanche, chercher par cote

`CallNumber_exact` fonctionne (le §7 ne le mentionnait pas ; un premier test l'avait cru cassé, à
tort — c'était un défaut d'échappement) :

| Requête | Résultats |
|---|---|
| `CallNumber_exact:"D104214"` | 1 — la bonne notice |
| `CallNumber_exact:"320.12 ZAJ"` | 1 — la bonne notice |
| `CallNumber_exact:"940.21 BER"` | 1 — la bonne notice |
| `CallNumber_exact:"A HIG ROS"` | 5 |
| `CallNumber_exact:"R GRI"` | 157 |

Les cotes littérales du 6e étage désignent un rayon, pas un livre — même ambiguïté que celle que
`buildDigitRunIndex()` gère déjà côté site en écartant les runs de chiffres non uniques. Utilisable
pour les cotes numériques 5/6 chiffres, à traiter comme une suggestion pour les cotes littérales.

### Données absentes de toute l'API

- **Les statistiques de prêt** (`Nombre de prêts AN`/`AN-1`/`AN-2`/`AN-3`/`cumulés`) — ni dans
  `Resource`, ni dans `Holdings`. C'est de la donnée de gestion, pas d'OPAC. **Rotobib et
  `desherbage-stats.html` ne sont pas migrables**, même partiellement.
- **Les liens `$481`/`$482`** — la cascade de récolement des documents reliés (178 groupes,
  703 exemplaires) ne peut pas être alimentée par l'API.
- **Les codes de piège `921$a`/`$b`** — seul le libellé `Statut` est exposé (§16).
- **Les suppressions** — aucune requête ne liste ce qui a disparu (§19).

### Bruit dans l'index

L'index contient des documents non bibliographiques : la dernière page d'une requête large a
renvoyé un `RscId` valant `"VDOUC"` (visiblement une fiche de site). Filtrer sur
`RscBase === "SYRACUSE"` et ignorer les notices sans `Holdings`.

---

## 19. Le champ `timestamp` — détection des modifications — *vérifié*

**La découverte qui change la conclusion.** Ni les facettes ni `d.Sorts` n'exposent de date de
modification, mais Solr maintient deux champs internes, tous deux interrogeables ici :

| Champ | Documents le portant |
|---|---|
| `timestamp` | 307 823 — soit **la totalité du catalogue** |
| `_version_` | 307 823 |

(Sondés en vain : `RecordUpdateDate`, `UpdateDate`, `DateOfUpdate`, `ModificationDate`,
`DateModified`, `LastUpdate`, `LastModified`, `CreationDate`, `DateOfCreation`,
`RecordCreationDate`, `IndexDate`, `EntryDate`, `DateOfAcquisition`, `DateAdded` → 0 document.
`MajDate` → 2 documents, anecdotique.)

`timestamp` accepte **les plages relatives, les dates absolues ISO 8601, le tri, et se croise avec
les filtres métier** :

```
timestamp:[NOW-1DAY TO NOW]
timestamp:[2026-09-07T00:00:00Z TO NOW]
Funds_exact:"Magasin" AND timestamp:[NOW-30DAY TO NOW]
SortField: "timestamp", SortOrder: 1     ← accepté, bien qu'absent de d.Sorts
```

### Distribution mesurée le 2026-09-08

| Fenêtre | Notices | | Fenêtre | Notices |
|---|---|---|---|---|
| 1 h | 1 | | 7 j | 31 514 |
| 24 h | 993 | | 10 j | 32 500 |
| 2 j | 1 722 | | 14 j | 37 560 |
| 3 j | 1 901 | | 30 j | 42 866 |
| 4 j | 13 994 | | 1 an | 176 404 |
| 5 j | 14 435 | | | |
| 6 j | 15 292 | | | |

Par périmètre, sur 30 jours : `Funds_exact:"Magasin"` → 7 022 ; `Funds_exact:"Réserve"` → 14 861.

**Lecture** : un bruit de fond de ~700 à 1 000 notices/jour, ponctué de **réindexations en masse**
(+12 093 entre J-3 et J-4, +16 222 entre J-6 et J-7). Sur notre périmètre, l'activité réelle
quotidienne est de l'ordre de **200 à 250 notices**.

### ⚠️ L'hypothèse qui reste à valider — voir §22

`timestamp` est la date de **réindexation Solr**, pas la date de modification de la notice. Il est
établi qu'il existe, qu'il est interrogeable et qu'il bouge. Il **n'est pas établi** :

1. qu'un changement de cote le met à jour ;
2. surtout, **au bout de combien de temps**.

Le « 1 seule notice dans la dernière heure » suggère une indexation continue plutôt qu'un batch
nocturne, ce qui est encourageant — mais si la latence d'indexation était de plusieurs heures,
« en direct » deviendrait « le lendemain » et tout l'intérêt du dispositif tomberait.
**Ne rien construire avant le protocole du §22.**

Les réindexations en masse produiront par ailleurs des **faux positifs** : des notices signalées
modifiées dont le contenu n'a pas bougé. Sans gravité (on refetch pour rien, la justesse est
préservée), à condition d'appliquer la comparaison avant écriture du §20.

---

## 20. Coûts mesurés, et pourquoi le moissonnage complet est écarté

### Poids et latences relevés

| Appel | Poids | Durée |
|---|---|---|
| `Search`, `ResultSize:50` | 978 Ko (dont **68 % de `HtmlResult`**) | ~1,5 s |
| `Search`, `ResultSize:5` | 610 Ko | ~1,6 s |
| `GetHoldings` (1 notice) | 14 Ko | ~0,2 s |

Pagination profonde : testée jusqu'à la page 857 (≈ notice 42 850), **latence stable ~1,4 s**,
dernière page correctement tronquée. Pas de dégradation en profondeur.

Infrastructure : réponses en `cache-control: no-cache, no-store`, **aucun en-tête de CDN**
(ni Cloudflare, ni Varnish), cookie `InstanceST` révélant un petit parc d'instances ASP.NET
derrière un répartiteur. **Aucun cache n'amortit nos requêtes** — chaque appel coûte réellement du
temps Solr et du temps applicatif.

### Moissonnage complet — écarté

Pour les seuls magasins (`Funds_exact:"Magasin"` 40 126 + `"Magasin Jeunesse"` 21 495 ≈ 61 621
notices) :

| | Volume |
|---|---|
| Pages `Search` @50 | 1 233 |
| Appels `GetHoldings` (1/notice, pas de batch) | 61 621 |
| **Total** | **62 854 appels** |
| Durée à 2 req/s | **8,7 h** |
| Octets `Search` seuls | **1,1 Go** |

Pour `cotes-numeriques.json`, qui balaie toute la bibliothèque, c'est bien pire. Et le `robots.txt`
du portail dit `Disallow: /`.

**Mais surtout : ce moissonnage est inutile.** `data/magasins.json` est déjà ce fichier, produit
par `bib.xml` en quelques minutes sans toucher au portail. Reconstituer par l'API ce qu'un export
donne gratuitement n'a aucun sens.

### Synchronisation incrémentale — retenue

Sur notre périmètre, ~200 à 800 notices modifiées par jour :

| | Appels | Durée |
|---|---|---|
| Découverte (`Search` @50) | ~16 | ~22 s |
| Données exemplaire (`GetHoldings`) | ~800 | ~4 min |
| **Total quotidien** | **~816** | **~4,5 min** |

Soit **1,3 % du coût du moissonnage**. À un rattrapage toutes les 5 minutes : ~3 notices par
passage, **~4 appels**, ~288 appels/jour — moins qu'une seule personne naviguant vingt minutes sur
le portail.

### Pourquoi Vercel ne peut pas héberger un moissonnage

- `vercel.json` lance `npm run build` **à chaque déploiement** : rendre l'inventaire dépendant de
  l'API, ce serait ~15 518 appels (≈ 2 h) par `git push`, contre un plafond de build de 45 min.
- Une fonction serverless plafonne à 60 s (300 s max en plan Pro). Il faut donc **découper en
  tranches avec un curseur**, jamais tout traiter d'un coup.
- Les crons Vercel sont limités à 2 déclenchements/jour en granularité journalière sur le plan
  Hobby — d'où le déclencheur « au chargement de page » retenu au §21.

---

## 21. Plan d'action proposé — synchronisation incrémentale

**Principe** : le socle vient de l'export XML (ponctuel), la fraîcheur vient de l'API (continu).

```
  export bib.xml  ──(mensuel)──►  data/magasins.json  (statique, CDN, cache IndexedDB)
                                          │
                                          ├── fusion côté client ──► pages
                                          │
  Search timestamp ──(5 min)──► GetHoldings ──► syracuse-sync.json (R2, surcouche)
```

### Pourquoi une surcouche, et pas un gros fichier patché dans R2

Déplacer `data/magasins.json` (20,8 Mo) dans R2 pour l'y modifier en place casserait deux choses :

- **En lecture** : chaque ouverture de page tirerait 20,8 Mo à travers une fonction serverless,
  sans cache CDN possible puisque le contenu devient mutable — et la clé de fraîcheur du cache
  IndexedDB (`generatedAt` de `magasins-build-report.json`) ne voudrait plus rien dire. Tout le
  bénéfice du chantier de performance du 2026-09-02 serait perdu.
- **En écriture** : `r2CasUpdate` fait lecture + réécriture complète de l'objet. Patcher trois
  notices coûterait ~40 Mo de trafic, plusieurs fois par jour.

La surcouche reprend donc **exactement le patron des exemplaires manuels**, déjà en place :
`js/exemplaires-manuels-shared.js` fusionne des enregistrements R2 par-dessus le catalogue statique
en trois endroits. Rien à inventer.

**Important** : la surcouche ne doit pas être cuite dans le cache IndexedDB, sinon un delta
n'invaliderait rien. On garde le cache statique tel quel et on applique la surcouche par-dessus au
chargement — elle est petite, c'est instantané.

### Phases

| Phase | Contenu | Bloquant ? |
|---|---|---|
| **0** | **Validation de `timestamp`** — protocole du §22 | **oui, tout en dépend** |
| 1 | `api/syracuse.mjs` : proxy lecture seule (`search`, `holdings`, `delta`), sérialisé, plafonné, avec cache R2. Aucun impact sur les pages existantes. | non |
| 2 | Clé R2 `syracuse-sync.json` via `createPatchEndpoint()` — GET public avec ETag/304, POST authentifié. Hérite du cache CDN 20 s sans code supplémentaire. | non |
| 3 | Moteur de delta : curseur `lastSync` en R2, découpage en tranches, comparaison avant écriture. | non |
| 4 | Fusion côté client, sur le modèle de `js/exemplaires-manuels-shared.js`. | non |
| 5 | Garde-fous et interrupteur d'arrêt. | non |

### Forme de `syracuse-sync.json`

```jsonc
{
  "lastSync": "2026-09-08T19:40:00Z",
  "cursor": null,                    // reprise si une tranche a été interrompue
  "records": {                       // clé = code-barre (seul pont côté magasins, §17)
    "1041447": { "cote": "BD MOR", "titre": "…", "section": "Jeunesse",
                 "site": "Douai Marceline Desbordes-Valmore", "statut": "En rayon",
                 "rscId": "209546", "ts": "2026-09-08T19:12:00Z" }
  },
  "notices": {                       // notice → ses code-barres, pour détecter les retraits
    "209546": { "barcodes": ["1041447", "…"], "ts": "2026-09-08T19:12:00Z" }
  }
}
```

Le bloc `notices` se construit **à l'usage** : la première fois qu'une notice passe dans un delta,
on note la liste de ses codes-barres ; à sa modification suivante, la comparaison révèle un retrait.
La détection des disparitions n'est donc pas rétroactive — seul le rebuild complet les rattrape.

### Règles de mise en œuvre

- **Comparer avant d'écrire.** Une réindexation en masse bouscule `timestamp` sans changer le
  contenu ; si l'enregistrement rapatrié est identique au socle, ne rien stocker. C'est ce qui
  empêche la surcouche de gonfler les jours de pic. À ~200 octets par enregistrement et ~200 à 250
  vraies modifications/jour, elle pèse ~1,4 Mo au bout d'un mois, puis le rebuild la remet à zéro.
- **Filtrer sur les sites de Douai, pas sur `Funds_exact`.** `data/magasins.json` couvre toute la
  bibliothèque de Douai (et pas seulement les magasins) pour la détection des anomalies de
  classement ; un filtre par section ferait échapper un exemplaire recatalogué ailleurs, et
  l'anomalie ne remonterait plus.
- **En série, jamais en parallèle**, ~300 ms entre deux appels. Un `Promise.all` sur 50 notices
  n'est rien en volume mais tout en pic instantané — c'est ce qui fait tomber une instance ou
  déclenche un pare-feu applicatif.
- **Un seul point de passage** (`api/syracuse.mjs`), jamais d'appel depuis le navigateur en direct :
  un seul endroit où poser cache, compteur et plafond.
- **Déclencheur : au chargement de page, pas en cron.** Quand quelqu'un ouvre `recolement.html`, on
  rattrape le delta depuis `lastSync`, avec un intervalle plancher (pas de resynchro si la dernière
  date de moins de 5 min). Ça s'autorégule, ne tourne que quand l'outil sert, et contourne la limite
  des crons Hobby.
- **Jamais dans une boucle sur le catalogue.** `forEachRow` sur `data/magasins.json`, c'est 199 583
  itérations : un `fetch` là-dedans enverrait l'équivalent de plusieurs jours de trafic normal en
  quelques minutes. C'est le seul scénario qui casserait vraiment quelque chose.
- **Interrupteur d'arrêt.** Si `timestamp:[* TO *]` renvoie 0 document, c'est que le champ a disparu
  d'une mise à jour Syracuse : couper la synchro et alerter, plutôt que de croire silencieusement
  que rien n'a changé.

### Ce que le dispositif ne remplacera pas

Le rebuild complet reste nécessaire — **mensuel au lieu de toutes les cinq minutes**, ce qui est
précisément le soulagement recherché. Il reste seul capable de rattraper les suppressions, de
régénérer `data/desherbage.json` (statistiques de prêt) et de reconstruire les groupes de reliure
`$481`/`$482`.

---

## 22. Protocole de validation — à faire en premier

Dix minutes, et tout le §21 en dépend.

1. **Choisir une notice de test** dont on connaît le code-barre, de préférence dans un magasin ou
   en réserve. Noter sa cote actuelle.
2. **Relever l'heure exacte** (UTC) avant modification.
3. **Modifier la cote dans Syracuse**, et noter l'heure de validation.
4. **Interroger périodiquement** (toutes les 5 min, puis toutes les heures) :

```json
{"query": {"QueryString": "timestamp:[NOW-1HOUR TO NOW]", "Page": 0,
           "ScenarioCode": "DEFAULT", "InitialSearch": true,
           "SearchContext": 0, "ResultSize": 50}}
```

   → la notice apparaît-elle dans les résultats, et **au bout de combien de temps** ?

5. **Confirmer la valeur** via `GetHoldings` (§16) : la nouvelle cote est-elle renvoyée ?

### Interprétation

| Observation | Conséquence |
|---|---|
| Notice détectée en quelques minutes, cote à jour | Le §21 est applicable tel quel, y compris le rattrapage à 5 min. |
| Détectée, mais après plusieurs heures | Le dispositif reste utile (export mensuel + delta quotidien), mais le « direct » est illusoire — ajuster la promesse faite à l'équipe. |
| Non détectée | `timestamp` ne suit que la réindexation en masse, pas les modifications unitaires. **Tout le §21 tombe** ; il ne reste que la consultation ponctuelle par cote (§18) et le lien vers la notice (§17). |

Refaire aussi le test sur une **création** d'exemplaire et sur une **suppression**, les trois cas
n'ayant aucune raison de se comporter pareil.
