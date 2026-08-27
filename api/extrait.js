
Extrait · JS
// Fonction serverless Vercel — génère un extrait de plan cadastral officiel
// en pilotant le Service de Consultation du Plan Cadastral (cadastre.gouv.fr).
// Logique adaptée de @etalab/api-scpc (MIT). Aucune donnée n'est stockée.
//
// ROTATION DE LA ZONE D'IMPRESSION — ajout du 29/07/2026.
// Le SCPC accepte un champ MAPROTATION que cette fonction laissait à 0 depuis
// l'origine. Il est piloté par le paramètre « rotation », en degrés. En
// l'ABSENCE du paramètre, le comportement est strictement identique à celui
// d'avant.
//
// CONVENTION ÉTABLIE EXPÉRIMENTALEMENT le 29/07/2026, sur cinq extraits de
// contrôle de la parcelle AV 168 à Saint-Omer, par la direction de la flèche du
// nord : la valeur est en DEGRÉS et une valeur POSITIVE fait tourner le contenu
// du plan dans le SENS DES AIGUILLES sur la page — +45° amène la flèche à
// 1 h 30, −45° à 10 h 30.
//
// L'EMPRISE AU SOL EST INVARIANTE, et c'est le second acquis de ces essais :
// mesuré à la règle sur les extraits imprimés, 100 m de terrain occupent 100 mm
// de papier au 1/1000 que le plan soit droit ou tourné (et 141 mm entre deux
// étiquettes lues LE LONG DU BORD sur un plan à 45°, ce qui est la même chose
// divisée par sin 45°). Le service déduit donc son emprise de RFV_X / RFV_Y,
// ECHELLE et TAILLEPAGE, et NON de la taille de MAPBBOX. Le cartouche est
// exact : aucune pièce produite n'est à une autre échelle que celle annoncée.
// ⚠ NE PAS RÉINTRODUIRE de paramètre destiné à élargir MAPBBOX en fonction de la
// rotation : une variante « cadre englobant » a été écrite puis retirée le
// 29/07/2026, les essais ayant montré qu'il n'y a rien à élargir. Un paramètre
// sans effet est un piège pour le prochain lecteur.
//
// RAPPEL DU PIÈGE MAISON : le service sert SILENCIEUSEMENT une valeur de repli
// quand un paramètre ne lui plaît pas — une demande à 1/10000 revient à 1/1000
// sans un mot. Ne jamais conclure d'un PDF non tourné que la rotation « ne
// marche pas » : vérifier d'abord, par les en-têtes de réponse ou par ?diag=1,
// ce qui a réellement été envoyé.
 
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
 
/**
 * NOMS DE COMMUNE À PRÉSENTER AU SCPC — liste ORDONNÉE, du plus probable au
 * moins probable. La recherche s'arrête au PREMIER nom qui rend un résultat ;
 * un nom de trop ne coûte qu'un aller-retour, un nom manquant coûte un échec
 * au libellé trompeur.
 *
 * a) Le SCPC attend un nom ASCII où les tirets ET les apostrophes sont remplacés
 *    par une espace (ex. « VILLENEUVE D ASCQ », « SAINT OMER »). Inchangé.
 *
 * b) ⚠ ARRONDISSEMENTS MUNICIPAUX DE PARIS, LYON ET MARSEILLE — défaut trouvé
 *    le 27/08/2026 sur PARIS 16 section FJ n° 25. La parcelle est BIEN RÉELLE :
 *    l'API Carto de l'IGN sert l'IDU 75116000FJ0025, 302 m². nomCommune
 *    interroge geo.api.gouv.fr, qui rend le libellé INSEE « Paris 16e
 *    Arrondissement » ; le SCPC, lui, nomme ces communes « PARIS 16 » — c'est
 *    l'exemple imprimé dans son propre champ de saisie : « Rennes, Paris 9 ».
 *    Aucune variante de tiret ou d'apostrophe ne transformait l'un en l'autre :
 *    la recherche revenait vide et « parcelle introuvable pour ces références »
 *    accusait à tort la référence. Le défaut touche 45 communes cadastrales —
 *    Paris 1 à 20, Lyon 1 à 9, Marseille 1 à 16 — donc tout Paris intra-muros.
 *
 *    ⚠ NE PAS « CORRIGER » EN REPLIANT SUR LA COMMUNE PARENT. Interroger 75056
 *    « PARIS » a été essayé le même jour : la recherche revient vide elle aussi.
 *    Pour le SCPC comme pour la DGFiP, la commune EST l'arrondissement, et l'IDU
 *    le dit — ses cinq premiers caractères valent 75116, non 75056. Seul
 *    geo.api.gouv.fr, source INSEE, voit là un arrondissement d'une commune.
 */
function variantesCommune(base) {
  // Variantes historiques : tirets et apostrophes.
  const liaisons = [
    base,
    base.replace(/-/g, ' '),
    base.replace(/['\u2019]/g, ' '),
    base.replace(/[-'\u2019]/g, ' ').replace(/\s+/g, ' '),
    base.replace(/['\u2019]/g, '')
  ];
  // Variantes d'arrondissement, placées EN TÊTE quand le libellé en est un.
  const arrondissement = [];
  const m = liaisons[3].match(/^(.+?)\s+(\d{1,2})\s*(?:ER|EME|E)?\s+ARRONDISSEMENT$/);
  if (m) {
    const ville = m[1].trim(), n = m[2];
    arrondissement.push(`${ville} ${n}`, `${ville} ${n}E`, `${ville} ${n}EME`);
    // « PARIS 1ER » plutôt que « PARIS 1E » : le premier arrondissement est le
    // seul dont l'ordinal s'écrit autrement, et l'oublier ferait échouer les
    // trois premiers arrondissements de chaque ville sans raison visible.
    if (n === '1') arrondissement.push(`${ville} 1ER`);
  }
  return [...new Set([...arrondissement, ...liaisons].map(s => s.trim()))].filter(Boolean);
}
 
/**
 * Angle ramené dans (-90, 90]. Un demi-tour ne change ni l'emprise ni la
 * lisibilité d'un plan cadastral, et le service n'a pas à recevoir de valeurs
 * qu'il pourrait refuser. Les cas dégénérés — chaîne vide, texte, NaN —
 * retombent sur 0 et jamais sur une erreur : un lien mal formé doit produire
 * l'extrait droit, pas un échec.
 */
function normaliserRotation(v) {
  if (v === undefined || v === null || v === '') return 0;
  let a = parseFloat(String(v).replace(',', '.'));
  if (!Number.isFinite(a)) return 0;
  a = ((a % 180) + 180) % 180;          // dans [0, 180)
  if (a > 90) a -= 180;                 // dans (-90, 90]
  return Math.round(a * 100) / 100;     // le centième de degré suffit
}
 
/**
 * Emprise au sol de la page. MAP_SIZES est en centièmes de millimètre de
 * papier : divisé par 100 000 il donne des mètres de papier, multiplié par
 * l'échelle des mètres de terrain (A4 portrait au 1/1000 = 195,5 × 211,0 m,
 * valeurs relevées sur le service). Indépendante de la rotation, voir l'en-tête.
 */
function computeBbox({ x, y, taille, orientation, echelle }) {
  const { width, height } = MAP_SIZES[`${taille}-${orientation}`];
  const l = (width / 100000) * echelle;
  const h = (height / 100000) * echelle;
  return {
    xMin: x - l / 2, xMax: x + l / 2,
    yMin: y - h / 2, yMax: y + h / 2,
    page_m: [Math.round(l * 10) / 10, Math.round(h * 10) / 10]
  };
}
 
async function nomCommune(code) {
  const r = await request.get(`https://geo.api.gouv.fr/communes/${encodeURIComponent(code)}`)
    .query({ fields: 'nom' }).timeout(T).ok(res => res.status < 500);
  if (!r.body || !r.body.nom) { const e = new Error('Commune INSEE inconnue'); e.statusCode = 400; throw e; }
  return r.body.nom;
}
 
/**
 * mode = 'pdf'   : chaîne complète, renvoie le buffer PDF (usage normal)
 *      = 'debug' : s'arrête après la RECHERCHE, renvoie le repérage feuille /
 *                  parcelle et un extrait de la page (diagnostic historique)
 *      = 'diag'  : va jusqu'au bord de l'IMPRESSION et renvoie le formulaire
 *                  EXACT qui aurait été posté, sans le poster. C'est la seule
 *                  façon de savoir ce que le programme envoie réellement, sans
 *                  rien avoir à déduire du PDF obtenu. C'est par là qu'a été
 *                  établie la convention de rotation.
 */
async function fetchExtrait(params, mode = 'pdf') {
  for (const p of ['commune', 'prefixe', 'section', 'parcelle']) {
    if (!params[p]) { const e = new Error(`Paramètre '${p}' obligatoire`); e.statusCode = 400; throw e; }
  }
  const { commune, prefixe, section, parcelle } = params;
  const echelle = params.echelle ? parseInt(params.echelle, 10) : 1000;
  const orientation = params.orientation === 'paysage' ? 'Paysage' : 'Portrait';
  const taille = params.taille === 'A3' ? 'A3' : 'A4';
  const rotation = normaliserRotation(params.rotation);
  const codeDep = codeDepartement(commune).padStart(3, '0');
 
  let step = 'commune';
  try {
    const base = deburr(await nomCommune(commune)).toUpperCase().trim();
    // On teste plusieurs noms et on garde le PREMIER qui rend un résultat. Voir
    // variantesCommune : tirets, apostrophes, et arrondissements municipaux de
    // Paris, Lyon et Marseille.
    const variantes = variantesCommune(base);
 
    const agent = request.agent();
 
    step = 'jeton';
    const tokenPage = await agent.get(`${SCPC}/rechercherParReferenceCadastrale.do`).set('User-Agent', UA).timeout(T);
    const m = tokenPage.text.match(/CSRF_TOKEN=((?:[\dA-Z]{4}-){7}[\dA-Z]{4})/);
    if (!m) { const e = new Error('jeton CSRF introuvable (le service a peut-être changé)'); e.statusCode = 502; throw e; }
    const csrf = m[1];
 
    step = 'formulaire';
    await agent.get(`${SCPC}/afficherRechercherPlanCad.do?CSRF_TOKEN=${csrf}&`).set('User-Agent', UA).timeout(T);
 
    step = 'recherche';
    let search, feuille, parc, villeRetenue = null;
    for (const ville of variantes) {
      search = await agent.post(`${SCPC}/rechercherParReferenceCadastrale.do?CSRF_TOKEN=${csrf}`)
        .set('User-Agent', UA).type('form').timeout(T)
        .send({ ville, codeDepartement: codeDep, rechercheType: 1, prefixeParcelle: prefixe,
          sectionLibelle: section, numeroParcelle: parcelle, prefixeFeuille: prefixe, CSRF_TOKEN: csrf });
      feuille = search.text.match(/f=([A-Z\d]{12})/);
      parc = search.text.match(/p=([A-Z\d]{14})/);
      if (feuille && parc) { villeRetenue = ville; break; }
    }
 
    if (mode === 'debug') {
      return { __debug: true, commune, nomInsee: base, variantes, villeRetenue,
        codeDep, feuille: feuille ? feuille[1] : null,
        parcelle: parc ? parc[1] : null, searchLen: search ? search.text.length : 0,
        extrait: search ? search.text.slice(0, 4000) : null };
    }
    if (!feuille || !parc) { const e = new Error('parcelle introuvable pour ces références'); e.statusCode = 404; throw e; }
 
    step = 'carte';
    const map = await agent.get(`${SCPC}/afficherCarteParcelle.do?CSRF_TOKEN=${csrf}&p=${parc[1]}&f=${feuille[1]}&dontSaveLastForward&keepVolatileSession=`)
      .set('User-Agent', UA).timeout(T);
    const pt = map.text.match(/new Point\((.*),(.*)\)/);
    if (!pt || !pt[1] || !pt[2]) { const e = new Error('centre de la parcelle introuvable'); e.statusCode = 502; throw e; }
    const centreDuService = { x: parseFloat(pt[1]), y: parseFloat(pt[2]) };
 
    // ------------------------------------------------------------------------
    // GARDE-FOU DE ZONE — 29/07/2026, BOUE (Aisne, INSEE 02103, section A 152).
    // Un centre imposé calculé dans la MAUVAISE ZONE conique conforme place
    // MAPBBOX à des centaines de kilomètres du bon endroit, et le service ne
    // renvoie alors AUCUN PDF : échec dur, non transitoire, au libellé trompeur
    // (« le service n'a pas renvoyé de PDF », qu'on prend pour une limitation de
    // débit). Mesuré à Boue : y imposé 9 202 457,5 en CC50 contre 8 313 570,5
    // servi en CC49, soit 888 887 m d'écart — exactement 1 000 000 (les origines
    // Y sont séparées d'un million pile) moins 111 113 (le déplacement du
    // parallèle d'origine d'un degré). En X, 110 m seulement : les zones
    // partagent le méridien central, donc SEUL L'AXE VERTICAL PART EN VRILLE.
    //
    // CAUSE DE FOND, NON CORRIGÉE ICI : les zones se RECOUVRENT d'un degré —
    // CC49 couvre 48–50, CC50 couvre 49–51 — et dans le recouvrement les deux
    // sont géodésiquement valables. C'est la DGFiP qui tranche, FEUILLE PAR
    // FEUILLE. Aucune règle sur la latitude ne peut le deviner : Boue est à
    // 49,93°, donc arrondi à 50, mais le service dit CC49. L'hypothèse « zone
    // déduite de la latitude arrondie » du mémo REDPAR v5 est donc FAUSSE dans
    // la bande de recouvrement. À traiter côté REDPAR / PAINT.
    //
    // CE GARDE-FOU transforme l'échec dur en plan CORRECT mais NON RECENTRÉ :
    // mieux vaut un extrait centré par le service qu'aucun extrait. Le repli est
    // MOTIVÉ ET VISIBLE — en-tête X-Paint-Centre et champ du mode diag —, jamais
    // silencieux : un recentrage abandonné sans le dire produirait une pièce dont
    // le cadrage ne serait pas celui demandé.
    // SEUIL 20 km : très au-dessus de tout décalage légitime (le plus grand
    // cadre du service couvre 1 580 m, donc un centre d'unité foncière ne peut
    // s'écarter que de quelques centaines de mètres du centre de la parcelle
    // interrogée) et très au-dessous des 889 km d'une erreur de zone.
    // ------------------------------------------------------------------------
    const SEUIL_ZONE_M = 20000;
    let centreRefuse = null;
    let x = params.x ? parseFloat(params.x) : centreDuService.x;
    let y = params.y ? parseFloat(params.y) : centreDuService.y;
    if (Number.isFinite(x) && Number.isFinite(y)
        && (Math.abs(x - centreDuService.x) > SEUIL_ZONE_M
         || Math.abs(y - centreDuService.y) > SEUIL_ZONE_M)) {
      centreRefuse = {
        x, y,
        ecart_x: Math.round(x - centreDuService.x),
        ecart_y: Math.round(y - centreDuService.y),
        raison: 'centre imposé à plus de 20 km du centre servi — zone conique '
              + 'conforme probablement différente de celle du service ; centre '
              + 'imposé IGNORÉ, plan centré par le service'
      };
      x = centreDuService.x;
      y = centreDuService.y;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) { x = centreDuService.x; y = centreDuService.y; }
    const boite = computeBbox({ x, y, taille, orientation, echelle });
    const { xMin, xMax, yMin, yMax } = boite;
 
    // Formulaire d'impression, monté une fois et réutilisé par ?diag=1 : le
    // diagnostic doit porter sur l'objet RÉELLEMENT posté, et non sur une copie
    // reconstituée à côté, qui divergerait au premier correctif.
    const formulaire = {
      MAPBBOX: [xMin, yMin, xMax, yMax].map(c => c.toFixed(3)).join(','),
      MAPROTATION: rotation,
      TAILLEPAGE: taille, ORIENTPAGE: orientation, RFV_REF: '',
      RFV_X: x.toFixed(3), RFV_Y: y.toFixed(3),
      ECHELLE: echelle, NATURE: 'V', RESOLUTION: '', DRAPEAU: 'false', CSRF_TOKEN: csrf
    };
 
    if (mode === 'diag') {
      return { __diag: true, commune: { code: commune, nomInsee: base, villeRetenue },
        voie: { rotation, echelle, taille, orientation },
        centre_du_service: centreDuService, centre_utilise: { x, y },
        centre_impose: Boolean(params.x && params.y) && !centreRefuse,
        centre_refuse: centreRefuse, page_m: boite.page_m,
        feuille: feuille[1], parcelle: parc[1],
        formulaire: { ...formulaire, CSRF_TOKEN: '(masqué)' } };
    }
 
    step = 'impression';
    const pdf = await agent.post(`${SCPC}/imprimerExtraitCadastral.do?CSRF_TOKEN=${csrf}`)
      .set('User-Agent', UA).type('form').timeout(T).buffer(true)
      .send(formulaire);
 
    if (pdf.type !== 'application/pdf') { const e = new Error('le service n\'a pas renvoyé de PDF'); e.statusCode = 502; throw e; }
    return { pdf: pdf.body, voie: { rotation, echelle, taille, orientation },
      bbox: formulaire.MAPBBOX, page_m: boite.page_m, centreRefuse, villeRetenue };
  } catch (e) {
    if (e.statusCode) throw e; // erreur métier déjà formée
    const err = new Error(`étape « ${step} » : ${e.timeout ? 'délai dépassé' : (e.message || 'erreur réseau')}`);
    err.statusCode = 504; throw err;
  }
}
 
// En-têtes de traçabilité, portés par TOUTE réponse PDF. Le PDF ne dit pas de
// lui-même sous quelle rotation il a été demandé ; ces en-têtes le disent, et se
// lisent dans l'onglet Réseau du navigateur. Access-Control-Expose-Headers est
// nécessaire pour qu'un appel venu d'un autre domaine, REDPAR, puisse les lire :
// sans lui le navigateur les masque.
function tracer(res, v) {
  if (!v || !v.voie) return;
  res.setHeader('X-Paint-Rotation', String(v.voie.rotation));
  res.setHeader('X-Paint-Echelle', String(v.voie.echelle));
  res.setHeader('X-Paint-Page', `${v.voie.taille}-${v.voie.orientation}`);
  if (v.bbox) res.setHeader('X-Paint-Bbox', v.bbox);
  if (v.page_m) res.setHeader('X-Paint-Page-M', v.page_m.join('x'));
  // Le nom RÉELLEMENT accepté par le SCPC. Sans lui, une commune servie par une
  // variante de repli ressemble à une commune servie du premier coup, et le jour
  // où le service renomme ses communes personne ne le voit venir.
  if (v.villeRetenue) res.setHeader('X-Paint-Commune', v.villeRetenue);
  // Le repli de zone doit être LISIBLE par l'appelant, sinon il est silencieux.
  res.setHeader('X-Paint-Centre', v.centreRefuse
    ? `service (impose ignore, ecart ${v.centreRefuse.ecart_x}x${v.centreRefuse.ecart_y} m)`
    : 'utilise');
  res.setHeader('Access-Control-Expose-Headers',
    'X-Paint-Rotation, X-Paint-Echelle, X-Paint-Page, X-Paint-Bbox, X-Paint-Page-M, '
    + 'X-Paint-Centre, X-Paint-Commune');
}
 
module.exports = async (req, res) => {
  const q = req.query || {};
  try {
    if (q.debug || q.diag) {
      const d = await fetchExtrait(q, q.diag ? 'diag' : 'debug');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(d); return;
    }
    const r = await fetchExtrait(q);
    tracer(res, r);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(r.pdf);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message || 'Erreur interne' });
  }
};
 

