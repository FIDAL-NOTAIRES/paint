/* ======================================================================
   HISTO-PONT — passerelle de PAINT vers HISTO (04/10/2026)
   ----------------------------------------------------------------------
   HISTO (généalogie cadastrale) a besoin, en tête de chaque section de son
   Word, d'un PLAN COLORISÉ des parcelles étudiées. Il ouvre PAINT dans un
   CADRE (iframe) de sa propre page, d'une autre origine, et dialogue par
   messages. Ce fichier ajoute à PAINT ce qui lui manquait pour ce dialogue,
   SANS toucher à sa mécanique : il s'appuie sur les fonctions globales que
   PAINT définit déjà (preremplirDepuisURL, window.capturePret,
   window.captureReserve, les canvas #base et #overlay).

   Chargé par une seule ligne dans index.html de PAINT, après le script
   principal :  <script defer src="histo-pont.js?v=3"></script>

   PROTOCOLE (le « destinataire » est window.parent, ou window.opener si
   PAINT a été ouvert dans un onglet) :
     1. PAINT est ouvert avec  ?charge=histo
        → le pont envoie { type:"paint-pret" } au destinataire ;
     2. HISTO répond { type:"paint-params", qs:"commune=…&section=…&poly=…&auto=1" }
        → le pont pose la chaîne dans la barre d'adresse (sans requête) et
          appelle preremplirDepuisURL() : la chaîne automatique de PAINT se
          déroule — extrait, calage, polygone peint, tableau ;
     3. fin de la chaîne : window.capturePret passe à vrai
        — sans réserve : le pont renvoie { type:"paint-image", png, largeur,
          hauteur } et c'est fini ;
        — avec réserve (window.captureReserve renseigné : colorisation non
          prouvée, refusée, repliée) : le pont renvoie
          { type:"paint-attente-manuelle", reserve } et affiche le bouton
          « Transmettre à HISTO » ; HISTO rend alors le cadre visible, le
          collaborateur colorie à la main, puis clique le bouton, qui envoie
          « paint-image » ;
     4. HISTO peut envoyer { type:"paint-fin" } : le cadre n'a plus rien à
        faire (HISTO le retire lui-même).

   ⚠ L'IMAGE EST LE PLAN ET SON CALQUE, rien d'autre : ni légende ni notes
   (décision du 01/10/2026 : simple repère de situation, couleur de PAINT).
   ====================================================================== */
(function(){
  "use strict";
  const p = new URLSearchParams(location.search);
  if((p.get("charge") || "") !== "histo") return;         // hors appel HISTO : rien

  const dest = (window.parent && window.parent !== window) ? window.parent
             : (window.opener || null);
  if(!dest) return;
  let origineHisto = "*";

  const envoyer = (msg) => { try{ dest.postMessage(msg, origineHisto); }catch(e){ console.error("histo-pont", e); } };

  /* Image du plan colorié : fond + calque, en PNG. */
  function imageDuPlan(){
    const b = document.getElementById("base"), o = document.getElementById("overlay");
    if(!b || !b.width) return null;
    const cv = document.createElement("canvas");
    cv.width = b.width; cv.height = b.height;
    const g = cv.getContext("2d");
    g.drawImage(b, 0, 0);
    if(o && o.width) g.drawImage(o, 0, 0);
    return { png: cv.toDataURL("image/png"), largeur: cv.width, hauteur: cv.height };
  }
  let dejaTransmis = false;
  function transmettre(manuel){
    if(dejaTransmis) return;
    const img = imageDuPlan();
    if(!img){ envoyer({ type: "paint-echec", message: "aucun plan chargé" }); return; }
    dejaTransmis = true;
    envoyer({ type: "paint-image", png: img.png, largeur: img.largeur, hauteur: img.hauteur,
              reserve: window.captureReserve || null, manuel: !!manuel });
  }

  /* Bouton « Transmettre à HISTO », dans la barre du haut, masqué par défaut. */
  let bouton = null;
  function montrerBouton(){
    if(bouton) { bouton.style.display = "inline-flex"; return; }
    const barre = document.querySelector(".hbar"); if(!barre) return;
    bouton = document.createElement("button");
    bouton.className = "hbtn primary"; bouton.id = "histobtn";
    bouton.textContent = "✓ Transmettre à HISTO";
    bouton.title = "Envoie le plan tel qu'il est à l'écran à HISTO, qui le place en tête de la section";
    bouton.onclick = () => transmettre(true);
    barre.appendChild(bouton);
  }

  /* 1. prêt à recevoir */
  window.addEventListener("message", (e) => {
    const d = e.data || {};
    if(d.type === "paint-params" && typeof d.qs === "string"){
      origineHisto = e.origin;
      // rapide=1 (04/10/2026) : PAINT vérifie le calage analytique sur les traits
      // du plan au lieu de lire les marges par OCR — plusieurs minutes gagnées.
      const qs = /(^|&)rapide=/.test(d.qs) ? d.qs : d.qs + "&rapide=1";
      history.replaceState(null, "", location.pathname + "?" + qs + "&charge=histo");
      try{ preremplirDepuisURL(); }
      catch(err){ envoyer({ type: "paint-echec", message: "démarrage impossible : " + (err && err.message || err) }); return; }
      surveiller();
    }
  });
  envoyer({ type: "paint-pret" });

  /* 2 bis. RELEVÉ DES ÉTAPES (05/10/2026, JFD : « c'est toujours aussi long ») —
     on ne devine plus : chaque changement du message d'attente de PAINT (cercle
     central) est transmis à HISTO avec son heure ; HISTO en tire la durée de chaque
     étape. Observation seule : aucun comportement de PAINT n'est modifié. */
  (function releverEtapes(){
    const msg = document.getElementById("spinmsg"), rond = document.getElementById("spin");
    if(!msg || !rond) return;
    let dernier = "";
    const signaler = () => {
      const visible = rond.classList.contains("show");
      // les pourcentages de lecture (« Lecture des numéros… 42 % ») ne font pas une étape nouvelle
      const texte = visible ? (msg.textContent || "").replace(/\s*\d+\s*%\s*$/, "").trim() : "(entre deux étapes)";
      if(texte === dernier) return;
      dernier = texte;
      envoyer({ type: "paint-etape", texte, t: Date.now() });
    };
    new MutationObserver(signaler).observe(msg, { childList: true, characterData: true, subtree: true });
    new MutationObserver(signaler).observe(rond, { attributes: true, attributeFilter: ["class"] });
  })();

  /* 3. fin de la chaîne automatique */
  /* ⚠ DÉLAIS (corrigés le 04/10/2026 après le premier essai réel sur Croix) :
     dans un cadre, la lecture des coordonnées de marge par reconnaissance de
     caractères peut dépasser quatre minutes ; la passerelle avait alors basculé
     en reprise manuelle ALORS QUE la colorisation s'achevait juste après.
     Désormais : on attend DOUZE minutes avant de proposer la reprise manuelle,
     et même après l'avoir proposée on CONTINUE DE SURVEILLER — si la chaîne
     automatique aboutit sans réserve, l'image part d'elle-même. */
  const DELAI_AVANT_REPRISE_MS = 12 * 60 * 1000;
  let repriseProposee = false;
  function surveiller(){
    const debut = Date.now();
    const t = setInterval(() => {
      if(dejaTransmis){ clearInterval(t); return; }
      if(window.capturePret){
        clearInterval(t);
        if(window.captureReserve){
          // Colorisation non prouvée : on laisse la main au collaborateur.
          montrerBouton();
          if(!repriseProposee){ repriseProposee = true;
            envoyer({ type: "paint-attente-manuelle", reserve: String(window.captureReserve) }); }
        }else{
          transmettre(false);
        }
        return;
      }
      if(!repriseProposee && Date.now() - debut > DELAI_AVANT_REPRISE_MS){
        repriseProposee = true;
        montrerBouton();
        envoyer({ type: "paint-attente-manuelle", reserve: "délai dépassé — colorisez à la main puis transmettez ; si la colorisation automatique aboutit entre-temps, l'image partira d'elle-même" });
      }
    }, 500);
  }
})();
