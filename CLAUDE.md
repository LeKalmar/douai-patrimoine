# Réserve patrimoniale — Bibliothèques de Douai

Site public (statique, déployé sur Vercel) de la Réserve patrimoniale du
réseau des Bibliothèques de Douai-Cuincy, + quelques outils internes pour
l'équipe (récolement, plan de la réserve, analyse des cotes, préparation de
scans).

Aucun framework, aucune dépendance npm : HTML/CSS/JS servis tels quels
(`vercel.json` : `outputDirectory: "."`, `framework: null`). Un script Node
(`scripts/build-inventory.mjs`) tourne au build pour générer les données du
catalogue, et quelques fonctions serverless Vercel sous `api/` (toujours
zéro dépendance npm — signature R2/S3 écrite à la main, voir
`lib/r2.mjs`) servent de proxy d'écriture vers Cloudflare R2 pour la
synchronisation partagée du récolement et des livres spoliés (détails plus
bas, section « Stockage partagé »).

## Démarrer / builder

- `npm run build` — régénère `data/inventaire.json` et
  `data/build-report.json` à partir des exports Syracuse MARC-XML
  (`data/xml/notices.xml` + `data/xml/exemplaires.xml`). Le build est
  **strict** : il échoue si un fichier manque, si 0 notice n'est extraite,
  ou si le taux de jointure notice/exemplaire est catastrophique.
  `npm run build:force` (`SYRACUSE_FORCE=1`) pour forcer malgré les
  anomalies. Si les variables R2 sont configurées (voir plus bas), ces deux
  fichiers XML sont d'abord rapatriés depuis R2 avant le build.
- `npm run upload:xml` — pousse `data/xml/notices.xml` et
  `data/xml/exemplaires.xml` vers R2 (à lancer après chaque nouvel export
  Syracuse, pour ne pas avoir à committer ces fichiers de plusieurs dizaines
  de Mo). `npm run test:r2` vérifie qu'un token R2 fonctionne (PUT/GET/DELETE
  sur une clé de test), sans toucher aux données réelles.
- Aucun serveur de dev fourni — ouvrir les `.html` directement ou servir le
  dossier avec n'importe quel serveur statique (`python3 -m http.server`,
  etc.). Attention : les pages qui font `fetch()` (quasiment toutes) ont
  besoin d'un vrai serveur HTTP, pas d'un simple `file://`.

## Pages du site (racine)

| Fichier | Rôle | Public / interne |
|---|---|---|
| `index.html` | Page d'accueil — hero, carrousel d'expositions, accordéon (Venir consulter / Trouver un document), modale de connexion espace pro | Public |
| `histoire-du-livre.html` | Exposition cartographique interactive « 500 ans d'histoire des métiers du livre » (utilise `js/main.js` + `css/main.css`, MapLibre 3.6.2) | Public |
| `visionneuse.html` | Visionneuse de documents numérisés, pilotée par `js/manifest.json` (générée par `generer_manifest.html`). Accessible via `?dossier=...` depuis l'inventaire | Public |
| `admin.html` | Tableau de bord de l'espace professionnel (stats de build, liens vers les outils et fichiers sources) | **Protégé** (voir Sécurité) |
| `recolement.html` | Outil de scan de codes-barres pour localiser les documents (travée/colonne/étage) dans la réserve. Partage `js/reserve-shared.js` avec `reserve.html` | **Protégé** |
| `reserve.html` | Plan interactif de la réserve (travées/colonnes/armoires) avec taux d'occupation calculé depuis `data/recolement.json` | **Protégé** |
| `analyse-cotes.html` | Détection des trous, doublons et disponibilités dans les cotes, à partir de `data/inventaire.json` | **Protégé** |
| `scan-docs.html` | Rognage et renommage par cote des images scannées avant intégration au fonds numérisé (zxing-wasm pour lire les codes-barres) | **Protégé** |
| `generer_manifest.html` | Génère `js/manifest.json` à partir d'un CSV — outil ponctuel, non lié dans la navigation (accès direct par URL uniquement) | **Protégé** |

`_archive/` contient des pages retirées du site actif (voir
`_archive/README.md`) — ne rien y lier depuis une page live sans vérifier
leurs chemins et dépendances au préalable.

## Deux systèmes de style distincts

- **`style.css`** (racine, ~2200 lignes) : design system principal
  (variables `--ink`, `--warm`, `--accent`…), utilisé par la quasi-totalité
  des pages. `inventaire-thumbnail.css` vient en complément pour les
  vignettes du catalogue (utilisé par `index.html`).
- **`css/main.css`** : design system séparé (variables `--color-primary`,
  `--color-accent`…), utilisé **uniquement** par `histoire-du-livre.html`
  (page d'exposition avec son propre habillage). Ne pas fusionner ces deux
  fichiers sans intention explicite — ils ne partagent aucune classe.
- Beaucoup de CSS/JS reste inline dans des balises `<style>`/`<script>` en
  bas de page plutôt que dans des fichiers séparés (`admin.html`,
  `inventaire.html`, `generer_manifest.html`, `scan-docs.html`…). C'est
  l'état actuel du projet, pas un bug — à garder en tête en cas de
  recherche de sélecteurs/fonctions : elles ne sont pas forcément dans
  `js/` ou `css/`.

## Flux de données

```
Export Syracuse (MARC-XML)
  data/xml/notices.xml + data/xml/exemplaires.xml
        │  npm run build (scripts/build-inventory.mjs)
        ▼
  data/inventaire.json + data/build-report.json
        │  fetch()
        ▼
  js/inventaire.js  (catalogue : recherche, filtres, fiches par fonds)
        │  utilisé par
        ▼
  index.html (accordéon « Trouver un document »)   +   analyse-cotes.html
```

Le récolement (`recolement.html`) écrit dans le `localStorage` du navigateur
(source de vérité locale, fonctionne hors ligne) et synchronise
automatiquement chaque changement vers l'état partagé en R2 via
`/api/recolement` (voir « Stockage partagé » ci-dessous) ; `reserve.html`
lit en priorité ce même `/api/recolement` (mis à jour en direct pour tous
les collègues), avec repli sur le fichier `data/recolement.json` committé
si l'API est indisponible. Les deux pages partagent la géométrie de la
réserve (travées, colonnes, armoires) via `js/reserve-shared.js`.

Dans `recolement.html`, le mode (bouton « Code-barre » = scan, ou
« À cataloguer » = comptage de non-catalogués) et le type d'emplacement
(menu déroulant « Étagère » / « Armoire » / « Tiroir », juste après le choix
de réserve) sont deux axes indépendants (`loc.mode` / `loc.locType`) — les
deux modes sont utilisables sur les trois types d'emplacement. Les armoires
et les tiroirs sont modélisés dans `js/reserve-shared.js` comme des
pseudo-travées à une seule entrée (`EMPLACEMENTS_ARMOIRE`,
`EMPLACEMENTS_TIROIR` — colonne = quel meuble, étage = tiroir/niveau dans ce
meuble) plutôt que comme des meubles nommés individuellement : ça permet de
réutiliser telle quelle toute la mécanique des travées (stepper
colonne/étage, rendu du plan, calcul d'occupation) des deux côtés. Ne
recommencez pas à ajouter un système de meubles nommés séparé sans relire
d'abord cette partie du code (uniquement dans la réserve patrimoniale ; le
menu déroulant se désactive automatiquement sur « Réserve Douaisienne »).

`data/recolement.json` regroupe en un seul fichier quatre catégories de
données produites par `recolement.html` (un seul bouton « Exporter le
récolement », un seul export/import à gérer) :
`{ scans:[...], nonCatalogues:[...], videShelves:[...], nonRangeShelves:[...] }`.
`videShelves` sert à marquer explicitement qu'une étagère est vide (aucun
livre, catalogué ou non) — utile car le nombre d'étagères réelles par
colonne varie (jusqu'à `maxEt` défini par travée dans
`js/reserve-shared.js`, mais pas toujours atteint) et une étagère vide peut
se trouver au milieu d'étagères remplies ; sans ce marquage, une étagère
sans aucun scan au-delà du dernier scan serait simplement absente du
calcul de `maxEt` par colonne dans `reserve.html`. `nonRangeShelves` sert à
marquer un emplacement contenant des documents de natures différentes en
désordre, impossibles à compter facilement — distinct de « vide » (les
deux boutons dans `recolement.html` sont mutuellement exclusifs : marquer
l'un efface l'autre sur le même emplacement). Les anciens exports au
format « tableau plat de scans » restent lus correctement (import et
chargement dans `reserve.html`), pour ne pas casser d'anciens fichiers en
circulation. C'est exactement cette même forme qui est stockée dans R2 sous
la clé `recolement.json` (voir « Stockage partagé » ci-dessous) — l'export
manuel produit toujours un fichier au même format, utile pour figer un
instantané daté.

Le code couleur du plan (`reserve.html`) est catégoriel, pas un dégradé de
densité : chaque emplacement (travée/colonne/étage, ou meuble/étage pour
armoires et tiroirs) est classé en **catalogué** (bleu, au moins un
exemplaire catalogué via `scans`), **non catalogué** (ambre, aucun
catalogué mais un comptage `nonCatalogues` > 0), **non rangé** (violet,
marqué via `nonRangeShelves`), **vide confirmé** (vert, marqué via
`videShelves`) ou **non inventorié** (gris, aucune des quatre données
ci-dessus) — dans cet ordre de priorité (`slotState()` dans
`reserve.html`). Il n'y a volontairement pas de code couleur par quantité
de livres (impossible à estimer sans mesurer chaque reliure) ; la quantité
reste visible via la largeur des barres et les compteurs dans le panneau
de détail, mais jamais via la couleur.

`histoire-du-livre.html` est indépendante de ce flux : elle charge ses
propres CSV (`csv/Professionnels.csv`, `Individus.csv`, `Documents.csv`,
`Lieux.csv`, `Imprimeries.csv`, `periodiques.csv`, `auteurs.csv`) via
`js/main.js` pour peupler la carte MapLibre.

## Stockage partagé (Cloudflare R2) et fonctions serverless

Bucket R2 `douai-patrimoine` (compte Cloudflare de l'utilisateur), utilisé
pour deux choses indépendantes :

- **`xml/notices.xml`, `xml/exemplaires.xml`** : copie des exports Syracuse
  bruts, poussée par `npm run upload:xml` après chaque nouvel export. But :
  ne plus committer ces fichiers (60+ Mo à eux deux) dans git à chaque
  refresh. `scripts/build-inventory.mjs` les rapatrie automatiquement dans
  `data/xml/` avant de builder si les variables R2 sont présentes ; sinon
  (dev local sans `.env`), comportement d'origine inchangé — lecture des
  fichiers locaux, échec strict s'ils manquent.
- **`recolement.json`, `livres-spolies-overrides.json`** : état partagé
  canonique de `recolement.html` / `livres-spolies.html`, pour que plusieurs
  collègues avancent en même temps sans export/import JSON manuel. Chaque
  page garde le `localStorage` comme source de vérité locale (fonctionne
  hors ligne, file d'attente `rp_*_pending_sync` rejouée à la reconnexion)
  et envoie en plus chaque changement en arrière-plan.

Deux fonctions Vercel (`api/recolement.mjs`, `api/spolies.mjs`) servent de
proxy vers R2 : `GET` renvoie l'état courant (public, même niveau
d'exposition que `data/recolement.json` aujourd'hui) ; `POST` reçoit un
« patch » unitaire (ex. `{type:'scan', record}` ou `{id, field, value}`) et
le fusionne côté serveur via lecture+ETag+réécriture conditionnelle
(`r2CasUpdate` dans `lib/r2.mjs`, compare-and-swap avec retry) — jamais un
écrasement complet du fichier, pour qu'un scan pris par un collègue au même
instant ne soit pas perdu. `reserve.html` lit `/api/recolement` en priorité
(rafraîchi toutes les 25 s), avec repli sur `data/recolement.json` si l'API
échoue.

Le client R2/S3 (`lib/r2.mjs`) signe les requêtes en SigV4 à la main avec
`node:crypto`/`node:https` — pas de `@aws-sdk/client-s3`, pour rester
cohérent avec le "zéro dépendance npm" du reste du projet. Variables
d'environnement requises (Vercel + `.env` local, jamais commitées,
`.env` est dans `.gitignore`) : `R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, plus `ADMIN_USER`/`ADMIN_PASS`
(mêmes valeurs que les constantes en clair dans `index.html`, mais lues
côté serveur pour authentifier les `POST` — voir Sécurité ci-dessous).
Si ces variables sont absentes, tout le reste du site continue de
fonctionner à l'identique (repli local partout), seule la synchronisation
partagée est inactive. `npm run test:r2` permet de vérifier un token sans
toucher aux données réelles.

## Sécurité — à savoir avant de toucher à l'espace pro

L'« espace professionnel » n'a **aucune vraie protection serveur au niveau
des pages** — les pages elles-mêmes restent 100 % statiques :

- Les identifiants (`ADMIN_USER` / `ADMIN_PASS`) sont **en clair dans le
  JavaScript de `index.html`**, visibles par n'importe qui via « voir le
  code source ».
- Le contrôle d'accès des pages protégées n'est qu'un test
  `sessionStorage.getItem('rp_admin_auth') === '1'` — contournable
  trivialement dans la console du navigateur, sans même connaître le mot
  de passe.

Nuance depuis l'ajout du stockage partagé R2 (voir section ci-dessus) : il
existe désormais un vrai composant serveur, `api/recolement.mjs` et
`api/spolies.mjs`, mais son rôle est étroit — il ne protège pas l'accès aux
*pages*, seulement l'**écriture** dans l'état partagé. Un `POST` vers ces
endpoints exige un en-tête `Authorization: Basic` vérifié côté serveur
contre `ADMIN_USER`/`ADMIN_PASS` (variables Vercel, `lib/auth.mjs`) — donc
contourner le gate client de `sessionStorage` (comme ci-dessus) ne suffit
plus à corrompre les données partagées, il faut réellement connaître le mot
de passe. La lecture (`GET`) reste volontairement publique, au même niveau
d'exposition que `data/recolement.json` aujourd'hui.

Ce qui a été fait dans le cadre du nettoyage (2026-07-23) : ajout du
contrôle `sessionStorage` manquant sur `reserve.html`, `scan-docs.html` et
`generer_manifest.html` (cohérence avec `recolement.html`/
`analyse-cotes.html`), et ajout de `<meta name="robots" content="noindex,
nofollow">` sur toutes les pages de l'espace pro pour éviter leur
indexation.

Ce qui n'a **pas** été corrigé, car c'est une décision produit et non un
simple nettoyage : le mot de passe reste en clair et le "gate" reste
côté client, donc ce n'est qu'une barrière anti-curieux, pas une vraie
sécurité. Sur un site 100 % statique, les options réalistes pour une vraie
protection sont : Vercel Deployment/Password Protection (plan payant), une
fonction serverless Vercel (`/api/login`) qui vérifie les identifiants
côté serveur et pose un cookie de session, ou accepter l'état actuel et le
documenter clairement (ce que fait cette section). Ne pas supposer que
l'accès à ces pages est sécurisé.

## Pièges connus / historique

- `js/geojson/douai-biblioth#U00e8ques.js` a été supprimé (2026-07-23) :
  doublon exact de `js/geojson/douai-bibliothèques.js` avec un nom de
  fichier corrompu (encodage `#U00e8` littéral), jamais référencé.
- `csv/Imprimeries.txt` a été supprimé (2026-07-23) : brouillon antérieur
  de `csv/Imprimeries.csv`, jamais référencé dans le code.
- Dans `js/inventaire.js`, une constante `JSON_PATH` existait mais n'était
  pas utilisée par le `fetch()` réel (qui codait le chemin en dur, avec en
  plus une valeur différente et incorrecte dans la constante). Corrigé
  (2026-07-23) : `JSON_PATH` vaut maintenant `'data/inventaire.json'` et le
  `fetch()` s'en sert.
- `index.html` avait autrefois une section « Collections thématiques »
  (accordéon avec 7 cartes) qui a été retirée ; les pages correspondantes
  sont maintenant dans `_archive/thematiques/`.
