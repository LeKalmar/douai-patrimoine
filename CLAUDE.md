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
  `data/magasins-build-report.json` à partir de l'export complet de la
  bibliothèque `xml/bib.xml` (R2, pas de repli local committé), filtré aux
  magasins d'étage (2e/5e/6e, adulte et jeunesse). Voir « Magasins 2e/5e/6e
  étage » plus bas.
- `npm run build:cotes-numeriques` — régénère `data/cotes-numeriques.json` et
  son rapport, également depuis `xml/bib.xml` (toute la bibliothèque, pas
  seulement les magasins). Voir « Cotes numériques » plus bas.
- `npm run upload:bib` — pousse `data/xml/bib.xml` (export complet de la
  bibliothèque, format GESMARC, plusieurs centaines de Mo) vers R2
  (`xml/bib.xml`). À relancer après chaque nouvel export ; les deux scripts
  ci-dessus le rapatrient alors automatiquement. Le parseur GESMARC est
  partagé entre `build-magasins.mjs`, `build-cotes-numeriques.mjs` et
  `build-desherbage.mjs` via `scripts/lib/gesmarc.mjs` (le parseur MARC-XML,
  pour `data/xml/notices.xml`/`exemplaires.xml`, reste dans
  `scripts/lib/marc-xml.mjs`) — `bib.xml` étant trop volumineux pour tenir
  dans une seule string JS, ces deux scripts le lisent en flux
  (`iterateGesmarcItemsFromFile()`) plutôt qu'avec un `readFileSync()`
  classique.
- `npm run build:desherbage` — régénère `data/desherbage.json` et
  `data/desherbage-build-report.json` à partir de l'export Syracuse
  « statistiques de prêt » utilisé par Rotobib (`rotobib.html`), indépendant
  de `bib.xml` (voir « Rotobib » plus bas).
- Avant d'écraser `data/build-report.json`, `data/magasins-build-report.json`,
  `data/cotes-numeriques-build-report.json` ou `data/desherbage-build-report.json`,
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
| `magasins.html` | Catalogue des exemplaires des magasins 2e/5e/6e étage, adulte et jeunesse (recherche, tri, pagination), à partir de `data/magasins.json` — voir « Magasins 2e/5e/6e étage » | **Protégé** |
| `cotes-numeriques.html` | Repérage, dans l'export complet de la bibliothèque, des exemplaires à cote numérique 5/6 chiffres (recherche, tri, export .txt des codes-barres pour ajout panier SIGB), à partir de `data/cotes-numeriques.json` — voir « Cotes numériques » | **Protégé** |
| `exemplarisation.html` | Création rapide d'exemplaires (titre, auteur, date, cote, code-barre, emplacement, photo — tout en un seul formulaire) sans notice bibliographique complète — voir « Exemplarisation rapide » | **Protégé** |
| `reliures.html` | Création manuelle de groupes de documents reliés ensemble (équivalent $481/$482) et détection des groupes dont les emplacements récolés ne concordent pas — voir « Récolement en cascade des documents reliés » | **Protégé** |
| `scan-docs.html` | Rognage et renommage par cote des images scannées avant intégration au fonds numérisé (zxing-wasm pour lire les codes-barres) | **Protégé** |
| `rotobib.html` | Désherbage assisté par les statistiques de prêt : scan d'un code-barre, fiche + histogramme de prêts sur 4 ans, décision (conserver/pilon/braderie/relocalisation), export .txt par traitement — voir « Rotobib » | **Protégé** |
| `desherbage-stats.html` | Vue d'ensemble purement statistique (lecture seule) de l'export de désherbage : prêts totaux par année, répartition par prêts cumulés, liste triable des exemplaires — voir « Rotobib » | **Protégé** |
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

## Magasins 2e/5e/6e étage (catalogue filtré)

`magasins.html` donne un catalogue navigable (recherche, tri, pagination,
filtres étage et secteur) des collections des magasins d'étage (2e, 5e et
6e, adulte et jeunesse). Depuis 2026-08-26, la source est `xml/bib.xml` —
l'export complet de la bibliothèque (R2, pas de repli local committé,
fichier de plusieurs centaines de Mo), récupéré par
`scripts/build-magasins.mjs` → `data/magasins.json` +
`data/magasins-build-report.json`. Ce flux est indépendant de
`npm run build` / `data/inventaire.json` : lancez `npm run build:magasins`
séparément après un nouvel export + `npm run upload:bib`.

Avant 2026-08-26, ce catalogue venait d'un export Syracuse dédié
(`xml/magasin/notices.xml.xml` + `exemplaires.xml.xml`, MARC-XML classique)
qui ne couvrait que le 2e/5e étage et excluait volontairement le 6e (motif
historique : ces deux fichiers restent dans R2 et sont toujours utilisés
par `build-desherbage.mjs`/Rotobib — voir plus bas — mais `build-magasins.mjs`
ne les lit plus). `bib.xml` est un export "GESMARC" à plat (voir
`scripts/lib/gesmarc.mjs`), pas du MARC-XML : chaque exemplaire porte
directement `Titre`/`Auteur`/`Editeur`/`Publié le` (pas de jointure
notice/exemplaire nécessaire), une `Bibliothèque (Libellé)` (le réseau
Douai-Cuincy expose plusieurs bibliothèques dans le même export — on ne
garde que celles dont le libellé commence par "Douai", ce qui exclut
notamment "Médiathèque départementale") et une `Section (Libellé)`.

Filtre magasins (`build-magasins.mjs`) : `Section (Libellé)` vaut
exactement `"Magasin"` (adulte, ~40 000 exemplaires sur l'export du
2026-08-26) ou `"Magasin Jeunesse"` (~23 000) — les deux sont gardés et
distingués via le champ `_secteur` (affiché "Adulte"/"Jeunesse" dans
`magasins.html`). Contrairement à l'ancien export, **le 6e étage n'est
plus exclu** : au sein de chacune de ces deux sections, 2e/5e étage (cotes
numériques) et 6e étage (cotes littérales/Dewey) cohabitent toujours dans
le même export, distingués a posteriori par la forme de la cote — seule la
sémantique change (un marquage `_coteDigitRun` présent/absent plutôt qu'un
filtre d'exclusion) :

- **2e/5e étage** : cotes à numérotation séquentielle de 5 ou 6
  chiffres — `100350`, `156235` — parfois avec un zéro de tête
  (`0100011` → `100011`), parfois suivies d'un tiret et d'un complément de
  volume/tome (`104391-182 JOR` → le numéro reste `104391`), parfois
  écrites avec un point comme séparateur de milliers pour un nombre à 5
  chiffres (`12.352` = 12352).
- **6e étage** : cotes purement littérales (`R GRI`, `BD TSI`) ou indices
  Dewey classiques à 3 chiffres avant le point (`940.21`, `330.122` — le
  préfixe à 3 chiffres est justement ce qui les distingue du séparateur de
  milliers ci-dessus : un vrai numéro d'enregistrement à 5 chiffres n'a
  jamais 3 chiffres avant le point).

Particularité de `bib.xml` : la cote n'est pas portée par un seul champ
(`930$g` en MARC-XML) mais éclatée sur 3 propriétés indépendantes — `"Cote
n° 1"`, `"Cote n° 2"`, `"Cote n° 3"` (ex. `"166010"`/`""`/`""`, ou
`"R"`/`"GRI"`/`""`, parfois même une classification Dewey secondaire dans
le 3e champ à titre d'information, ex. `"166010"`/`"JAF"`/`"320.966"`).
`build-magasins.mjs` les rejoint (espace comme séparateur) **avant**
d'appliquer `magasinDigitRun()` (même algorithme qu'auparavant : fusionner
un éventuel point « 1-2 chiffres.3 chiffres » en un seul nombre, puis
chercher un groupe de chiffres consécutifs de longueur 5 ou 6 n'importe où
dans la cote jointe) — vérifier les 3 champs plutôt qu'un seul est
nécessaire pour ce nouvel export (demande explicite, 2026-08-26). Les
champs de sortie `930$g`/`930$h`/`930$i` de `data/magasins.json`
correspondent directement à `Cote n° 1/2/3`.

`210$d` (année/date affichée dans la colonne "Éditeur / Publié le" de
`magasins.html`) vient de la propriété `Publié le` de `bib.xml` — absente
de l'export du 2026-08-26 (un nouvel export l'ajoutant était en cours au
moment de cette migration), donc vide tant qu'un export la contenant n'a
pas été rechargé via `npm run upload:bib` + `npm run build:magasins`. La
colonne "Entrée" (date d'entrée) de l'ancien `magasins.html` a été retirée :
`bib.xml` ne porte pas d'équivalent au `920$d` de l'ancien export MARC-XML.

`data/xml/magasin/` et `data/xml/all/` (anciens exports, gitignorés comme
tout `data/xml/`) ne sont plus lus par `build-magasins.mjs`/
`build-cotes-numeriques.mjs` — `xml/magasin/notices.xml.xml` reste
cependant utilisé par `build-desherbage.mjs` (Rotobib, voir plus bas), donc
pas retiré de R2.

## Cotes numériques (repérage dans le catalogue complet)

`cotes-numeriques.html` (2026-08-18) répond à un besoin de tri que le SIGB
ne permet pas de faire assez finement : repérer, dans **toute** la
bibliothèque, les exemplaires dont la cote est un numéro d'enregistrement
séquentiel à 5 ou 6 chiffres, pour pouvoir exporter leurs codes-barres et
les rajouter en panier dans le SIGB.

Depuis 2026-08-26, la source est `xml/bib.xml` (export complet de la
bibliothèque, format GESMARC — voir « Magasins 2e/5e/6e étage » ci-dessus
pour le détail du format et `scripts/lib/gesmarc.mjs`), récupéré par
`scripts/build-cotes-numeriques.mjs` (`npm run build:cotes-numeriques`)
dans `data/xml/bib.xml` (pas de repli local committé). Seul le filtre
`Bibliothèque (Libellé)` commençant par
"Douai" est appliqué — **aucun filtre de section** : contrairement à
`build-magasins.mjs`, ce script scanne bien toute la bibliothèque (pas
seulement les magasins), pour repérer une éventuelle anomalie de classement
(une cote numérique qui traînerait hors d'un magasin). Avant 2026-08-26, la
source était `xml/all/catalogue.xml` (MARC-XML, exemplaires seuls, sans
titre/auteur) — ce fichier reste dans R2 mais n'est plus lu par ce script.
Sortie : `data/cotes-numeriques.json` + `data/cotes-numeriques-build-report.json`
(même mécanique d'archivage `-previous.json` que les autres builds).

Comme pour les magasins, la cote de `bib.xml` est éclatée sur 3 propriétés
(`Cote n° 1/2/3`, → `930$g`/`930$h`/`930$i` dans la sortie) qui sont
jointes (espace) avant toute analyse. Règle de détection
(`numericLocDigitRun()` dans `build-cotes-numeriques.mjs`, appliquée à cette
cote jointe, volontairement **plus stricte** que `magasinDigitRun()` de
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
rapport de build pour les cotes concernées par ce cas. Cette restriction
supplémentaire (absente de la règle magasins) est une demande explicite,
pas déduite de la forme de l'export — à ne pas assouplir sans revalider.

Avant cette règle numérique, un test écarte les cotes de la **Réserve
Douaisienne** : préfixe « D » (± un espace, casse indifférente — « D138678 »,
« D 138678 », « d100784 ») juste devant le numéro (testé sur la cote jointe).
Sans ce test, ces cotes seraient gardées à tort : leur numéro (après le
« D ») a la même forme 5/6 chiffres commençant par « 1 » que les vraies
cotes 2e/5e étage. Compteur et échantillon dans le rapport de build
(`stats.douaisienneExcluded`, `douaisienneSample`).

`cotes-numeriques.html` reprend le patron de `magasins.html` (recherche,
tri par colonne, pagination) : cote, étage, titre, auteur, « Bibliothèque ·
Section » (les valeurs brutes `_bibliotheque`/`_section` de `bib.xml`,
concaténées — sert justement à repérer une cote numérique détectée hors
d'un magasin, ex. en section « Adulte » ou « Réserve » plutôt que
« Magasin »), publié le (`Publié le` de `bib.xml`, vide tant qu'un export
le portant n'a pas été chargé), code-barre. Contrairement à l'ancien export
MARC-XML (exemplaires seuls, sans titre/auteur), `bib.xml` porte titre et
auteur par exemplaire — plus besoin de s'en passer. Les colonnes indice
Dewey/type/date d'entrée de l'ancienne version ont été retirées : `bib.xml`
ne porte pas d'équivalent à `930$i`/`920$t`/`920$d` de l'ancien export.
Trois boutons d'export en .txt (un code-barre par ligne, même convention
que les exports des « Statistiques avancées » de `recolement.html`) :
« Exporter (filtre actuel) » respecte la recherche texte et le menu
déroulant d'étage ; « 2e étage » / « 5e étage » exportent directement
l'étage correspondant (en respectant la recherche texte, mais **sans**
dépendre du menu déroulant — pas besoin de le changer avant de cliquer).
Cet outil est un pur repérage/tri, indépendant du récolement/de la réserve
(pas d'écriture vers `/api/recolement`, pas de notion d'emplacement
travée/colonne/étage) — volontairement laissé simple, sur demande explicite
plutôt qu'une intégration au plan de la réserve. Contrairement à
`magasins.html`, il n'y a pas de menu « 6e étage » ici : ce script ne garde
que les cotes numériques 5/6 chiffres commençant par « 1 » (voir règle de
détection ci-dessus), donc jamais de cote littérale/Dewey (6e étage) dans
`data/cotes-numeriques.json`.

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

## Transfert 2e étage → réserve patrimoniale

`transfert-magasins.html` (2026-08-21) répond à un besoin distinct de
`magasins.html`/`exemplarisation.html` : beaucoup de documents du 2e étage
ne sont **pas catalogués du tout** dans Syracuse (absents de
`data/magasins.json`) — le seul support pour les repérer est un **registre
papier**. L'outil est en deux temps :

1. **Ajouter à la liste de transfert** (depuis le bureau, en lisant le
   registre papier) : un formulaire de saisie manuelle dont chaque champ
   est étiqueté avec son tag UNIMARC (titre `200$a`, auteur `700$a`, lieu
   d'édition `210$a`, maison d'édition `210$c`, année `210$d`, importance
   matérielle `215$a`, dimensions `215$d`, cote relevée sur le registre
   `930$g`, lieu d'origine `915$a` — code d'acquisition du type `EA2018`/
   `DON2019` dans les exports Syracuse existants, ici saisi à la main —,
   date d'entrée à la bibliothèque `920$d`). Seul le titre est requis. Ces
   champs sont volontairement gardés tels quels, tagués UNIMARC, dans le
   stockage partagé plutôt que traduits vers des clés génériques : pour ces
   documents non catalogués, ce formulaire est parfois la seule donnée
   numérique qui existera avant un vrai catalogage Syracuse.
2. **Exemplariser** (sur place, une fois le livre retrouvé) : dans la liste
   d'attente, un panneau dépliable par ligne (un seul ouvert à la fois,
   variable `openId`) reprend la mécanique d'emplacement de
   `exemplarisation.html` (`js/reserve-shared.js` : steppers travée/
   colonne/étage, sélecteur étagère/armoire/tiroir) mais avec la réserve
   **fixée** à `patrimoniale` (pas de sélecteur de réserve — c'est tout le
   sens de l'outil), plus deux champs « Nouvelle cote » et « Nouveau
   code-barre ».

Stockage partagé (nouveau, même patron que `api/exemplaires-manuels.mjs` :
GET public, POST authentifié, fusion `r2CasUpdate`) : clé R2
`transferts-magasins.json`, forme `{ [id]: record }` avec `id` généré côté
client (`crypto.randomUUID()` — pas de code-barre disponible à la création,
contrairement à `exemplaires-manuels.json` qui est keyé par code-barre).
`record.status` vaut `'pending'` (en attente, champs UNIMARC ci-dessus
seulement) puis `'done'` une fois exemplarisé (mêmes champs + `newCote`,
`newBarcode`, `doneTs`) — passage à `'done'` via le même patch `upsert`
que la création, sans type de patch dédié. `api/transferts.mjs` gère aussi
`{type:'delete', id}` pour retirer un livre de la liste.

À l'exemplarisation, **aucun changement de schéma** côté
`api/exemplaires-manuels.mjs` : le nouvel exemplaire envoyé en `upsert`
porte directement les tags UNIMARC recopiés depuis le registre papier
(`210$a`/`210$c`/`215$a`/`215$d` en plus des champs habituels
`barcode`/`titre`/`auteur`/`date`/`cote`/`location`), plus `coteOrigine`
(la cote du registre papier, distincte de la nouvelle `cote` attribuée) et
`915$a`/`920$d` conservés tels quels pour traçabilité — le patch `upsert`
de `api/exemplaires-manuels.mjs` est agnostique du contenu du record, seul
`record.barcode` est requis. Comme pour un exemplaire créé directement par
`exemplarisation.html`, un patch `scan` est aussi envoyé vers
`/api/recolement` si l'emplacement est renseigné (case cochée par défaut),
avec le même décrément de l'estimation `nonCat` de l'emplacement.
`js/exemplaires-manuels-shared.js` (`exemplaireManuelToCatalogRecord()`)
fait passer `210$a`/`210$c`/`215$a`/`215$d` vers la ligne affichée dans le
catalogue — additif, sans effet sur les exemplaires créés par
`exemplarisation.html` qui n'ont pas ces clés. `js/inventaire.js` affichait
déjà `215$a`/`215$d` dans le détail d'une fiche (`DETAIL_FIELDS`), donc
importance matérielle et dimensions apparaissent sans changement côté
`js/inventaire.js`.

## Rotobib (désherbage assisté par les statistiques de prêt)

`rotobib.html` (2026-08-26) aide à décider, exemplaire par exemplaire, s'il
faut le conserver, le mettre au pilon, le mettre en braderie ou le
relocaliser — en s'appuyant sur ses statistiques de prêt plutôt que sur une
inspection à l'œil. Porte sur un export Syracuse **ponctuel et distinct** de
`data/magasins.json` : mêmes exemplaires (des magasins 2e/5e étage), mais
avec un profil d'export différent donnant accès aux statistiques de prêt/
réservation par année — informations absentes de l'export magasins habituel.
**Cet export ne doit jamais être fusionné dans `data/magasins.json` comme
s'il s'agissait de nouveaux exemplaires** : c'est la même collection, vue
sous un autre angle, en parallèle, uniquement pour les besoins du
désherbage.

Pipeline de build (`scripts/build-desherbage.mjs`, `npm run
build:desherbage`) :

- Entrée : `xml/desherbage/desherbage.xml` (R2, poussé par `npm run
  upload:desherbage` — pas de repli local committé, comme les magasins/cotes
  numériques). Format **GESMARC**, pas du MARC-XML comme le reste du
  projet : `<items><item type="GESMARC"><property name="…" value="…"
  /></item></items>`, un `<item>` par exemplaire, avec les statistiques de
  prêt/réservation par année (`Nombre de prêts AN` = année en cours,
  `AN-1`, `AN-2`, `AN-3`) plus un total `Nombre de prêts cumulés` depuis
  l'acquisition. Aucune info notice (titre/auteur/date de parution) dans ce
  fichier — uniquement l'exemplaire. Parsé par le parseur GESMARC partagé
  (`iterateGesmarcItems`/`parseGesmarcItem` dans `scripts/lib/gesmarc.mjs` —
  aussi utilisé par `build-magasins.mjs`/`build-cotes-numeriques.mjs` pour
  `bib.xml`, voir « Magasins 2e/5e/6e étage » ; regex sur `<property
  name="…" value="…">`), pas par `scripts/lib/marc-xml.mjs` (réservé au vrai
  MARC-XML).
- Jointure : vérifié sur l'export du 2026-08-26 (6140 exemplaires) que
  100% des codes-barres de cet export se retrouvent dans
  `xml/magasin/notices.xml.xml` — le désherbage porte sur des collections
  des magasins d'étage. Ce fichier reste téléchargé spécifiquement par
  `build-desherbage.mjs` pour cette jointure (via `indexNotices()` de
  `scripts/lib/marc-xml.mjs`) même si `build-magasins.mjs` ne l'utilise
  plus depuis son passage à `bib.xml` (2026-08-26, voir plus haut) — les
  deux scripts sont désormais indépendants l'un de l'autre pour cette
  entrée. Pas besoin de retélécharger `xml/magasin/exemplaires.xml.xml` :
  les champs exemplaire utiles (cote, section, état, statistiques) sont
  déjà dans `desherbage.xml` lui-même.
- Champs de prêt/réservation vides dans l'export : Syracuse omet la valeur
  plutôt que d'écrire "0" pour les 4 compteurs annuels — vérifié que la
  somme des 4 années (vide = 0) ne dépasse jamais `Nombre de prêts
  cumulés` (toujours écrit explicitement, y compris "0"), et que
  `cumulés` peut être strictement supérieur à cette somme quand
  l'exemplaire a des prêts plus anciens que les 4 dernières années. Une
  case vide sur les 4 compteurs annuels signifie donc bien "0 prêt cette
  année-là" (`parseCount()`), pas une donnée manquante — sur l'export de
  référence, seuls 70 des 6140 exemplaires ont au moins une valeur non
  vide sur ces 4 champs, ce qui est cohérent avec le principe même de
  l'outil : ce sont majoritairement des livres peu ou pas empruntés
  récemment.
- Année de référence de "AN" : absente de l'export (pas de date
  d'extraction fournie par Syracuse dans ce format). Prise par défaut comme
  l'année en cours au moment du `npm run build:desherbage`
  (`new Date().getFullYear()`), réglable via la variable d'environnement
  `DESHERBAGE_REFERENCE_YEAR` si le build est lancé longtemps après
  l'export réel. Stockée dans `data/desherbage-build-report.json`
  (`stats.referenceYear`), lue par `rotobib.html` pour étiqueter les
  barres de l'histogramme avec de vraies années plutôt que "AN"/"AN-1"/etc.
- Sortie : `data/desherbage.json` (un enregistrement par exemplaire,
  champs notice dénormalisés `200$a`/`210$d`/`700$a`/… comme
  `data/magasins.json`, plus `prets`/`reservations` — objets `{an, an1,
  an2, an3, cumules}` — et les champs propres à l'export désherbage :
  `coteAffichee`, `bibliotheque`, `section`, `etat`, `exclusionPret`,
  `imagette`…) + `data/desherbage-build-report.json` (même mécanique
  d'archivage `-previous.json` que les autres builds).

Côté `rotobib.html` : un champ de scan (comme `recolement.html` — une
scannette USB suffit, pas de lecture caméra) affiche, dès qu'un code-barre
de l'export est reconnu, la fiche de l'exemplaire (titre, auteur, éditeur,
cote, description) et met en avant deux informations utiles à la décision :
la **date de parution** (`210$d`, dans un encadré, affichée telle quelle —
volontairement non re-parsée en année numérique pour ne pas perdre une
mention imprécise du type "18e siècle" ou "s.d.") et un **histogramme des
prêts sur les 4 dernières années** (`prets.an3`→`prets.an`, étiquetées avec
les vraies années déduites de `referenceYear`), avec le total cumulé
affiché à part en dessous (pas comme une 5e barre : il peut inclure des
prêts antérieurs aux 4 années représentées, donc pas comparable terme à
terme). Quatre boutons **Conserver / Pilon / Braderie / Relocalisation**
enregistrent la décision ; « Relocalisation » reste une simple étiquette de
traitement (pas de saisie d'emplacement dans cet outil — si un jour
nécessaire, voir le sélecteur travée/colonne/étage de
`exemplarisation.html`/`transfert-magasins.html` comme modèle). Après un
choix, le panneau se referme et le champ de scan reprend le focus, prêt
pour l'exemplaire suivant — même logique d'enchaînement que le scan de
`recolement.html`.

Décisions stockées dans R2 sous la clé `desherbage-traitements.json`
(`api/desherbage.mjs`, forme `{ [barcode]: {barcode, statut, ts} }`, même
patron GET public / POST authentifié / compare-and-swap que
`api/exemplaires-manuels.mjs` — patch `{type:'set', record}` pour
choisir/changer un traitement, `{type:'clear', barcode}` pour l'annuler),
partagées entre collègues comme le reste de l'outillage (plusieurs postes
peuvent désherber en parallèle). `rotobib.html` reprend le patron habituel
de synchronisation (localStorage `rp_desherbage_traitements` comme source
de vérité locale, file d'attente `rp_desherbage_pending_sync` rejouée à la
reconnexion). Un bandeau de statistiques (total de l'export, compte par
traitement, non traités) et un journal des traitements récents (recherche,
bouton « annuler » par ligne) donnent une vue d'ensemble de l'avancement
de la campagne. Quatre boutons d'export `.txt` (un code-barre par ligne,
même convention que les autres exports du projet) — un par traitement, y
compris « Conserver » — pour ajout panier dans le SIGB.

`desherbage-stats.html` (2026-08-26) est un outil **purement statistique**,
volontairement séparé de `rotobib.html` : aucune décision n'y est prise ni
stockée (pas d'écriture vers R2, pas d'API) — juste une lecture de
`data/desherbage.json` pour une vue d'ensemble de la campagne. Trois blocs :

- Un bandeau de chiffres clés (exemplaires de l'export, part jamais
  empruntée, total de prêts sur les 4 dernières années avec la moyenne par
  exemplaire, total cumulé depuis l'acquisition, exemplaire le plus
  emprunté). Sur l'export du 2026-08-26 : 71,6% des 6140 exemplaires n'ont
  **jamais** été empruntés (`prets.cumules === 0`), et les 4 dernières
  années cumulées (98 prêts) pèsent très peu face au total historique
  (3982) — cohérent avec le principe même de l'outil : cette sélection
  porte sur des documents à circulation faible ou nulle.
- Deux histogrammes en barres (barres simples, une seule teinte, comme
  `rotobib.html` — magnitude d'une seule série, pas besoin de palette
  catégorielle) : les **prêts totaux par année** (somme sur tous les
  exemplaires, mêmes 4 années réelles que l'histogramme par livre de
  Rotobib, déduites de `referenceYear` dans le rapport de build) et la
  **répartition des exemplaires par prêts cumulés** (paliers 0, 1, 2, 3, 4,
  5–9, 10+ — choisis d'après la distribution réelle : la traîne au-delà de
  9 ne représente qu'une quarantaine d'exemplaires, un seul palier « 10+ »
  suffit à la représenter sans la diluer en paliers vides). Survol/focus
  clavier sur chaque barre affiche une infobulle (`#chart-tooltip`, un seul
  élément repositionné en JS) avec le détail et la part en %.
- Une liste triable/filtrable de tous les exemplaires (titre, auteur, cote,
  prêts AN-3/AN-2/AN-1/AN, cumulés, réservations cumulées, code-barre) —
  même patron recherche + tri par colonne + pagination que `magasins.html`,
  triée par défaut sur les prêts cumulés décroissants : le livre le plus
  emprunté de l'export apparaît donc en première ligne sans manipulation.

## Stockage partagé (Cloudflare R2) et fonctions serverless

Bucket R2 `douai-patrimoine` (compte Cloudflare de l'utilisateur), utilisé
pour plusieurs choses indépendantes :

- **`xml/notices.xml`, `xml/exemplaires.xml`** : copie des exports Syracuse
  bruts, poussée par `npm run upload:xml` après chaque nouvel export. But :
  ne plus committer ces fichiers (60+ Mo à eux deux) dans git à chaque
  refresh. `scripts/build-inventory.mjs` les rapatrie automatiquement dans
  `data/xml/` avant de builder si les variables R2 sont présentes ; sinon
  (dev local sans `.env`), comportement d'origine inchangé — lecture des
  fichiers locaux, échec strict s'ils manquent.
- **`xml/bib.xml`** : export complet de la bibliothèque (format GESMARC,
  plusieurs centaines de Mo), poussé par `npm run upload:bib`. Source de
  `build-magasins.mjs` et `build-cotes-numeriques.mjs` (voir « Magasins
  2e/5e/6e étage » et « Cotes numériques » plus haut) — trop volumineux
  pour tenir dans une seule string JS (`r2Get(key, {raw:true})` renvoie un
  Buffer plutôt qu'une string décodée, écrit tel quel sur disque ; les deux
  scripts le relisent ensuite en flux via `iterateGesmarcItemsFromFile()`
  dans `scripts/lib/gesmarc.mjs`). `xml/magasin/exemplaires.xml.xml` et
  `xml/all/catalogue.xml` (anciennes sources de ces deux scripts avant
  2026-08-26) restent dans R2 mais ne sont plus lus par aucun script —
  `xml/magasin/notices.xml.xml` reste en revanche utilisé par
  `build-desherbage.mjs` (Rotobib).
- **`recolement.json`, `livres-spolies-overrides.json`, `exemplaires-manuels.json`,
  `reliures-manuelles.json`, `transferts-magasins.json`, `desherbage-traitements.json`** :
  état partagé canonique de `recolement.html` / `livres-spolies.html` /
  `exemplarisation.html` (voir « Exemplarisation rapide » plus haut) /
  `reliures.html` (voir « Récolement en cascade des documents reliés » plus
  haut) / `transfert-magasins.html` (voir « Transfert 2e étage → réserve
  patrimoniale » plus haut) / `rotobib.html` (voir « Rotobib » plus haut),
  pour que plusieurs collègues avancent en même
  temps sans export/import JSON manuel. Chaque page garde le `localStorage`
  comme source de vérité locale (fonctionne hors ligne, file d'attente
  `rp_*_pending_sync` rejouée à la reconnexion) et envoie en plus chaque
  changement en arrière-plan.
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

Sept fonctions Vercel (`api/recolement.mjs`, `api/spolies.mjs`,
`api/exemplaires-manuels.mjs`, `api/reliures-manuelles.mjs`,
`api/vignette.mjs`, `api/transferts.mjs`, `api/desherbage.mjs`) servent de proxy vers R2 :
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
S3 parsée à la main par regex, volontairement minimal). `r2Get(key,
{raw:true})` renvoie le corps en `Buffer` plutôt qu'en string décodée
UTF-8 — nécessaire pour `xml/bib.xml` (voir ci-dessus), dont la taille
dépasse la limite de longueur d'une string V8 (~512 Mo) : un
`.toString('utf8')` sur un buffer de cette taille lèverait
`ERR_STRING_TOO_LONG`. Variables
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

## Récolement des magasins d'étage (2e/5e étage, 2026-08-18 ; 6e étage, 2026-08-26)

En plus de la réserve patrimoniale et de la Réserve Douaisienne (toutes
deux au 1er étage), `recolement.html` couvre désormais le **Magasin — 2e
étage**, le **Magasin — 5e étage** et le **Magasin — 6e étage** : trois
locaux physiques supplémentaires, sélectionnables dans le même menu
déroulant que les deux premiers (`RESERVES` dans `js/reserve-shared.js`),
mais dont les documents sont catalogués à part dans `data/magasins.json`
(voir « Magasins 2e/5e/6e étage » plus haut) plutôt que dans
`data/inventaire.json`.

Même mécanisme que pour la Réserve Douaisienne : aucune nouvelle
infrastructure de stockage. Les trois magasins partagent la même clé R2
`recolement.json`, le même localStorage, la même API `/api/recolement`,
le même bouton de sauvegarde — la séparation entre les locaux ne vient
que du **préfixe des identifiants de travée** (`RD-` pour Douaisienne,
`M2-`/`M5-`/`M6-` pour les magasins, aucun préfixe pour la réserve
patrimoniale), qui garantit qu'un scan dans un local ne peut jamais
entrer en collision avec un scan dans un autre. `TRAVEES_MAGASIN2`/
`TRAVEES_MAGASIN5` (`js/reserve-shared.js`) portent la géométrie fournie
par l'équipe : 2e étage — travées `ALPHA` (14 colonnes), `BETA` (6),
`DELTA` (2), puis `I` à `XX` (5, 5, 5, 12, puis 14 pour `V` à `XVIII`, 8
pour `XIX`, 5 pour `XX`) ; 5e étage — travée `I` (6 colonnes), `II` à `V`
(5 chacune), `VI` à `XIX` (14 chacune), et une travée `ALPHA` à 1 seule
colonne. Valeurs listées telles quelles, aucune règle générale
sous-jacente. `TRAVEES_MAGASIN6` a d'abord réutilisé (2026-08-26) la
géométrie de `TRAVEES_MAGASIN5` en supposant que le 6e étage partageait le
même plan que le 5e ; corrigé le même jour avec la géométrie propre fournie
par l'équipe — travée `I` (5 colonnes), travées `II` à `XV` (11 colonnes
chacune). Chaque travée de
ces trois magasins porte aussi `maxEt:6` (au lieu du `DEFAULT_MAX_ETAGE=8`
de la réserve) : la quasi-totalité des travées des magasins d'étage font 6
étagères — une référence par défaut, pas un plafond dur (`maxEtageOf()`
s'étend automatiquement au-delà dès que des données réelles ou une
« dernière étagère » marquée dépassent cette valeur pour les travées qui
font exception ; côté récolement, le stepper étage n'a de toute façon
jamais de plafond pour une travée, voir plus loin). `displayTraveeId()`
dans `recolement.html` (et `travTitle()`/le libellé de travée dans
`reserve.html`) retirent ces préfixes `M2-`/`M5-`/`M6-` à l'affichage
(même traitement que `RD-`), donc le stepper travée et le plan affichent
« Alpha », « I », « XX »… sans le préfixe interne.

Reconnaissance de code-barre par un second catalogue : `RESERVES` porte
maintenant un champ `catalogGroup` (`'reserve'` pour
patrimoniale/douaisienne/horsreserve, `'magasin'` pour les magasins 2e,
5e et 6e étage — même catalogue partagé entre les trois, puisque
`data/magasins.json` n'est pas scindé par étage) et `catalogGroupOfReserve()`
le résout. Dans `recolement.html`, deux catalogues sont construits en
parallèle au chargement (`buildCatalogFromItems()`, factorisé à partir de
l'ancien code de chargement unique) : `catalogByGroup.reserve` (comme
avant : `data/inventaire.json` + exemplaires manuels + reliures) et
`catalogByGroup.magasin` (`data/magasins.json`). Depuis le passage à
`bib.xml` (2026-08-26), le fonds affiché par exemplaire n'est plus un
`fondsOverride` unique passé par `recolement.html` mais le champ
`_fondsLabel` posé directement par `build-magasins.mjs` (ex. « Magasin —
2e/5e étage (Adulte) », « Magasin — 6e étage (Jeunesse) ») —
`buildCatalogFromItems()` le préfère (`it._fondsLabel || fondsOverride ||
getFondsFromCote(cote)`), ce qui permet à un même catalogue partagé de
distinguer étage et secteur exemplaire par exemplaire, sans avoir besoin
de scinder `catalogByGroup.magasin` par étage. Les variables
globales `catalog`/`catalogNoticeCount`, utilisées partout ailleurs dans
le fichier (scan, cascade reliures, statistiques, listes avancées) sans
aucune modification de leur code, sont de simples pointeurs réassignés
vers le bon groupe par `syncActiveCatalog()` — appelée une fois les deux
catalogues chargés, puis à chaque changement de réserve dans le menu
déroulant. Concrètement : scanner un code-barre du magasin pendant que
« Magasin — 2e étage » est sélectionné affiche son titre/cote comme pour
un exemplaire de réserve ; les compteurs « Notices cataloguées »/
progression/« jamais scannés »/« scannés non catalogués » basculent avec
le catalogue actif (libellé de la carte « Notices cataloguées » lui-même
adapté via `st-catalog-label`) ; revenir sur la réserve patrimoniale
restaure exactement l'état/le catalogue d'avant, rien n'est partagé entre
les deux groupes. Seule la liste « codes-barres endommagés » reste
volontairement globale (non scindée par groupe) : c'est une liste
d'action à corriger, pas une comparaison catalogue.

`reserve.html` (le plan visuel, renommé « Plan des Magasins » à
l'introduction des magasins 2e/5e étage) visualise ces locaux. La page est
organisée en groupes de sections (`.room-group`, titre `<h2>`, plus gros
que les `.room-section-title` `<h3>`) : **Réserve** regroupe les quatre
sections déjà présentes (réserve patrimoniale, armoires, tiroirs, Réserve
Douaisienne, inchangées) ; **Magasin — 2e étage**, **Magasin — 5e étage**
et **Magasin — 6e étage** (ce dernier ajouté 2026-08-26) sont trois autres
groupes, chacun avec sa propre section et son propre plan
(`buildMagasin2()`/`buildMagasin5()`/`buildMagasin6()` dans `reserve.html`,
ajoutées à `buildPlan()` — même fonction `makeTraveeEl()` que pour la
réserve, aucune duplication de logique de rendu). Le panneau de détail
(`#detail`), les stats globales (`updateStats()`) et la recherche restent
uniques et partagés entre tous les groupes (fonctionnent par identifiant de
travée via `LOCATIONS_ALL`, indifférents à la section visuelle) — pas de
scoping par groupe comme pour le catalogue de `recolement.html` : demande
non faite, choix délibéré de rester simple. `selectTravee()` affiche un
badge « Magasin — 2e/5e/6e étage » selon le préfixe (même mécanique que le
badge « Réserve Douaisienne » existant) et les résultats de recherche
affichent un suffixe correspondant, pour lever l'ambiguïté entre une
« Travée I » de la réserve patrimoniale, de la Réserve Douaisienne, ou de
l'un des trois magasins (même chiffre romain réutilisé dans chaque local).

Avant l'introduction du magasin 2e étage, un instantané de l'état R2
`recolement.json` d'alors a été sauvegardé sous
`recolement-backups/2026-08-18_14h50m10s.json` (12 948 scans à cette
date) — même mécanisme que le bouton « Sauvegarder ce récolement »,
déclenché ici depuis un script Node ponctuel plutôt que depuis l'UI.

Les « Statistiques avancées du récolement » (bas de `recolement.html`,
2026-08-19) sont dupliquées en deux groupes indépendants — **Réserve**
(patrimoniale, Douaisienne, armoires, tiroirs, hors-réserve) et
**Magasins (2e/5e/6e étage)** — plutôt qu'un seul panneau global mélangeant
les deux : occupation des emplacements, stats de temps et les 3 listes à
problèmes (codes-barres endommagés, non catalogués à cote manuelle,
jamais scannés) sont donc calculées et affichées séparément pour chaque
groupe. Le groupe d'un scan est déterminé par `traveeGroupOf(travee)`
(même principe que `catalogGroupOfReserve()` côté catalogue) : toute
travée préfixée `M2-`/`M5-`/`M6-` est « magasin », tout le reste est
« réserve ». Le HTML des deux groupes (barre d'occupation, stats-row de
temps, 3 `<details>`) est généré une seule fois par
`advGroupTemplate()`/`advDetailsTemplate()` à partir de `ADV_GROUPS` et
`ADV_CATS` (deux tableaux/objets de configuration) plutôt qu'écrit deux
fois à la main dans le HTML statique — tous les identifiants DOM sont
suffixés `-reserve`/`-magasin` (ex. `adv-abime-reserve`,
`log-notscanned-magasin`). `damagedList()`, `manualCoteList()` et
`notScannedList()` prennent désormais un paramètre `group` ; les deux
dernières comparent contre `catalogByGroup[group]` (voir plus haut)
plutôt que contre la variable `catalog` active, donc les deux groupes
restent visibles et à jour simultanément, indépendamment de la réserve
actuellement sélectionnée dans le sélecteur d'emplacement (contrairement
au catalogue de reconnaissance au scan, qui lui reste un simple pointeur
basculé par `syncActiveCatalog()`). La clé de `resolvedIssues`
(`categorie|barcode`) n'inclut volontairement pas le groupe : un
code-barre donné n'appartient qu'à un seul groupe (via la travée de son
scan), aucune ambiguïté possible entre les deux panneaux.

Piège rencontré en construisant cette section (2026-08-19) : `ADV_GROUPS`/
`ADV_CATS` (et la ligne qui injecte le HTML dans `#adv-groups`) doivent être
déclarés **tôt** dans le script, juste après les blocs `Promise.all`/`fetch`
de chargement du catalogue — PAS avec le reste de la section "LISTES
AVANCÉES" plus bas (où logiquement ils semblent appartenir). Raison :
`updateStats()` (qui lit `ADV_GROUPS`) est déjà appelée pendant
l'initialisation synchrone de la page, dans `setLocType(loc.locType)` en fin
de section "EMPLACEMENT" — les déclarer plus bas provoque un
`ReferenceError` (temporal dead zone) dès le chargement, qui interrompt tout
le reste du script (plus aucun scan, mini-plan jamais construit). Les
fonctions (`damagedList`, `advDetailsTemplate`, etc.) n'ont pas ce problème
— elles sont hissées (hoisting des déclarations `function`) — seules les
`const` du haut de la section doivent rester tôt dans le fichier.

### Livres sans code-barre

`recolement.html` (2026-08-19) permet aussi de saisir la **cote** d'un
document qui n'a jamais eu de code-barre collé (fréquent dans les magasins
d'étage) — barre `#nobarcode-input` juste sous le scan de code-barre,
disponible pour tous les groupes (réserve et magasins). `handleNoBarcodeCote()`
vérifie la cote (normalisée par `normalizeCote()`, trim + majuscules) contre
`catalogCoteIndexByGroup[group]`, un index inverse cote→code-barre construit
une fois par catalogue (`buildCoteIndex()`, appelé juste après le chargement
de chaque `catalogByGroup`) :

- **Cote trouvée** : le document est récolé comme un scan normal — on
  appelle directement `handleScan(codeBarreTrouvé, false, {sansCodeBarre:true})`,
  qui pose `record.sansCodeBarre = true` (toute la mécanique dup/déplacé/
  cascade reliures s'applique normalement).
- **Cote absente** : pas de scan possible (aucun code-barre à associer),
  juste un enregistrement dans `noBarcodeCotes` (nouvelle catégorie du
  bundle `recolement.json`, clé = cote normalisée — pas un emplacement,
  contrairement à `nonCat`/`videShelves`/`nonRangeShelves`, puisque
  plusieurs cotes distinctes peuvent coexister sur le même emplacement) —
  aucun effet sur la progression/l'occupation, uniquement une entrée dans la
  liste d'export.

`noBarcodeList(group)` (utilisée par `ADV_CATS.nobarcode`, un 4e panneau
ajouté automatiquement aux deux groupes de "Statistiques avancées" via la
même génération de template que les 3 autres) réunit les deux sources :
`scans` filtrés par `sansCodeBarre` (cotes trouvées, comptées comme
récolées) et `noBarcodeCotes` (cotes absentes). Contrairement aux 3 autres
listes, **pas de suivi réglé/rouvert** (`ADV_CATS.nobarcode.resolvable:
false` — demande explicite, liste volontairement simple) : `advDetailsTemplate()`
et `refreshAdvList()` sautent la case "Afficher aussi les réglés" et la
colonne d'action quand `resolvable===false`. L'export (`exportField:'cote'`)
télécharge des **cotes**, pas des codes-barres — contrairement aux 3 autres
catégories — puisque le but est justement de savoir sur quels documents
recoller un code-barre.

`noBarcodeCotes` suit le même patron que les autres catégories du bundle
`recolement.json` : synchronisé vers R2 via un nouveau patch `noBarcode`
(`api/recolement.mjs`, clé = cote normalisée via `coteKey()`), inclus dans
`emptyState()`, `bulkMerge` et `exportPayload()`/`mergeIncomingData()` côté
client — un ancien export sans ce champ reste importable (`|| []`).

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
