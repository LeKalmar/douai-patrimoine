# Archive

Pages retirées du site actif mais conservées pour référence. Aucune n'est
liée depuis une page live — ne pas les réintégrer sans vérifier leurs
dépendances (chemins relatifs, CSS, données).

- **inventaire.html** — ancienne page autonome de l'inventaire, remplacée par
  l'accordéon « Trouver un document » de `index.html` (piloté par
  `js/inventaire.js` + `data/inventaire.json`). Référence encore
  `csv/inventaire.csv`, qui n'existe plus.
- **thematiques/** — section « Collections thématiques » retirée de
  `index.html` (voir historique git). 6 des 7 pages sont vides (jamais
  rédigées) ; `plumes.html` (« Auteurs douaisiens ») a du contenu complet.
  Les chemins relatifs (`../style.css`, `../index.html`) pointent un niveau
  trop haut depuis cet emplacement archivé — à corriger si la page est un
  jour restaurée.
- **venir.html** — fichier vide, jamais référencé. Le contenu « Venir
  consulter » vit désormais dans l'accordéon du même nom sur `index.html`.
