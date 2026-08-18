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
  fichiers XML sont d'abord rapatriés depuis R2 avant le build. Les stats du
  rapport incluent `reservePatrimoniale`/`reserveDouaisienne` (répartition
  des exemplaires par réserve **physique**, déterminée par le préfixe de
  cote `930$g`, même ordre de test que `FONDS_PREFIXES` dans
  `js/inventaire.js` mais avec un mapping différent et contre-intuitif :
  sont physiquement en Réserve Douaisienne les fonds Douaisien (`D`),
  Littérature (`L`), Protestantisme (`P`) et Mines (`MIN`) — le fonds
  *nommé* « Réserve Douaisienne » (préfixe `RD`) n'y est **pas** physiquement
  ; il est en Réserve patrimoniale avec Livres d'Artiste (`LIVA`), Imprimés
  (`I`) et tout le reste. Voir `PHYSICAL_RESERVE_PREFIXES` dans
  `scripts/build-inventory.mjs` — ne pas se fier au nom du fonds pour
  déduire l'emplacement physique.
- `npm run upload:xml` — pousse `data/xml/notices.xml` et
  `data/xml/exemplaires.xml` vers R2 (à lancer après chaque nouvel export
  Syracuse, pour ne pas avoir à committer ces fichiers de plusieurs dizaines
  de Mo). `npm run test:r2` vérifie qu'un token R2 fonctionne (PUT/GET/DELETE
  sur une clé de test), sans toucher aux données réelles.
- `npm run build:magasins` — régénère `data/magasins.json` et
  `data/magasins-build-report.json` à partir d'un export Syracuse séparé
  (magasins du 2e/5e étage), toujours récupéré depuis R2 (pas de repli
  local committé, contrairement à `npm run build`). Voir « Magasins 2e/5e
  étage » plus bas. Le parseur MARC-XML est partagé entre les deux scripts
  de build via `scripts/lib/marc-xml.mjs`.
- Avant d'écraser `data/build-report.json` ou `data/magasins-build-report.json`,
  chaque script archive la version précédente dans un fichier `-previous.json`
  du même nom (un seul niveau d'historique, écrasé au build suivant). Sert à
  afficher dans `admin.html` un delta de documents (« +N depuis l'export
  précédent ») entre les deux derniers exports Syracuse de chaque source.
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
| `admin.html` | Tableau de bord de l'espace professionnel (état de l'inventaire par réserve, liens vers les outils regroupés par thème) — pas de téléchargement de fichiers sources depuis cette page | **Protégé** (voir Sécurité) |
| `recolement.html` | Outil de scan de codes-barres pour localiser les documents (travée/colonne/étage) dans la réserve. Partage `js/reserve-shared.js` avec `reserve.html` | **Protégé** |
| `reserve.html` | Plan interactif de la réserve (travées/colonnes/armoires) avec taux d'occupation calculé depuis `data/recolement.json` | **Protégé** |
| `analyse-cotes.html` | Détection des trous, doublons et disponibilités dans les cotes, à partir de `data/inventaire.json` | **Protégé** |
| `magasins.html` | Catalogue des exemplaires du 2e/5e étage (recherche, tri, pagination), à partir de `data/magasins.json` — voir « Magasins 2e/5e étage » | **Protégé** |
| `cotes-numeriques.html` | Repérage, dans un export complet et séparé de toute la bibliothèque, des exemplaires à cote numérique 5/6 chiffres (recherche, tri, export .txt des codes-barres pour ajout panier SIGB), à partir de `data/cotes-numeriques.json` — voir « Cotes numériques » | **Protégé** |
| `exemplarisation.html` | Création rapide d'exemplaires (titre, auteur, date, cote, code-barre, emplacement, photo — tout en un seul formulaire) sans notice bibliographique complète — voir « Exemplarisation rapide » | **Protégé** |
| `reliures.html` | Création manuelle de groupes de documents reliés ensemble (équivalent $481/$482) et détection des groupes dont les emplacements récolés ne concordent pas — voir « Récolement en cascade des documents reliés » | **Protégé** |
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

Dans `recolement.html`, le scan de code-barre et le comptage de
non-catalogués sont affichés ensemble, au même endroit (plus d'onglet à
basculer entre les deux — supprimé le 2026-08-14 : les deux outils sont
utilisables sans changer de mode). Seul le type d'emplacement (menu
déroulant « Étagère » / « Armoire » / « Tiroir », juste après le choix de
réserve, `loc.locType`) reste un axe séparé de la réserve/travée
sélectionnée ; le comptage de non-catalogués reste masqué en mode « Non
rangé (hors réserve) », qui n'a pas d'emplacement précis auquel le
rattacher. Les armoires et les tiroirs sont modélisés dans
`js/reserve-shared.js` comme des
pseudo-travées à une seule entrée (`EMPLACEMENTS_ARMOIRE`,
`EMPLACEMENTS_TIROIR` — colonne = quel meuble, étage = tiroir/niveau dans ce
meuble) plutôt que comme des meubles nommés individuellement : ça permet de
réutiliser telle quelle toute la mécanique des travées (stepper
colonne/étage, rendu du plan, calcul d'occupation) des deux côtés. Ne
recommencez pas à ajouter un système de meubles nommés séparé sans relire
d'abord cette partie du code (uniquement dans la réserve patrimoniale ; le
menu déroulant se désactive automatiquement sur « Réserve Douaisienne »).

`data/recolement.json` regroupe en un seul fichier six catégories de
données produites par `recolement.html` (un seul bouton « Exporter le
récolement », un seul export/import à gérer) :
`{ scans:[...], nonCatalogues:[...], videShelves:[...], nonRangeShelves:[...],
lastShelves:[...], resolvedIssues:[...] }`.
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
l'un efface l'autre sur le même emplacement). `lastShelves` (bouton
« Marquer comme dernière étagère de cette colonne ») marque, par colonne
et non par étage (clé `travee|colonne`, sans étage), que la colonne
s'arrête réellement à l'étage courant — sert de plancher à `maxEtageOf()`
dans `reserve.html` à la place du `maxEt` par défaut de la travée, pour
qu'une colonne physiquement plus courte que les autres n'affiche plus de
placeholder « non inventorié » au-delà de son dernier étage réel ; si des
données réelles (scan, non-catalogué, vide, non rangé) existent malgré
tout au-delà de l'étage marqué, `maxEtageOf()` s'étend quand même jusqu'à
elles plutôt que de les faire disparaître. Les anciens exports au
format « tableau plat de scans », ou sans `lastShelves`, restent lus
correctement (import et chargement dans `reserve.html`), pour ne pas
casser d'anciens fichiers en circulation. C'est exactement cette même
forme qui est stockée dans R2 sous la clé `recolement.json` (voir
« Stockage partagé » ci-dessous) — l'export manuel produit toujours un
fichier au même format, utile pour figer un instantané daté.

Le code couleur du plan (`reserve.html`) est catégoriel, pas un dégradé de
densité : chaque emplacement (travée/colonne/étage, ou meuble/étage pour
armoires et tiroirs) est classé en **catalogué** (bleu, au moins un
exemplaire catalogué via `scans` avec une vraie notice Syracuse — voir
`catalog[bc].manuel` plus bas), **exemplarisé rapide** (orange, aucun
catalogué mais au moins un scan dont le code-barre vient d'un exemplaire
créé via `exemplarisation.html`, pas une notice Syracuse), **non catalogué**
(rouge, ni catalogué ni exemplarisé rapide mais un comptage
`nonCatalogues` > 0), **non rangé** (violet, marqué via `nonRangeShelves`),
**vide confirmé** (vert, marqué via `videShelves`) ou **non inventorié**
(gris, aucune des données ci-dessus) — dans cet ordre de priorité
(`slotState()` dans `reserve.html`, `miniSlotState()` dans
`recolement.html` pour le mini-plan). Quand plusieurs catégories coexistent
sur le même emplacement (ex. un exemplaire catalogué + un exemplarisé
rapidement + une estimation de non catalogués sur la même étagère), la
couleur est un dégradé proportionnel aux trois quantités plutôt que de
masquer entièrement les parts minoritaires (`gradientOf()` /
`miniGradientOf()`). Il n'y a volontairement pas de code couleur par
quantité de livres (impossible à estimer sans mesurer chaque reliure) ; la
quantité reste visible via la largeur des barres et les compteurs dans le
panneau de détail, mais jamais via la couleur globale d'un emplacement.

Récolement en cascade des documents reliés ensemble (2026-08-14) : certains
exemplaires catalogués séparément (barcode et cote propres) sont en réalité
reliés dans un même volume physique (recueils factices — courant pour les
brochures/édits anciens, ex. un groupe de 111 édits et arrêts royaux du
XVIIIe reliés en un seul volume). Syracuse encode ce lien via les champs
MARC `$481` (« aussi relié dans ce volume ») et `$482` (« relié à la suite
de »), sous-champ `$3` = numéro de contrôle (`001`) de l'autre notice.
`indexNotices()` dans `scripts/build-inventory.mjs` construit un graphe non
orienté à partir de ces deux champs (peu importe le sens — en pratique les
deux ne sont pas symétriques : la plupart des notices ne portent que l'un
des deux) et calcule ses composantes connexes (Union-Find), pour regrouper
même des reliures à plus de deux documents. Chaque exemplaire d'un groupe
de ≥ 2 barcodes reçoit un champ `_relies` (liste des autres barcodes du même
volume) dans `data/inventaire.json`. Côté `recolement.html`, `catalog[bc].relies`
reprend ce champ, et `handleScan()` appelle `applyReliureCascade()` juste
après avoir enregistré le scan principal : elle récole automatiquement tous
les barcodes de `relies` au même emplacement (même `travee`/`colonne`/`etage`),
sans attendre qu'on les scanne un par un — chaque scan synthétique porte un
champ `viaReliure:<barcode scanné>` pour rester distinguable d'un vrai scan
physique (badge 🔗 dans les logs « ici »/« tous les scans », note dans le
panneau de feedback). Scanner N'IMPORTE LEQUEL des membres d'un groupe
récole tout le groupe — pas besoin d'identifier lequel est le « principal ».

Rattrapage rétroactif : `scripts/backfill-reliure.mjs` (`--apply` pour
écrire, sinon dry-run) applique la même logique a posteriori sur l'état
partagé R2 déjà accumulé avant l'introduction de la cascade — pour chaque
groupe, si au moins un membre est déjà récolé et que d'autres membres ne le
sont pas encore, ces derniers reçoivent un scan synthétique au même
emplacement (patch `bulkMerge` vers `recolement.json`, jamais d'écrasement
d'un scan existant). Si les membres déjà scannés d'un même groupe sont à des
emplacements DIFFÉRENTS, le script ne tranche pas tout seul : il liste le
groupe en conflit pour vérification manuelle (lien $481/$482 mal posé côté
catalogue, ou erreur de récolement/reliure physique changée depuis le
catalogage). À relancer après tout rattrapage significatif d'un futur export
Syracuse qui introduirait de nouveaux groupes déjà partiellement récolés.
Lancé une première fois le 2026-08-14 sur les 178 groupes détectés à cette
date : 167 scans rétroactifs ajoutés, 11 groupes laissés en conflit (voir
« Groupes en conflit » sur `reliures.html`, ci-dessous, pour un suivi qui
reste à jour au lieu d'un rapport figé).

Groupes créés à la main (`reliures.html`, 2026-08-14) : les liens $481/$482
viennent du SIGB et ne couvrent que ce qui a déjà été exporté — pour relier
deux documents catalogués séparément qu'on découvre reliés physiquement en
réserve sans attendre un prochain export Syracuse, `reliures.html` permet de
créer ces groupes à la main. Stockés dans R2 sous la clé
`reliures-manuelles.json` (`{ groups: { [principalBarcode]: {principal,
members:[barcode,...], ts} }, ignoredSuggestions: { [signature]: {signature,
base, barcodes, ts} } }` — voir « Groupes potentiels » ci-dessous pour
`ignoredSuggestions` ; `api/reliures-manuelles.mjs` normalise à la volée
l'ancien format à plat `{ [principal]: group }` s'il en retrouve un — même
patron GET public/POST authentifié/compare-and-swap que le reste), fusionnés
côté client dans `catalog[bc].relies` par `js/reliures-manuelles-shared.js`
(`applyManualReliureGroups()`, lit `state.groups`), en plus des groupes
Syracuse (`_relies`) déjà présents — sans distinction ensuite entre les deux
sources : la cascade dans `recolement.html` traite les deux de façon
identique. Un même barcode n'appartient qu'à un seul groupe à la fois
(appartenance exclusive, appliquée côté serveur dans `applyPatch()` du patch
`addMember` : ajouter un membre à un groupe le retire automatiquement de
tout autre groupe où il figurait déjà). `reliures.html` affiche aussi en
direct les « groupes en conflit » (membres déjà récolés à des emplacements
différents, toutes sources confondues, recalculé à chaque scan/suppression
plutôt que figé comme le rapport du script de rattrapage) — même algorithme
que `scripts/backfill-reliure.mjs` (union-find sur `_relies` +
`reliures-manuelles.json`, comparaison des emplacements des membres déjà
présents dans `/api/recolement`), réimplémenté côté client faute de pouvoir
partager du code entre un script Node et une page statique sans bundler.

Groupes potentiels détectés dans les cotes (`reliures.html`, 2026-08-14,
panneau « Groupes potentiels détectés dans les cotes ») : suggère des
groupes que $481/$482 n'ont pas captés, à partir de la forme de la cote
plutôt que du catalogage — dans le fonds Imprimés, une cote de base
(`I-d-19-1855`) suivie d'un suffixe `-N`, `-N bis/ter/quater` ou `-N/M`
indique souvent (pas toujours) un document trouvé avec un autre document
partageant la même base. `coteBase()` dans `reliures.html` retire ce dernier
suffixe (regex `COTE_SUFFIX_RE`) ; tous les barcodes du catalogue partageant
la même base forment une suggestion, sauf si un groupe existant (Syracuse ou
manuel) les couvre déjà entièrement. **Compromis précision/rappel assumé et
mesuré empiriquement (2026-08-14) sur l'export courant** : ce motif capture
123 des 178 groupes $481/$482 réels (69 % de rappel) mais génère aussi 1399
suggestions qui n'ont *aujourd'hui* aucun groupe confirmé correspondant — la
plupart sont probablement du bruit (une cote qui se termine par `-N` est
aussi, tout simplement, la forme *normale* d'une cote complète, sans que ça
implique une reliure commune ; une variante restreinte aux seuls suffixes
bis/ter/fraction tombe à 2/178 de rappel, donc écartée). Volontairement
traité comme une liste à trier par un humain, pas une détection fiable :
panneau replié par défaut et rendu paresseux (le calcul ne se fait qu'à
l'ouverture — inutile de payer le coût pour ~1400 entrées à chaque scan),
paginé (`SUGG_PAGE_SIZE = 20`), triable/filtrable par cote ou code-barre.
Chaque suggestion propose soit de créer le groupe (premier membre, trié par
`compareCotes`, pris comme principal — modifiable ensuite via « Reprendre »
dans le tableau des groupes), soit de l'écarter (bouton « ✕ Ignorer cette
suggestion ») : l'écart est mémorisé dans `ignoredSuggestions`, clé =
barcodes du groupe suggéré triés et joints par `|` — stable d'un rebuild à
l'autre (indépendant de `_relies`, donc un `npm run build` ou un nouveau
récolement ne fait pas réapparaître une suggestion déjà écartée), mais si la
composition du groupe suggéré change (un nouveau document apparaît sous la
même base), la signature change aussi et la suggestion redevient « neuve »
volontairement — considéré comme un cas réellement différent à rejuger, pas
une réapparition d'un bruit déjà tranché. Chaque suggestion affiche, pour
chacun de ses membres, son emplacement s'il a déjà été scanné dans le
récolement courant (`/api/recolement`) — sert à aller vérifier physiquement
le volume repéré plutôt que de le chercher à l'aveugle dans toute la
réserve ; les suggestions dont au moins un membre est déjà localisé sont
triées en premier.

Le flag `manuel` qui distingue « exemplarisé rapide » de « catalogué »
circule ainsi : `js/exemplaires-manuels-shared.js` pose `_manuel:true` sur
chaque enregistrement converti → le fetch du `catalog` dans
`recolement.html` le recopie en `catalog[bc].manuel` → `handleScan()` le
recopie sur chaque `record` de `scans` (`manuel: cat ? !!cat.manuel : …`,
même logique que pour `cote`/`titre`/`auteur`) → `parseRecolement()` dans
`reserve.html` (et `buildLocalSlotState()` dans `recolement.html` pour le
mini-plan) sépare `CNT` (vraiment catalogués) de `CNT_MANUEL` en se basant
sur ce flag. Un exemplaire créé avec emplacement directement depuis
`exemplarisation.html` pose aussi `manuel:true` sur le patch `scan` qu'il
envoie à `/api/recolement`, sans attendre un premier rescan physique.

Les « Statistiques avancées du récolement » (bas de `recolement.html`)
listent trois catégories de problèmes, chacune dans un `<details>` repliable
(rendu paresseux — le tableau détaillé n'est reconstruit que si le panneau
est ouvert, pour ne pas payer le coût DOM à chaque scan — et paginé,
`ADV_PAGE_SIZE` lignes par page avec Précédent/Suivant, plutôt qu'un plafond
qui tronquerait la liste : la catégorie « jamais scannés » peut compter
plusieurs milliers d'entrées) : **codes-barres endommagés** (`scans`
avec `barcodeAbime:true`, saisis à la main faute de pouvoir être scannés),
**scannés non catalogués** (un scan (`scans`, avec une cote saisie via le
champ « Renseigner » du feedback faute de correspondance au moment du scan)
dont le code-barre reste absent du `catalog` *actuel* — comparaison en
direct à chaque rendu, pas figée sur les `titre`/`auteur` enregistrés au
moment du scan : un exemplaire sort tout seul de cette liste dès qu'un
nouvel export Syracuse le fait apparaître dans le catalogue — ex. correction
d'une mauvaise localisation côté SIGB — sans avoir besoin de le rescanner ;
à distinguer des exemplaires `manuel` d'`exemplarisation.html`, exclus via
leur flag `manuel`) et **jamais scannés** (différence entre les
codes-barres de `catalog` et ceux de `scans` — potentiellement perdus, ou
récolement pas encore fait sur cet exemplaire). Chaque panneau a un bouton
d'export (`.txt`, un code-barre par ligne, respectant la recherche et
la case « Afficher aussi les réglés » en cours) et, par ligne, un bouton
✓ Réglé/↺ Rouvrir qui bascule un flag dans `resolvedIssues` (clé composite
`categorie|barcode` — un même code-barre peut apparaître réglé dans une
catégorie et pas dans une autre) sans toucher aux données sous-jacentes : ça
ne fait que retirer l'entrée des compteurs et de la liste par défaut, le
vrai traitement (rescanner, cataloguer…) reste à faire séparément. Ce flag
est synchronisé vers R2 comme le reste (patch `resolveIssue` dans
`api/recolement.mjs`), pour qu'un problème réglé par un·e collègue
disparaisse aussi chez les autres.

`histoire-du-livre.html` est indépendante de ce flux : elle charge ses
propres CSV (`csv/Professionnels.csv`, `Individus.csv`, `Documents.csv`,
`Lieux.csv`, `Imprimeries.csv`, `periodiques.csv`, `auteurs.csv`) via
`js/main.js` pour peupler la carte MapLibre.

## Magasins 2e/5e étage (catalogue filtré)

`magasins.html` (2026-07-24) donne un catalogue navigable (recherche, tri,
pagination) des collections des magasins du 2e et 5e étage, à partir d'un
export Syracuse séparé de celui de la réserve (`xml/magasin/notices.xml.xml`
et `xml/magasin/exemplaires.xml.xml` sur R2, récupérés par
`scripts/build-magasins.mjs` → `data/magasins.json` +
`data/magasins-build-report.json`). Ce flux est indépendant de
`npm run build` / `data/inventaire.json` : lancez `npm run build:magasins`
séparément après un nouvel export.

Problème d'origine : cet export mélange dans les mêmes fichiers XML les
ouvrages du 2e/5e étage **et** ceux du 6e étage — impossible à distinguer à
l'export. `build-magasins.mjs` les sépare a posteriori à partir de la cote
de l'exemplaire (`930$g`, éventuellement suivi de `930$h`) :

- **2e/5e étage** (à garder) : cotes à numérotation séquentielle de 5 ou 6
  chiffres — `100350`, `156235` — parfois avec un zéro de tête
  (`0100011` → `100011`), parfois suivies d'un tiret et d'un complément de
  volume/tome (`104391-182 JOR` → le numéro reste `104391`), parfois
  écrites avec un point comme séparateur de milliers pour un nombre à 5
  chiffres (`12.352` = 12352).
- **6e étage** (à exclure) : cotes purement littérales (`R FON`, `BD TSI`)
  ou indices Dewey classiques à 3 chiffres avant le point (`940.21 BER`,
  `330.122 KER` — le préfixe à 3 chiffres est justement ce qui les
  distingue du séparateur de milliers ci-dessus : un vrai numéro
  d'enregistrement à 5 chiffres n'a jamais 3 chiffres avant le point).

Algorithme retenu (`magasinDigitRun()` dans `scripts/build-magasins.mjs`) :
fusionner un éventuel point « 1-2 chiffres.3 chiffres » en un seul nombre,
puis chercher un groupe de chiffres consécutifs de longueur 5 ou 6 (zéro de
tête sur un groupe de 7 retiré avant de mesurer) n'importe où dans la cote.
Un groupe trouvé → gardé (2e/5e étage) ; sinon → exclu (6e étage). Validé
à la main sur les 38 236 exemplaires réels de l'export (2026-07-24) : 12 609
gardés, 25 627 exclus — voir `data/magasins-build-report.json` pour les
compteurs et des échantillons (`excludedSample`, `keptEdgeSample`) à relire
en cas de doute après un nouvel export. Cette règle repose sur la forme
observée de cet export précis ; si un futur export introduit un format de
cote nouveau (nouveau préfixe lettré combiné à des chiffres, etc.), relire
`keptEdgeSample`/`excludedSample` avant de faire confiance au tri.

`data/xml/magasin/` (fichiers bruts, 125 Mo + 37 Mo) est gitignored — pas de
repli local committé pour ce jeu de données, contrairement à
`data/xml/notices.xml`/`exemplaires.xml` de la réserve.

## Cotes numériques (repérage dans le catalogue complet)

`cotes-numeriques.html` (2026-08-18) répond à un besoin de tri que le SIGB
ne permet pas de faire assez finement : repérer, dans un export séparé de
**toute** la bibliothèque, les exemplaires dont la cote est un numéro
d'enregistrement séquentiel à 5 ou 6 chiffres, pour pouvoir exporter leurs
codes-barres et les rajouter en panier dans le SIGB. Contrairement à
`data/xml/notices.xml`/`exemplaires.xml` (réserve) et `xml/magasin/…`
(magasins), cet export ne fournit **qu'un seul fichier** — `xml/all/catalogue.xml`
sur R2, récupéré par `scripts/build-cotes-numeriques.mjs`
(`npm run build:cotes-numeriques`) dans `data/xml/all/catalogue.xml` (pas de
repli local committé, comme pour les magasins) — car l'export des notices
plante tellement l'ensemble de la bibliothèque est volumineux. Ce fichier ne
contient donc que des `<record>` d'exemplaires : pas de jointure
notice/exemplaire ici, la cote (`930$g`/`930$h`) et le code-barre (`915$b`)
sont lus directement sur chaque exemplaire, sans titre/auteur (absents de cet
export). Sortie : `data/cotes-numeriques.json` + `data/cotes-numeriques-build-report.json`
(même mécanique d'archivage `-previous.json` que les autres builds).

Règle de détection (`numericLocDigitRun()` dans `build-cotes-numeriques.mjs`,
volontairement **plus stricte** que `magasinDigitRun()` de
`build-magasins.mjs` — choix explicite fait pour ce jeu de données, pas un
oubli) : après avoir fusionné un éventuel point « 1-2 chiffres.3 chiffres »
(séparateur de milliers, ex. « 11.268 » → « 11268 », « 138.678 » →
« 138678 » — ne fusionne pas un préfixe Dewey à 3 chiffres comme
« 168.66 »/« 325.5 », qui restent en morceaux de 3+2/3+1 chiffres), on
cherche un groupe de chiffres consécutifs faisant EXACTEMENT 5 ou 6 chiffres
**ET commençant par le chiffre « 1 »** (zéro de tête sur un groupe de 7
retiré avant de mesurer, comme pour les magasins). Un groupe à 5 ou 6
chiffres qui ne commence pas par « 1 » est délibérément écarté, même s'il
pourrait s'agir d'un vrai numéro d'enregistrement — cf. `nearMissSample` du
rapport de build pour les cotes concernées par ce cas, à relire si le
périmètre semble trop restrictif après un premier export réel. Cette
restriction supplémentaire (absente de la règle magasins) est une demande
explicite, pas déduite de la forme de l'export — à ne pas assouplir sans
revalider avec un nouvel export.

Avant cette règle numérique, un test écarte les cotes de la **Réserve
Douaisienne** : préfixe « D » (± un espace, casse indifférente — « D138678 »,
« D 138678 », « d100784 ») juste devant le numéro. Sans ce test, ces cotes
seraient gardées à tort : leur numéro (après le « D ») a la même forme 5/6
chiffres commençant par « 1 » que les vraies cotes 2e/5e étage — vérifié à
l'introduction de la règle (2026-08-18) sur l'export réel : 6 050 des 43 787
exemplaires initialement gardés portaient ce préfixe. Compteur et échantillon
dans le rapport de build (`stats.douaisienneExcluded`, `douaisienneSample`).

`cotes-numeriques.html` reprend le patron de `magasins.html` (recherche,
tri par colonne, pagination) mais sans les colonnes titre/auteur/éditeur
(pas de notice dans cet export) : cote, étage, indice Dewey (`930$i`), type
(`920$t`), section (`921$b`), date d'entrée (`920$d`), code-barre. Trois
boutons d'export en .txt (un code-barre par ligne, même convention que les
exports des « Statistiques avancées » de `recolement.html`) : « Exporter
(filtre actuel) » respecte la recherche texte et le menu déroulant d'étage ;
« 2e étage » / « 5e étage » exportent directement l'étage correspondant
(en respectant la recherche texte, mais **sans** dépendre du menu déroulant
— pas besoin de le changer avant de cliquer). Cet outil est un pur
repérage/tri, indépendant du récolement/de la réserve (pas d'écriture vers
`/api/recolement`, pas de notion d'emplacement travée/colonne/étage) —
volontairement laissé simple, sur demande explicite plutôt qu'une
intégration au plan de la réserve.

Étage (2e/5e) : dérivé côté client uniquement (`etageOf()` dans
`cotes-numeriques.html`, pas dans le script de build) à partir de
`_coteDigitRun` déjà présent dans `data/cotes-numeriques.json`. Chacune des
deux longueurs de cote (5 ou 6 chiffres) a sa **propre** séquence
d'enregistrement et donc son propre seuil de bascule — comparer un numéro à
5 chiffres et un numéro à 6 chiffres sur une même échelle n'aurait aucun
sens (`ETAGE_THRESHOLDS = { 5: 13830, 6: 133530 }`) : cote ≤ seuil de sa
longueur → 2e étage, au-delà → 5e étage, seuil inclus dans la borne basse.
Ces deux seuils sont une donnée métier fournie par l'utilisateur, pas
déduits de l'export — à revalider avec lui si un futur export venait à
décaler ces plages. Le panneau de stats affiche le compte par étage
(calculé sur `ROWS`, indépendamment du rapport de build) et un menu
déroulant permet de filtrer le tableau (et donc l'export .txt) par étage.

## Exemplarisation rapide (catalogage minimal)

`exemplarisation.html` (2026-08-12) permet de créer un exemplaire (titre,
auteur, date de publication, cote, code-barre, emplacement optionnel) sans
passer par une notice bibliographique Syracuse complète — pensé pour les
documents non catalogués qu'il serait trop fastidieux de saisir intégralement
avant de pouvoir simplement leur attribuer un code-barre et une cote. Ce
n'est pas un remplacement du catalogage réel : un pense-bête partagé entre
collègues, à réconcilier plus tard lors d'un vrai export/import Syracuse.

Les enregistrements vivent dans R2 sous la clé `exemplaires-manuels.json`
(forme `{ [barcode]: {barcode, titre, auteur, date, cote, location, ts} }`,
`location` étant `null` ou `{travee, colonne, etage}`/`{locType:'armoire'|
'tiroir', ...}` selon `locFieldsOf()` de `js/reserve-shared.js`), via
`api/exemplaires-manuels.mjs` — même patron GET public / POST authentifié /
compare-and-swap que `api/recolement.mjs` et `api/spolies.mjs`. La page
elle-même reprend le patron de synchronisation de `livres-spolies.html`
(localStorage comme source de vérité locale, file d'attente
`rp_exemplaires_manuels_pending_sync` rejouée à la reconnexion) et le
sélecteur d'emplacement de `recolement.html` (travée/colonne/étage ou
armoire/tiroir, sans le mode « hors réserve » ni « à cataloguer », propres
au récolement).

À la création, jusqu'à trois écritures indépendantes partent en tâche de fond :

- Toujours : un patch `{type:'upsert', record}` vers `/api/exemplaires-manuels`.
- Si l'emplacement est renseigné (case « J'indique l'emplacement
  maintenant », cochée par défaut) : *en plus*, un patch `{type:'scan',
  record}` vers `/api/recolement` — le même endpoint et la même forme de
  `record` que `handleScan()` dans `recolement.html` (avec `manuel:true`,
  voir plus haut « Le code couleur du plan »). Ça évite de dupliquer la
  logique d'emplacement/occupation : l'exemplaire apparaît immédiatement
  dans `reserve.html` et dans le journal de `recolement.html`, sans code
  spécifique dans ces deux pages pour un type d'origine différent.
- Toujours dans ce même cas (emplacement renseigné), et seulement si
  l'estimation « non catalogués » de cet emplacement précis (`nonCatalogues`,
  voir le comptage de non-catalogués de `recolement.html`) est déjà > 0 : un
  second patch `{type:'nonCat', key, record}` vers `/api/recolement` qui la
  décrémente de 1 (supprimée si elle retombe à 0). Cet exemplaire vient
  d'être identifié individuellement — il ne doit plus aussi compter dans
  l'estimation vague de la même étagère, sinon il serait compté deux fois.
  `exemplarisation.html` maintient pour ça un cache local `NONCAT` (rafraîchi
  au chargement et toutes les 45 s via `loadNonCatFromServer()`), dans le
  même esprit « lecture locale, écriture optimiste » que le reste de la page
  — pas de décrément atomique côté serveur, `api/recolement.mjs` n'a pas
  changé pour cette fonctionnalité (le patch `nonCat` existait déjà).

Ces exemplaires sont ensuite fusionnés côté client, via
`js/exemplaires-manuels-shared.js` (`fetchExemplairesManuelsAsCatalogRows()`,
qui convertit chaque enregistrement au même format de champs que
`data/inventaire.json` — `200$a`/`700$a`/`210$d`/`930$g`/`995$f` — plus un
`Sous-fonds` dédié `⚡ Exemplarisation rapide (à cataloguer)` pour rester
visuellement distincts tant qu'ils n'ont pas été réellement catalogués),
dans trois endroits qui lisaient jusqu'ici uniquement `data/inventaire.json` :

- `js/inventaire.js` (`loadCSV()`) — recherche du catalogue sur `index.html`.
- `analyse-cotes.html` — détection de trous/doublons de cotes.
- `recolement.html` (fetch du `catalog` en tout début de script) — pour
  qu'un code-barre créé ici, même **sans** emplacement renseigné, soit déjà
  reconnu comme « connu du catalogue » au moment où quelqu'un le scanne
  physiquement plus tard (sinon `handleScan()` le traiterait comme inconnu
  et n'enregistrerait rien — voir son statut `unknown`).

Ces trois fusions échouent silencieusement (tableau vide) si l'API est
indisponible, pour ne jamais bloquer l'affichage du reste du catalogue —
même philosophie de dégradation que le reste du stockage partagé (voir
ci-dessous).

### Vignettes (photo attachée à un exemplaire)

`exemplarisation.html` intègre directement dans son formulaire (pas une page
séparée — tout se fait « en un seul geste » avec le titre/auteur/date/cote)
une mécanique de rognage reprise de `scan-docs.html` (détection de bords par
projection, poignées de recadrage, loupe de précision — tous les
identifiants JS/CSS de cette section sont préfixés `photo`, code dupliqué
intentionnellement plutôt que factorisé, même logique que le reste du
projet) mais **sans** la lecture de code-barre par OCR (zxing-wasm) : le
code-barre utilisé pour la photo est celui déjà saisi dans le champ
`#f-barcode` du formulaire — inutile de le relire depuis l'image.

Au clic sur « Ajouter l'exemplaire », si une photo a été chargée et rognée,
elle est redimensionnée côté client (1600 px max sur le plus grand côté,
JPEG qualité 0.85 — une vignette est un aperçu, pas un scan d'archive) puis
envoyée en base64 à `api/vignette.mjs` (`POST` authentifié, corps JSON
`{barcode, imageBase64}` plutôt qu'un upload multipart, cohérent avec le
reste de l'API du projet) qui l'écrit dans R2 sous la clé
`vignette/<code-barre>.jpg` via `r2Put` — écrase silencieusement une
vignette existante pour le même code-barre (permet de reprendre une photo
ratée en recréant/mettant à jour le même exemplaire). L'envoi est
volontairement découplé de la création de l'exemplaire (qui, elle, reste
instantanée et passe par la file `pendingSync` habituelle) : `img`/`cropR`/
`margin` sont capturés en instantané au moment du clic (pas relus depuis les
variables globales `photoImg`/`photoCropR`) pour que l'envoi de la photo N
reste correct même si l'utilisateur·rice a déjà chargé la photo de
l'exemplaire N+1 avant la fin de cet envoi — seul le message de statut
(`#photo-status`, en dehors du bloc réinitialisé par `photoRemove()` pour
rester visible) peut se faire écraser dans ce cas précis, sans conséquence
sur les données envoyées. En cas d'échec, un bouton « Réessayer » apparaît
dans ce même message et relance l'envoi avec l'instantané déjà capturé.

Ce préfixe `vignette/` est un troisième usage indépendant du bucket R2, en
plus de `xml/` et de la famille `recolement.json`/`livres-spolies-overrides.json`/
`exemplaires-manuels.json` (voir « Stockage partagé » ci-dessous). Il n'existe
actuellement **aucune lecture** de ces images ailleurs dans le site (ni
proxy `GET` signé, ni URL publique R2 connue) : c'est pour l'instant un
usage en écriture seule. Si un affichage de ces vignettes est un jour
demandé (ex. dans le tableau des exemplaires créés, ou dans le catalogue),
il faudra soit un endpoint `GET` signé supplémentaire (le bucket n'est pas
public), soit activer un accès public R2 sur ce préfixe précis.

## Stockage partagé (Cloudflare R2) et fonctions serverless

Bucket R2 `douai-patrimoine` (compte Cloudflare de l'utilisateur), utilisé
pour trois choses indépendantes :

- **`xml/notices.xml`, `xml/exemplaires.xml`** : copie des exports Syracuse
  bruts, poussée par `npm run upload:xml` après chaque nouvel export. But :
  ne plus committer ces fichiers (60+ Mo à eux deux) dans git à chaque
  refresh. `scripts/build-inventory.mjs` les rapatrie automatiquement dans
  `data/xml/` avant de builder si les variables R2 sont présentes ; sinon
  (dev local sans `.env`), comportement d'origine inchangé — lecture des
  fichiers locaux, échec strict s'ils manquent.
- **`recolement.json`, `livres-spolies-overrides.json`, `exemplaires-manuels.json`,
  `reliures-manuelles.json`** : état partagé canonique de `recolement.html` /
  `livres-spolies.html` / `exemplarisation.html` (voir « Exemplarisation
  rapide » plus haut) / `reliures.html` (voir « Récolement en cascade des
  documents reliés » plus haut), pour que plusieurs collègues avancent en
  même temps sans export/import JSON manuel. Chaque page garde le
  `localStorage` comme source de vérité locale (fonctionne hors ligne, file
  d'attente `rp_*_pending_sync` rejouée à la reconnexion) et envoie en plus
  chaque changement en arrière-plan.
- **`recolement-backups/<horodatage>.json`** : instantanés datés et
  immuables (un objet par sauvegarde, jamais réécrit), distincts de l'état
  partagé courant ci-dessus. Créés par le bouton « Sauvegarder ce
  récolement » de `recolement.html` (`api/recolement-backups.mjs`, POST
  authentifié). La carte « Récolement de référence » de la même page peut
  lister les 5 plus récents (`GET ?list=1&count=5`, via `r2List` — API S3
  `ListObjectsV2`, lecture publique comme le reste) et en charger un
  directement comme référence (`GET ?key=...`), sans passer par un
  export/import de fichier local.
- **`vignette/<code-barre>.jpg`** : photos rognées attachées aux exemplaires
  créés via `exemplarisation.html` (import/rognage intégré à son formulaire)
  — voir « Exemplarisation rapide » plus haut. Contrairement aux deux
  catégories ci-dessus, écriture seule (`api/vignette.mjs` n'expose aucun `GET`) : rien
  dans le site ne relit ces images pour l'instant.

Cinq fonctions Vercel (`api/recolement.mjs`, `api/spolies.mjs`,
`api/exemplaires-manuels.mjs`, `api/reliures-manuelles.mjs`,
`api/vignette.mjs`) servent de proxy vers R2 :
`GET` (sauf `api/vignette.mjs`, POST uniquement) renvoie l'état courant
(public, même niveau
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
cohérent avec le "zéro dépendance npm" du reste du projet (`r2Get`/`r2Put`/
`r2Delete`/`r2CasUpdate`, plus `r2List` pour `ListObjectsV2` — seule requête
signée du projet à porter une query string canonique SigV4 ; réponse XML
S3 parsée à la main par regex, volontairement minimal). Variables
d'environnement requises (Vercel + `.env` local, jamais commitées,
`.env` est dans `.gitignore`) : `R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, plus `ADMIN_USER`/`ADMIN_PASS`
(utilisées par `/api/login` pour vérifier le formulaire de connexion de
`index.html`, et pour authentifier les `POST` — voir Sécurité ci-dessous).
Si ces variables sont absentes, tout le reste du site continue de
fonctionner à l'identique (repli local partout), seule la synchronisation
partagée est inactive. `npm run test:r2` permet de vérifier un token sans
toucher aux données réelles.

En plus des patchs unitaires (`scan`, `deleteScan`, `nonCat`, `vide`,
`nonrange`, `lastShelf`, `resolveIssue` — ce dernier pour les « Statistiques
avancées », voir plus haut), `api/recolement.mjs` accepte un patch
`bulkMerge` (`{type:'bulkMerge', data:{scans, nonCatalogues, videShelves,
nonRangeShelves, lastShelves, resolvedIssues}}`) qui fusionne un lot entier
avec la même sémantique que les patchs unitaires (jamais de suppression, un
scan plus récent — `ts` — l'emporte sur un plus ancien). C'est ce patch
qu'envoie `recolement.html`
après un import de fichier de sauvegarde (`mergeIncomingData(data,
{syncToServer:true})`), pour que l'import mette aussi à jour l'état
partagé R2 et pas seulement le navigateur local qui a fait l'import — voir
l'incident 2026-07-24 ci-dessous.

## Sécurité — à savoir avant de toucher à l'espace pro

L'« espace professionnel » n'a **toujours pas de vraie protection serveur
au niveau des pages** — les pages elles-mêmes restent 100 % statiques :

- Le contrôle d'accès des pages protégées n'est qu'un test
  `sessionStorage.getItem('rp_admin_auth') === '1'` — contournable
  trivialement dans la console du navigateur (`sessionStorage.setItem(...)`),
  **sans même connaître le mot de passe**. Une personne qui contourne ce
  gate peut donc voir l'UI de `recolement.html`, `reserve.html`, etc.

Depuis 2026-07-24, ce qui a changé : les identifiants (`ADMIN_USER` /
`ADMIN_PASS`) **ne sont plus en clair dans le JavaScript** — le formulaire
de connexion de `index.html` les envoie à `/api/login`, qui les compare
côté serveur aux variables d'environnement Vercel (`lib/auth.mjs`,
`credentialsMatch()`). Un « voir le code source » ne révèle donc plus le
mot de passe. Ça ne protège pas davantage l'accès aux *pages* (le gate
`sessionStorage` reste un simple indicateur, toujours contournable comme
ci-dessus) — seulement le **coût de découverte du mot de passe**, et par
ricochet l'écriture dans l'état partagé R2 : un `POST` vers
`/api/recolement` ou `/api/spolies` exige un en-tête `Authorization: Basic`
vérifié par ce même `credentialsMatch()`, donc contourner le gate client ne
suffit plus à corrompre les données partagées, il faut réellement
connaître le mot de passe. La lecture (`GET` de ces deux endpoints) reste
volontairement publique, au même niveau d'exposition que
`data/recolement.json` aujourd'hui.

Ce qui a été fait dans le cadre du nettoyage (2026-07-23) : ajout du
contrôle `sessionStorage` manquant sur `reserve.html`, `scan-docs.html` et
`generer_manifest.html` (cohérence avec `recolement.html`/
`analyse-cotes.html`), et ajout de `<meta name="robots" content="noindex,
nofollow">` sur toutes les pages de l'espace pro pour éviter leur
indexation.

Ce qui n'a **pas** été corrigé, car c'est une décision produit et non un
simple nettoyage : le gate des *pages* reste côté client (sessionStorage),
donc ce n'est qu'une barrière anti-curieux pour la navigation, pas une
vraie protection d'accès — même si l'écriture des données partagées est,
elle, réellement protégée depuis l'ajout de `/api/login`. Pour aller plus
loin (protéger aussi l'accès aux pages elles-mêmes), les options réalistes
restent : Vercel Deployment/Password Protection (plan payant), ou un vrai
cookie de session posé par `/api/login` puis vérifié par un middleware/edge
function sur chaque page protégée. Ne pas supposer que l'accès à ces pages
est sécurisé au-delà de ce qui est décrit ici.

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
- Incident du 2026-07-24 : le jour même du lancement de la synchro R2 de
  `recolement.html` (commit `893ab4a`), la clé R2 `recolement.json` a
  démarré **vide** — aucune étape n'avait jamais réamorcé R2 avec
  l'historique déjà accumulé en local (ni depuis le `localStorage` d'un
  poste existant, ni depuis `data/recolement.json` commité). Un collègue
  ouvrant `recolement.html` sur un nouveau poste a donc reçu cet état
  partagé vide via `GET /api/recolement`, donnant l'impression que « le
  nouveau poste avait écrasé l'ancien récolement » — en réalité rien n'a
  été écrasé (la fusion cliente n'a jamais fait que d'ajouter), c'est l'état
  partagé qui n'avait simplement jamais été peuplé. Réparé en réécrivant la
  clé R2 depuis `data/recolement.json`. Root cause corrigée en ajoutant le
  patch `bulkMerge` (voir « Stockage partagé » ci-dessus) : désormais,
  importer un fichier de sauvegarde dans `recolement.html` pousse aussi ce
  lot vers R2, donc réimporter une sauvegarde à jour réamorce l'état
  partagé pour tout le monde.
- Corrigé (2026-08-11) dans `reserve.html` : les étages s'affichaient dans
  l'ordre décroissant (étage 1 en bas) dans le plan miniature et le
  panneau de détail — inversé pour que l'étage 1 soit en haut. Corrigé
  aussi un bug plus sérieux dans `colsOf()`/`maxEtageOf()`/`allEtagesOf()` :
  ces fonctions ne montraient que les colonnes/étages présents dans les
  données dès qu'*une seule* donnée existait pour la travée, au lieu de
  toujours partir de l'ensemble par défaut (`nbCols`/`maxEt`) complété par
  les données réelles — conséquence concrète : dès qu'une colonne recevait
  un scan catalogué, les autres colonnes de la même travée n'ayant que des
  non-catalogués/vide/non rangé (ou rien) disparaissaient purement et
  simplement du plan plutôt que de s'afficher en placeholder « non
  inventorié ». Les trois fonctions font maintenant l'union du défaut et
  des données réelles. À cette occasion, ajout de la catégorie
  `lastShelves` (voir plus haut) pour le cas inverse : marquer qu'une
  colonne s'arrête réellement avant le `maxEt` par défaut de sa travée.
