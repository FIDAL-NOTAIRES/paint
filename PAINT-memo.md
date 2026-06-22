# PAINT — Mémo projet (v1.0)

**Objet** : application de colorisation de plans cadastraux + génération de
l'extrait officiel DGFiP. FIDAL Notaires. **Autonome** (aucune dépendance à REDPAR).
Nom de code : **PAINT** (ex-PASTEL). Sous-titre : « Vos plans en couleurs ».

## Stack & déploiement

- App mono-fichier `index.html` (tout-navigateur) + **1 fonction serverless Vercel**
  `api/extrait.js` (génération de l'extrait officiel uniquement).
- Dépôt Vercel **autonome** ; déploiement habituel : glisser-déposer les fichiers
  à la racine d'un dépôt GitHub → *New Project* sur Vercel → Deploy. Vercel détecte
  `api/` et installe la dépendance.
- Structure du dépôt :
  - `index.html` — l'application
  - `api/extrait.js` — fonction serverless (extrait officiel)
  - `package.json` — dépendance `superagent ^8.1.2`
  - `vercel.json` — `maxDuration` 30 s pour la fonction
  - `README.md` — notice de déploiement
- CDN front : pdf.js 3.11.174 (cdnjs), jsPDF 2.5.1 (cdnjs), Tesseract.js 5 (jsdelivr).

## Fonctionnalités (front, 100 % navigateur)

- **Chargement du plan** : dépôt PDF, clic sur la carte d'accueil, ou génération
  depuis références cadastrales.
- **Remplissage par zone** (flood fill scanline) jusqu'aux traits sombres ; 3 passes
  → teinte aussi les **boucles de chiffres enfermées** (ronds du 6, 0, 8, 9). Réglage
  « sensibilité des bords » (seuil de luminance).
- **Pinceau / gomme** : anneau dimensionné à l'outil (suit le zoom) + vignette
  thématique. **Texte** : curseur étiquette, pointe = ancre du label.
- **Recherche par numéro** : OCR Tesseract (filtre chiffres, mode texte épars),
  repère le numéro, amorce le remplissage sur un pixel blanc voisin (jamais sur le
  trait du chiffre). Message d'erreur listant les numéros introuvables.
- **Rotation 90°** (conserve couleurs + annotations, ré-rend le fond net).
- **Palette** : 12 teintes **sans jaune** (confusion avec le figuré des bâtiments).
  Défaut orange `#FF982D`. Sélecteur couleur personnalisée.
- **Annotations** : placer / déplacer / éditer (double-clic) / supprimer.
- Undo/redo (Ctrl+Z / Ctrl+Y), Tout effacer.
- **Export PNG / PDF** (A4 ajusté). Légende optionnelle ; position : « auto sous
  cadastre.gouv.fr » (repérage OCR) ou 4 coins au choix.

## Génération de l'extrait officiel — `api/extrait.js`

- Logique reprise du projet open-source **`@etalab/api-scpc`** (MIT). Pilote le
  Service de Consultation du Plan Cadastral (SCPC) de `cadastre.gouv.fr`.
- Paramètres : `commune` (INSEE), `prefixe` (`000` par défaut), `section`,
  `parcelle`, `echelle` (200…5000, déf. 1000), `taille` (A4/A3),
  `orientation` (portrait/paysage), `x`/`y` optionnels (recentrage).
- Nom de commune récupéré via `geo.api.gouv.fr/communes/{code}` (évite d'embarquer
  le fichier des 35 000 communes).
- Flux : jeton CSRF → `afficherRechercherPlanCad` → `rechercherParReferenceCadastrale`
  → extraction `f=` (12) / `p=` (14) → `afficherCarteParcelle` (centre via
  `new Point(x,y)`) → `imprimerExtraitCadastral` → buffer PDF.
- **CORS bloqué côté `cadastre.gouv.fr`** → fonction serveur **obligatoire**
  (impossible en tout-navigateur). PAINT appelle sa propre route `/api/extrait`.

## Limites / RGPD

- Traitement des images : 100 % navigateur, rien n'est stocké.
- Génération : simple relais vers un service public, aucune donnée stockée
  (équivalent à la saisie manuelle sur cadastre.gouv.fr). Réflexe validation DPO standard.
- Mécanisme de génération **non officiel** : dépend du comportement interne de
  `cadastre.gouv.fr` ; peut nécessiter une mise à jour des regex si la DGFiP modifie
  le site ; filtrage possible des IP datacenter Vercel.
- Génération **KO en aperçu intégré et en ouverture locale** (pas de fonction
  serveur) → nécessite le déploiement Vercel. Le reste fonctionne partout.

## À faire / suite

- Intégrer PAINT comme tuile du launcher **FIDAL Apps** (design system 78×78,
  teal/gold/navy) quand souhaité.
- Optionnel : entrée par **adresse** (géocodage BAN/IGN → références) en amont de la
  génération.
- Tester le rendu officiel après déploiement (ex. réf. Saint-Omer : commune 62765,
  section AV, parcelle 1).

## Session start

- Lire ce mémo et le dossier Drive **PAINT** (voir ID dans la mémoire).
- Toute modification de code : fournir le **fichier complet** prêt à coller (jamais de diff).
