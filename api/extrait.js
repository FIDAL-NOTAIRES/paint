// Fonction serverless Vercel — génère un extrait de plan cadastral officiel
// en pilotant le Service de Consultation du Plan Cadastral (cadastre.gouv.fr).
// Logique adaptée de @etalab/api-scpc (MIT). Aucune donnée n'est stockée.

const request = require('superagent');

const SCPC = 'https://www.cadastre.gouv.fr/scpc';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const T = { response: 18000, deadline: 26000 }; // délais par requête

const MAP_SIZES = {
  'A3-Paysage':  { width: 31600, height: 28300 },
  'A3-Portrait': { width: 28150, height: 30100 },
  'A4-Paysage':  { width: 21070, height: 19700 },
  'A4-Portrait': { width: 19550, height: 21100 }
};

// Retire les accents ET les ligatures (œ→oe, æ→ae) : NFD ne décompose pas
// les ligatures précomposées, il faut donc les traiter explicitement.
// Sans cela, une commune comme « Marcq-en-Barœul » est envoyée au SCPC avec
// le Œ, ne matche pas « MARCQ EN BAROEUL » et renvoie « aucun résultat ».
function deburr(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/Œ/g, 'OE').replace(/œ/g, 'oe')
    .replace(/Æ/g, 'AE').replace(/æ/g, 'ae');
}
function codeDepartement(c) { return c.startsWith('97') ? c.slice(0, 3) : c.slice(0, 2); }
function computeBbox({ x, y, taille, orientation, echelle }) {
  const { width, height } = MAP_SIZES[`${taille}-${orientation}`];
  return {
    xMin: x - (width / 100000) * echelle / 2, xMax: x + (width / 100000) * echelle / 2,
    yMin: y - (height / 100000) * echelle / 2, yMax: y + (height / 100000) * echelle / 2
  };
}

async function nomCommune(code) {
  const r = await request.get(`https://geo.api.gouv.fr/communes/${encodeURIComponent(code)}`)
    .query({ fields: 'nom' }).timeout(T).ok(res => res.status < 500);
  if (!r.body || !r.body.nom) { const e = new Error('Commune INSEE inconnue'); e.statusCode = 400; throw e; }
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
  const codeDep = codeDepartement(commune).padStart(3, '0');

  let step = 'commune';
  try {
    const base = deburr(await nomCommune(commune)).toUpperCase().trim();
    // Le SCPC attend un nom ASCII où les tirets ET les apostrophes sont remplacés
    // par une espace (ex. « VILLENEUVE D ASCQ », « SAINT OMER »). On teste plusieurs
    // variantes et on garde la première qui renvoie un résultat.
    const variantes = [...new Set([
      base,
      base.replace(/-/g, ' '),
      base.replace(/['\u2019]/g, ' '),
      base.replace(/[-'\u2019]/g, ' ').replace(/\s+/g, ' '),
      base.replace(/['\u2019]/g, '')
    ].map(s => s.trim()))];

    const agent = request.agent();

    step = 'jeton';
    const tokenPage = await agent.get(`${SCPC}/rechercherParReferenceCadastrale.do`).set('User-Agent', UA).timeout(T);
    const m = tokenPage.text.match(/CSRF_TOKEN=((?:[\dA-Z]{4}-){7}[\dA-Z]{4})/);
    if (!m) { const e = new Error('jeton CSRF introuvable (le service a peut-être changé)'); e.statusCode = 502; throw e; }
    const csrf = m[1];

    step = 'formulaire';
    await agent.get(`${SCPC}/afficherRechercherPlanCad.do?CSRF_TOKEN=${csrf}&`).set('User-Agent', UA).timeout(T);

    step = 'recherche';
    let search, feuille, parc;
    for (const ville of variantes) {
      search = await agent.post(`${SCPC}/rechercherParReferenceCadastrale.do?CSRF_TOKEN=${csrf}`)
        .set('User-Agent', UA).type('form').timeout(T)
        .send({ ville, codeDepartement: codeDep, rechercheType: 1, prefixeParcelle: prefixe,
          sectionLibelle: section, numeroParcelle: parcelle, prefixeFeuille: prefixe, CSRF_TOKEN: csrf });
      feuille = search.text.match(/f=([A-Z\d]{12})/);
      parc = search.text.match(/p=([A-Z\d]{14})/);
      if (feuille && parc) break;
    }

    if (debug) {
      return { __debug: true, commune, codeDep, variantes, feuille: feuille ? feuille[1] : null,
        parcelle: parc ? parc[1] : null, searchLen: search ? search.text.length : 0,
        extrait: search ? search.text.slice(0, 4000) : null };
    }
    if (!feuille || !parc) { const e = new Error('parcelle introuvable pour ces références'); e.statusCode = 404; throw e; }

    step = 'carte';
    const map = await agent.get(`${SCPC}/afficherCarteParcelle.do?CSRF_TOKEN=${csrf}&p=${parc[1]}&f=${feuille[1]}&dontSaveLastForward&keepVolatileSession=`)
      .set('User-Agent', UA).timeout(T);
    const pt = map.text.match(/new Point\((.*),(.*)\)/);
    if (!pt || !pt[1] || !pt[2]) { const e = new Error('centre de la parcelle introuvable'); e.statusCode = 502; throw e; }
    const x = params.x ? parseFloat(params.x) : parseFloat(pt[1]);
    const y = params.y ? parseFloat(params.y) : parseFloat(pt[2]);
    const { xMin, xMax, yMin, yMax } = computeBbox({ x, y, taille, orientation, echelle });

    step = 'impression';
    const pdf = await agent.post(`${SCPC}/imprimerExtraitCadastral.do?CSRF_TOKEN=${csrf}`)
      .set('User-Agent', UA).type('form').timeout(T).buffer(true)
      .send({ MAPBBOX: [xMin, yMin, xMax, yMax].map(c => c.toFixed(3)).join(','), MAPROTATION: 0,
        TAILLEPAGE: taille, ORIENTPAGE: orientation, RFV_REF: '', RFV_X: x.toFixed(3), RFV_Y: y.toFixed(3),
        ECHELLE: echelle, NATURE: 'V', RESOLUTION: '', DRAPEAU: 'false', CSRF_TOKEN: csrf });

    if (pdf.type !== 'application/pdf') { const e = new Error('le service n\'a pas renvoyé de PDF'); e.statusCode = 502; throw e; }
    return pdf.body;
  } catch (e) {
    if (e.statusCode) throw e; // erreur métier déjà formée
    const err = new Error(`étape « ${step} » : ${e.timeout ? 'délai dépassé' : (e.message || 'erreur réseau')}`);
    err.statusCode = 504; throw err;
  }
}

module.exports = async (req, res) => {
  const q = req.query || {};
  try {
    if (q.debug) {
      const d = await fetchExtrait(q, true);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(d); return;
    }
    const buf = await fetchExtrait(q);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(buf);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Erreur interne' });
  }
};
