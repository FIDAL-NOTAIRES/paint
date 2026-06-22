# PAINT — Vos plans en couleurs

Outil de colorisation de plans cadastraux pour FIDAL Notaires. Tout le traitement
des images (colorisation, OCR, annotations, export) se fait dans le navigateur.
La seule partie serveur est la **génération de l'extrait officiel** depuis des
références cadastrales, qui passe par une fonction serverless (le site
`cadastre.gouv.fr` n'autorise pas les appels directs depuis un navigateur).

## Structure du dépôt

```
/
  index.html        → l'application (à ouvrir / déployer telle quelle)
  api/extrait.js    → fonction serverless Vercel : génère l'extrait officiel PDF
  package.json      → dépendance de la fonction (superagent)
  vercel.json       → durée max de la fonction
```

## Déploiement (Vercel)

1. Crée un dépôt GitHub et dépose ces fichiers à la racine (glisser-déposer via
   l'interface GitHub, comme pour tes autres apps).
2. Sur Vercel : *New Project* → importe le dépôt → *Deploy*. Vercel détecte
   automatiquement `api/extrait.js` comme fonction et installe `superagent`.
3. C'est tout : `index.html` est servi en statique, la génération appelle
   `/api/extrait` sur le même domaine (aucun CORS à gérer).

## Utilisation

- **Déposer un PDF** ou **cliquer la carte** d'accueil → colorisation manuelle,
  recherche de parcelles par numéro (OCR), rotation, annotations, export PNG/PDF.
- **Générer l'extrait officiel** : saisir commune (INSEE), préfixe (`000` par
  défaut), section, parcelle, échelle et format → le plan officiel se charge
  directement dans PAINT.

## Notes / limites

- **Fonction de génération** : `api/extrait.js` pilote le Service de Consultation
  du Plan Cadastral de la DGFiP (logique reprise du projet open-source
  `@etalab/api-scpc`, licence MIT). C'est un mécanisme non officiel qui dépend du
  comportement interne de `cadastre.gouv.fr` ; si la DGFiP modifie son site, la
  fonction peut nécessiter une mise à jour des expressions de recherche.
- Si la génération renvoie une erreur de type CSRF/feuille introuvable alors que
  les références sont bonnes, c'est généralement que le site a changé, ou que les
  IP du datacenter Vercel sont temporairement filtrées.
- `maxDuration` est fixé à 30 s (le SCPC enchaîne plusieurs requêtes). Sur le plan
  gratuit Vercel, abaisse à 10 s si le déploiement le refuse.
- La génération **ne fonctionne pas dans l'aperçu intégré** (pas de fonction
  serveur) ni en simple ouverture locale du fichier : elle nécessite le
  déploiement Vercel. Le reste de l'application fonctionne partout.
- Aucune donnée n'est stockée côté serveur ; la fonction ne fait que relayer la
  demande vers le service public et renvoyer le PDF.
