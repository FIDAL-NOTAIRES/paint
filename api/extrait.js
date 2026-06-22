// Fonction serverless Vercel — génère un extrait de plan cadastral officiel
// en pilotant le Service de Consultation du Plan Cadastral (cadastre.gouv.fr).
// Logique adaptée de @etalab/api-scpc (MIT). Aucune donnée n'est stockée.

const request = require('superagent');

const SCPC = 'https://www.cadastre.gouv.fr/scpc';

// Emprises de page (en projection légale CC, unités x100), par format/orientation
const MAP_SIZES = {
  'A3-Paysage':  { width: 31600, height: 28300 },
  'A3-Portrait': { width: 28150, height: 30100 },
  'A4-Paysage':  { width: 21070, height: 19700 },
  'A4-Portrait': { width: 19550, height: 21100 }
};

function deburr(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function codeDepartement(codeCommune) {
  return codeCommune.startsWith('97') ? codeCommune.slice(0, 3) : codeCommune.slice(0, 2);
}
function computeBbox({ x, y, taille, orientation, echelle }) {
  const { width, height } = MAP_SIZES[`${taille}-${orientation}`];
  return {
    xMin: x - (width / 100000) * echelle / 2,
    xMax: x + (width / 100000) * echelle / 2,
    yMin: y - (height / 100000) * echelle / 2,
    yMax: y + (height / 100000) * echelle / 2
  };
}

// Récupère le nom de la commune depuis l'API Géo officielle (évite d'embarquer
// le fichier des 35 000 communes dans la fonction).
async function nomCommune(code) {
  const r = await request
    .get(`https://geo.api.gouv.fr/communes/${encodeURIComponent(code)}`)
    .query({ fields: 'nom' })
    .ok(res => res.status < 500);
  if (!r.body || !r.body.nom) {
    const e = new Error('Commune INSEE inconnue'); e.statusCode = 400; throw e;
  }
  return r.body.nom;
}

async function fetchExtrait(params, debug) {
  for (const p of ['commune', 'prefixe', 'section', 'parcelle']) {
    if (!params[p]) { const e = new Error(`Paramètre '${p}' obligatoire`); e.statusCode = 400; throw e; }
  }
  const { commune, prefixe, section, parcelle } = params;
  const echelle = params.echelle ? parseInt(params.echelle, 10) : 1000;
  const orientation = params.orientation === 'paysage' ? 'Paysage' : 'Portrait';
  const taille = params.taille === 'A3' ? 'A3' : 'A4';

  const nomBrut = await nomCommune(commune);
  // Le SCPC attend le libellé sans accent, en majuscules. On garde le tiret tel quel ;
  // on tentera une variante "sans tiret" si la 1re recherche ne donne rien.
  const villePrincipale = deburr(nomBrut).toUpperCase();
  const codeDep = codeDepartement(commune).padStart(3, '0');

  const agent = request.agent(); // conserve les cookies de session entre les appels

  // 1) Jeton CSRF
  const tokenPage = await agent.get(`${SCPC}/rechercherParReferenceCadastrale.do`);
  const m = tokenPage.text.match(/CSRF_TOKEN=((?:[\dA-Z]{4}-){7}[\dA-Z]{4})/);
  if (!m) { const e = new Error('Jeton CSRF introuvable (le service a peut-être changé)'); e.statusCode = 502; throw e; }
  const csrf = m[1];

  // 2) Affichage du formulaire de recherche
  await agent.get(`${SCPC}/afficherRechercherPlanCad.do?CSRF_TOKEN=${csrf}&`);

  // 3) Recherche par référence cadastrale — on essaie plusieurs variantes du nom
  const variantes = [villePrincipale];
  if (villePrincipale.includes('-')) variantes.push(villePrincipale.replace(/-/g, ' '));
  if (villePrincipale.includes("'")) variantes.push(villePrincipale.replace(/'/g, ' '));

  let search, feuille, parc, villeUtilisee;
  for (const ville of variantes) {
    search = await agent
      .post(`${SCPC}/rechercherParReferenceCadastrale.do?CSRF_TOKEN=${csrf}`)
      .type('form')
      .send({
        ville,
        codeDepartement: codeDep,
        rechercheType: 1,
        prefixeParcelle: prefixe,
        sectionLibelle: section,
        numeroParcelle: parcelle,
        prefixeFeuille: prefixe,
        CSRF_TOKEN: csrf
      });
    feuille = search.text.match(/f=([A-Z\d]{12})/);
    parc = search.text.match(/p=([A-Z\d]{14})/);
    villeUtilisee = ville;
    if (feuille && parc) break;
  }

  // Mode diagnostic : renvoie ce que le site a répondu, sans générer de PDF.
  if (debug) {
    return {
      __debug: true,
      commune, codeDep, nomBrut, variantesTestees: variantes, villeUtilisee,
      csrfTrouve: true,
      searchStatus: search && search.status,
      searchLen: search && search.text ? search.text.length : 0,
      feuille: feuille ? feuille[1] : null,
      parcelle: parc ? parc[1] : null,
      extrait: search && search.text ? search.text.slice(0, 4000) : null
    };
  }

  if (!feuille || !parc) { const e = new Error('Parcelle introuvable pour ces références'); e.statusCode = 404; throw e; }

  // 4) Affichage de la carte → centre de la parcelle
  const map = await agent.get(
    `${SCPC}/afficherCarteParcelle.do?CSRF_TOKEN=${csrf}&p=${parc[1]}&f=${feuille[1]}&dontSaveLastForward&keepVolatileSession=`
  );
  const pt = map.text.match(/new Point\((.*),(.*)\)/);
  if (!pt || !pt[1] || !pt[2]) { const e = new Error('Centre de la parcelle introuvable'); e.statusCode = 502; throw e; }

  const x = params.x ? parseFloat(params.x) : parseFloat(pt[1]);
  const y = params.y ? parseFloat(params.y) : parseFloat(pt[2]);
  const { xMin, xMax, yMin, yMax } = computeBbox({ x, y, taille, orientation, echelle });

  // 5) Génération du PDF
  const pdf = await agent
    .post(`${SCPC}/imprimerExtraitCadastral.do?CSRF_TOKEN=${csrf}`)
    .type('form')
    .send({
      MAPBBOX: [xMin, yMin, xMax, yMax].map(c => c.toFixed(3)).join(','),
      MAPROTATION: 0,
      TAILLEPAGE: taille,
      ORIENTPAGE: orientation,
      RFV_REF: '',
      RFV_X: x.toFixed(3),
      RFV_Y: y.toFixed(3),
      ECHELLE: echelle,
      NATURE: 'V',
      RESOLUTION: '',
      DRAPEAU: 'false',
      CSRF_TOKEN: csrf
    })
    .buffer(true);

  if (pdf.type !== 'application/pdf') { const e = new Error('Le service n\'a pas renvoyé de PDF'); e.statusCode = 502; throw e; }
  return pdf.body;
}

module.exports = async (req, res) => {
  const q = req.query || {};
  try {
    if (q.debug) {
      const d = await fetchExtrait(q, true);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(d);
      return;
    }
    const buf = await fetchExtrait(q);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buf);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Erreur interne' });
  }
};
