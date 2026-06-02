/* ===========================================================================
   sprites.js — pixel-art sprite definitions + drawing.

   HIGH-RES pass: humanoids are now ~12 wide x 26 tall (2x the old 6x14), with
   real Imperial detail. The stormtrooper in particular is drawn as an ACTUAL
   stormtrooper: domed helmet with two angled black eye-lenses, a central
   vocoder "frown" grille, black neck seal, sculpted chest/ab plates, shoulder
   bell with a project-accent pauldron, utility belt, thigh/shin plates with
   knee shadows, and black boots.

   Each non-transparent cell is one block (PX x PX) drawn with fillRect, so
   sprites stay crisp nearest-neighbour pixel art at any zoom.

   Authoring model: every sprite defines a full `idle` grid; the other poses
   (walk1, walk2, work, stumble) are built from idle with only a few ROW
   OVERRIDES via mk(). mk() validates that every row in every pose is exactly
   `w` wide and that all poses share the same height — so a typo throws loudly
   instead of rendering a torn sprite.

   Code 'A' = the agent's per-project ACCENT pixel (pauldron / rank-badge /
   droid panel), recoloured per sprite instance.
   =========================================================================== */
(function () {
  'use strict';
  const DSV = window.DSV;
  const PX = DSV.PX;
  const U = DSV.DETAIL || 2;

  // Sub-palettes ------------------------------------------------------------
  const C = {
    // stormtrooper
    armor:  '#e8e8ee', armorMid: '#cfcfd8', armorSh: '#b0b0bc', visor: '#16161b',
    blaster:'#2a2a30', blasterHi:'#3a3a44',
    // officer
    uni:    '#5a5f50', uniMid: '#515548', uniSh: '#474b3f', cap: '#3a3c40', capHi:'#4a4c50',
    skin:   '#e0b48a', skinSh:'#c79b73',
    // gunner
    blk:    '#26262c', blkMid:'#202026', blkSh: '#16161a', lens: '#8a90a0', belt: '#3a3a44',
    // astromech
    droidBody:'#dfe3ea', droidSh:'#bcc2cc', dome:'#aab2c0', domeHi:'#c2c8d2',
    foot:'#4a4c54', eyeB:'#3a78d6', eyeR:'#e84a4a',
    // protocol
    gold:'#d9a93a', goldMid:'#c2962f', goldSh:'#a67f24', goldEye:'#e8e060',
    // mouse droid
    mouse:'#2a2a30', mouseSh:'#1f1f25', mouseHi:'#6a6e7a',
    // commander
    cmd:'#1a1a1f', cmdMid:'#22222a', cape:'#101015', capeSh:'#0a0a0e',
    // Darth Vader (Tier 1)
    vader:'#1a1a1f', vaderMid:'#23232b', helmet:'#101015', helmetHi:'#2c2c34',
    chestR:'#e23b3b', chestG:'#7ec850', chestB:'#3a78d6',
    saber:'#e23b3b', saberCore:'#ff6b6b',
    // Imperial Royal Guard (Tier 1 alternate — second orchestrator)
    guard:'#a82828', guardMid:'#8c2020', guardSh:'#6c1818',
    guardHelm:'#c23030', guardVisor:'#1a0c0c',
    pike:'#7a7e8a', pikeTip:'#cfd6e0',
    // KX-series security droid (Tier 3)
    kx:'#222229', kxSh:'#1a1a1f', kxJoint:'#34343e', kxEye:'#c9d2e0',
    // fx
    spark:'#ffd24a', sparkRed:'#ff5a4a',
  };

  // Resolve a sprite code -> color, given the instance accent + an eye toggle.
  function colorFor(code, accent, ctx2) {
    switch (code) {
      case '.': return null;
      case 'W': return C.armor;
      case 'w': return C.armorSh;
      case 'i': return C.armorMid;
      case 'V': return C.visor;
      case 'B': return C.blaster;
      case 'b': return C.blasterHi;
      case 'U': return C.uni;
      case 'n': return C.uniMid;
      case 'u': return C.uniSh;
      case 'P': return C.cap;
      case 'p': return C.capHi;
      case 'S': return C.skin;
      case 's': return C.skinSh;
      case 'K': return C.blk;
      case 'j': return C.blkMid;
      case 'k': return C.blkSh;
      case 'L': return C.lens;
      case 'e': return C.belt;
      case 'D': return C.droidBody;
      case 'd': return C.droidSh;
      case 'M': return C.dome;
      case 'm': return C.domeHi;
      case 'F': return C.foot;
      case 'E': return ctx2 && ctx2.eyeRed ? C.eyeR : C.eyeB;
      case 'G': return C.gold;
      case 'h': return C.goldMid;
      case 'g': return C.goldSh;
      case 'Y': return C.goldEye;
      case 'z': return C.mouse;
      case 'x': return C.mouseSh;
      case 'q': return C.mouseHi;
      case 'X': return C.cmd;
      case 'r': return C.cmdMid;
      case 'c': return C.cape;
      case 'v': return C.capeSh;
      case 'O': return C.vader;
      case 'o': return C.vaderMid;
      case 'H': return C.helmet;
      case 'l': return C.helmetHi;
      case 'R': return C.chestR;
      case 'N': return C.chestG;
      case 'I': return C.chestB;
      case '1': return C.saber;
      case '2': return C.saberCore;
      case 'T': return C.kx;
      case 't': return C.kxSh;
      case 'J': return C.kxJoint;
      case 'Q': return C.kxEye;
      case 'C': return C.guard;
      case 'a': return C.guardMid;
      case 'y': return C.guardSh;
      case 'Z': return C.guardHelm;
      case '4': return C.guardVisor;
      case 'f': return C.pike;
      case '3': return C.pikeTip;
      case 'A': return accent || '#c83a3a';
      case '*': return ctx2 && ctx2.errorSpark ? C.sparkRed : C.spark;
      default:  return null;
    }
  }

  // ---- Pose builder -------------------------------------------------------
  // Build a sprite def from a full `idle` grid + sparse per-pose row overrides.
  // Validates all dimensions so a mis-typed row throws instead of tearing.
  function applyOverrides(base, ov) {
    const rows = base.slice();
    if (ov) for (const k in ov) rows[Number(k)] = ov[k];
    return rows;
  }
  function mk(w, idle, opts) {
    opts = opts || {};
    const def = {
      w,
      h: idle.length,
      idle,
      walk1: applyOverrides(idle, opts.walk1),
      walk2: applyOverrides(idle, opts.walk2),
      work: applyOverrides(idle, opts.work),
      stumble: applyOverrides(idle, opts.stumble),
    };
    for (const p of ['idle', 'walk1', 'walk2', 'work', 'stumble']) {
      const rows = def[p];
      if (rows.length !== def.h) throw new Error(`sprite ${p}: height ${rows.length} != ${def.h}`);
      for (let r = 0; r < rows.length; r++) {
        if (rows[r].length !== w) {
          throw new Error(`sprite ${p} row ${r}: width ${rows[r].length} != ${w} ("${rows[r]}")`);
        }
      }
    }
    return def;
  }

  // ---- Stormtrooper — the marquee sprite ----------------------------------
  // Helmet: dome, grey brow trim, two angled black eye-lenses split by a nose
  // ridge, the wide vocoder "frown" grille, black neck seal. Body: shoulder
  // bells (left = accent pauldron), sculpted chest + ab plates with a black
  // sternum, utility belt, codpiece, thigh/shin plates with knee shadows, boots.
  const STORMTROOPER = mk(12, [
    '....WWWW....', //  0 helmet dome top
    '..WWWWWWWW..', //  1 dome
    '.WWWWWWWWWW.', //  2 dome / forehead
    '.WiiiiiiiiW.', //  3 brow trim line
    '.WVVVwwVVVW.', //  4 black eye-lenses + nose ridge
    '.WWiwwwwiWW.', //  5 cheeks
    '.WWVVVVVVWW.', //  6 vocoder frown (top)
    '.WWVwVVwVWW.', //  7 vocoder vents
    '..WWVVVVWW..', //  8 chin / lower vocoder
    '...VVkkVV...', //  9 black neck seal
    'AAWWWWWWWWiw', // 10 shoulder bells (left pauldron = accent)
    'wWWWWWWWWWWw', // 11 upper chest plate
    'wWiWWWWWWiWw', // 12 chest plate seams
    'wWWWWVVWWWWw', // 13 black sternum detail
    'wWiWWWWWWiWw', // 14 ab plate seams
    '.VVVVVVVVVV.', // 15 utility belt
    '.WiWVVVVWiW.', // 16 hip plates + black codpiece
    '.WWWW..WWWW.', // 17 thighs
    '.WWWw..wWWW.', // 18 thigh shadow
    '.iWWi..iWWi.', // 19 knee guards
    '.WWWW..WWWW.', // 20 shins
    '.WWWw..wWWW.', // 21 shin shadow
    '.iWWi..iWWi.', // 22 ankles
    '.kkkk..kkkk.', // 23 boots
    '.kkkk..kkkk.', // 24 boots
    '.kkkk..kkkk.', // 25 boot soles
  ], {
    walk1: { 22: '.iWWi..iWW..', 23: '.kkkk..kkk..', 24: '.kkkk...kk..', 25: '.kkkk.......' },
    walk2: { 22: '..WWi..iWWi.', 23: '..kkk..kkkk.', 24: '..kk...kkkk.', 25: '.......kkkk.' },
    work:  { 11: 'wWWWWWWWWWWB', 12: 'wWiWWWWWWWbb' },
    stumble: {
      10: 'AAWWWWWWWWWW', 11: 'BbWWWWWWWWbB',
      17: 'WWW....WWWW.', 18: 'WWw....wWWW.', 19: 'iWi....iWi..',
      23: 'kk......kk..', 24: 'kk......kk..', 25: 'k........k..',
    },
  });

  // ---- Imperial officer ---------------------------------------------------
  const OFFICER = mk(12, [
    '..PPPPPPPP..', //  0 cap crown
    '.PPPPPPPPPP.', //  1 cap
    '.pppppppppp.', //  2 cap brim
    '..SSSSSSSS..', //  3 forehead
    '..SVSSSSVS..', //  4 eyes
    '..SSsssssS..', //  5 face shadow
    '...kSSSSk...', //  6 jaw / collar
    '...kkkkkk...', //  7 black collar
    'AAUUUUUUUUbn', //  8 shoulders: rank plaque + code cylinder
    'nUUUUUUUUUUn', //  9 chest
    'nUUUUUUUUUUn', // 10 tunic
    'nUUUUUUUUUUn', // 11 tunic
    '.kkkkkkkkkk.', // 12 black belt
    '.UUUnnnnUUU.', // 13 clasped hands
    '.UUUU..UUUU.', // 14 hips
    '.uuuu..uuuu.', // 15 thighs
    '.uuuu..uuuu.', // 16 thighs
    '.uuuu..uuuu.', // 17 thighs
    '.uuuu..uuuu.', // 18 shins
    '.uuuu..uuuu.', // 19 shins
    '.uuuu..uuuu.', // 20 shins
    '.uuuu..uuuu.', // 21 shins
    '.uuuu..uuuu.', // 22 ankles
    '.kkkk..kkkk.', // 23 boots
    '.kkkk..kkkk.', // 24 boots
    '.kkkk..kkkk.', // 25 boots
  ], {
    walk1: { 22: '.uuuu..uuu..', 23: '.kkkk..kkk..', 24: '.kkkk...kk..', 25: '.kkkk.......' },
    walk2: { 22: '..uuu..uuuu.', 23: '..kkk..kkkk.', 24: '..kk...kkkk.', 25: '.......kkkk.' },
    work:  { 13: '.UUUnnnnUss.' },
    stumble: {
      9: 'nUUUUUUUUUUn', 13: 'sUUUnnnnUUUs',
      14: 'UUUU...UUUU.', 15: 'uuu....uuuu.',
      23: 'kk......kk..', 24: 'kk......kk..', 25: 'k........k..',
    },
  });

  // ---- Death Star gunner (dark console operator) --------------------------
  const GUNNER = mk(12, [
    '....KKKK....', //  0 helmet dome
    '..KKKKKKKK..', //  1
    '.KKKKKKKKKK.', //  2
    '.KKKKKKKKKK.', //  3
    '.KKLLLLLLKK.', //  4 helmet lens band
    '.KKKKKKKKKK.', //  5
    '.jKKKKKKKKj.', //  6
    'AjKKKKKKKKjj', //  7 shoulders + accent
    'jKKKKKKKKKKj', //  8
    'jKeeeeeeeeKj', //  9 belt line
    'jKKKKKKKKKKj', // 10
    'jKKKKKKKKKKj', // 11
    '.KKKK..KKKK.', // 12 legs
    '.KKKj..jKKK.', // 13
    '.jKKj..jKKj.', // 14
    '.KKKK..KKKK.', // 15
    '.KKKj..jKKK.', // 16
    '.jKKj..jKKj.', // 17
    '.KKKK..KKKK.', // 18
    '.KKKj..jKKK.', // 19
    '.jKKj..jKKj.', // 20
    '.KKKK..KKKK.', // 21
    '.jKKj..jKKj.', // 22
    '.kkkk..kkkk.', // 23 boots
    '.kkkk..kkkk.', // 24
    '.jjjj..jjjj.', // 25
  ], {
    walk1: { 22: '.jKKj..jKK..', 23: '.kkkk..kkk..', 24: '.kkkk...kk..', 25: '.jjjj.......' },
    walk2: { 22: '..KKj..jKKj.', 23: '..kkk..kkkk.', 24: '..kk...kkkk.', 25: '.......jjjj.' },
    work:  { 10: 'jKKKKKKKKKKB' },
    stumble: {
      12: 'KKKK...KKKK.', 13: 'KKKj...jKKK.',
      23: 'kk......kk..', 24: 'kk......kk..', 25: 'j........j..',
    },
  });

  // ---- Astromech droid ----------------------------------------------------
  const ASTROMECH = mk(10, [
    '...MMMM...', //  0 dome top
    '..MMMMMM..', //  1 dome
    '.MmMEEMmM.', //  2 dome with central logic eye
    '.MMMMMMMM.', //  3 neck ring
    'DDDDDDDDDD', //  4 body shoulders
    'DdDAAAADdD', //  5 blue accent panel
    'DdDDEEDDdD', //  6 red logic indicator
    'DdDDDDDDdD', //  7 body
    'DdDDDDDDdD', //  8 body
    'DdDAAAADdD', //  9 lower accent stripe
    'DdDDDDDDdD', // 10 body
    'dDDDDDDDDd', // 11 body taper
    'dddddddddd', // 12 body base
    '.F.dddd.F.', // 13 leg shoulders
    '.F.DDDD.F.', // 14 legs
    '.F......F.', // 15 legs
    '.FF....FF.', // 16 feet
    '.FF....FF.', // 17 feet
  ], {
    walk1: { 15: '.FF....F..', 16: '.FF...FF..', 17: '.F....FF..' },
    walk2: { 15: '..F....FF.', 16: '..FF...FF.', 17: '..FF....F.' },
    work:  { 2: 'EMmMMMMmM.', 6: 'DdDDEEDDdF' },
    stumble: { 2: '.MmM..MmM.', 13: '.F.ddd..F.' },
  });

  // ---- Protocol droid -----------------------------------------------------
  const PROTOCOL = mk(12, [
    '..GGGGGGGG..', //  0 head top
    '.GhhhhhhhhG.', //  1 head
    '.GYGGGGGGYG.', //  2 lit eyes
    '.GhhhhhhhhG.', //  3 head
    '.hGGGGGGGGh.', //  4 neck
    'AhGGGGGGGGhh', //  5 shoulders + accent
    'GGGGGGGGGGGG', //  6 chest
    'hGGGGGGGGGGh', //  7
    'hGGGGGGGGGGh', //  8
    'GGhhhhhhhhGG', //  9 abdomen seams
    'hGGGGGGGGGGh', // 10
    '.GGGggggGGG.', // 11 joined hands
    '.GGGG..GGGG.', // 12 legs
    '.GGGg..gGGG.', // 13
    '.gGGg..gGGg.', // 14
    '.GGGG..GGGG.', // 15
    '.GGGg..gGGG.', // 16
    '.gGGg..gGGg.', // 17
    '.GGGG..GGGG.', // 18
    '.GGGg..gGGG.', // 19
    '.gGGg..gGGg.', // 20
    '.GGGG..GGGG.', // 21
    '.gGGg..gGGg.', // 22
    '.gggg..gggg.', // 23 feet
    '.gggg..gggg.', // 24
    '.gggg..gggg.', // 25
  ], {
    walk1: { 22: '.gGGg..gGG..', 23: '.gggg..ggg..', 24: '.gggg...gg..', 25: '.gggg.......' },
    walk2: { 22: '..GGg..gGGg.', 23: '..ggg..gggg.', 24: '..gg...gggg.', 25: '.......gggg.' },
    work:  { 10: 'hGGGGGGGGGGY' },
    stumble: {
      12: 'GGGG...GGGG.', 13: 'GGGg...gGGG.',
      23: 'gg......gg..', 24: 'gg......gg..', 25: 'g........g..',
    },
  });

  // ---- Mouse droid --------------------------------------------------------
  const MOUSE = mk(8, [
    '..qqqq..', // 0
    '.zzzzzz.', // 1
    'zzzzzzzz', // 2
    'zxxxxxxz', // 3
    'zxxxxxxz', // 4
    'zzzzzzzz', // 5
    'z.z..z.z', // 6 wheels
    '........', // 7
  ], {
    walk1: { 6: '.z.z.z..' },
    walk2: { 6: 'z.z..z.z' },
  });

  // ---- Imperial commander (dark caped) ------------------------------------
  const COMMANDER = mk(12, [
    '....XXXX....', //  0
    '..XXXXXXXX..', //  1
    '.XXXXXXXXXX.', //  2
    '.XrXXXXXXrX.', //  3
    '.XXXXXXXXXX.', //  4
    '.rXXXXXXXXr.', //  5
    '..XXXXXXXX..', //  6
    '...XXXXXX...', //  7
    'AXXXXXXXXXXr', //  8 collar accent
    'cXXXXXXXXXXc', //  9
    'ccXXXXXXXXcc', // 10
    'cccccccccccc', // 11 cape
    'cvvvvvvvvvvc', // 12
    'cccccccccccc', // 13
    'cvvvvvvvvvvc', // 14
    'cccccccccccc', // 15
    'cvvvvvvvvvvc', // 16
    'cccccccccccc', // 17
    'cvvvvvvvvvvc', // 18
    'cccccccccccc', // 19
    'cvvvvvvvvvvc', // 20
    'cccccccccccc', // 21
    'cvvvvvvvvvvc', // 22
    'cccccccccccc', // 23
    'cvvvvvvvvvvc', // 24
    'cccccccccccc', // 25
    'cvvvvvvvvvvc', // 26
    'cccccccccccc', // 27
    'vccccccccccv', // 28
    'vvvvvvvvvvvv', // 29 hem
  ], {
    walk1: { 27: 'cvvvvvvvvvc.', 28: 'vcccccccccc.', 29: 'vvvvvvvvvv..' },
    walk2: { 27: '.cvvvvvvvvvc', 28: '.ccccccccccv', 29: '..vvvvvvvvvv' },
    work:  { 8: 'AXXXXXXXXXXX' },
    stumble: { 28: 'vccccccc....', 29: 'vvvvvv......' },
  });

  // ---- Darth Vader (Tier 1) -----------------------------------------------
  // Domed helmet over a flared trapezoidal mask (angled eye lenses + grille),
  // armored shoulders, chest control box, belt + buckle, floor-length cape
  // (glides), and a red blade held point-down at his side (raised in `work`).
  const VADER = mk(12, [
    '....HHHH....', //  0 helmet dome
    '..HHHHHHHH..', //  1 dome
    '.HHHHHHHHHH.', //  2 dome
    '.HllllllllH.', //  3 brow highlight
    '.HlHHHHHHlH.', //  4 angled eye lenses
    '.HHlHHHHlHH.', //  5 cheek angles
    '.HHHHHHHHHH.', //  6 mask mid / grille
    '.lHHHHHHHHl.', //  7 flared mask base
    '..lHHHHHHl..', //  8 tusks
    '...HHHHHH...', //  9 chin / neck
    'OOOOOOOOOOOO', // 10 armored shoulders
    'OOARNIOOOOOO', // 11 chest control box (accent/red/green/blue)
    'OllllllllllO', // 12 silver button row
    'OkkkkbbkkkkO', // 13 belt + buckle
    'cccccccccccc', // 14 cape
    'cvvvvvvvvvvc', // 15
    'ccccccccccc1', // 16 cape + saber blade
    'cvvvvvvvvvc2', // 17 cape + hotter core (grip)
    'ccccccccccc1', // 18
    'cvvvvvvvvvc1', // 19
    'ccccccccccc1', // 20
    'cvvvvvvvvvvc', // 21
    'cccccccccccc', // 22
    'cvvvvvvvvvvc', // 23
    'cccccccccccc', // 24
    'cvvvvvvvvvvc', // 25
    'cccccccccccc', // 26
    'cvvvvvvvvvvc', // 27
    'vccccccccccv', // 28
    'vvvvvvvvvvvv', // 29 hem
  ], {
    walk1: { 27: 'cvvvvvvvvvc.', 28: 'vcccccccccc.', 29: 'vvvvvvvvvv..' },
    walk2: { 27: '.cvvvvvvvvvc', 28: '.ccccccccccv', 29: '..vvvvvvvvvv' },
    work: {
      0: '....HHHH...1', 1: '..HHHHHHHH.1', 2: '.HHHHHHHHHH1', 3: '.HllllllllH1',
      4: '.HlHHHHHHlH1', 5: '.HHlHHHHlHH1', 6: '.HHHHHHHHHl1', 7: '.lHHHHHHHHO2',
      8: '..lHHHHHHO..',
      16: 'cccccccccccc', 17: 'cvvvvvvvvvvc', 18: 'cccccccccccc',
      19: 'cvvvvvvvvvvc', 20: 'cccccccccccc',
    },
    stumble: { 2: '.HHHHHHHHHH.', 28: 'vccccccc....', 29: 'vvvvvv......' },
  });

  // ---- KX-series security droid (Tier 3) ----------------------------------
  // Tall, lanky, matte-black humanoid droid. Narrow elongated head with two lit
  // photoreceptor eyes, thin gapped limbs, joint-shade pixels. Walks with long
  // stiff strides. Project accent on the chest.
  const KX = mk(12, [
    '...TTTTTT...', //  0 narrow head
    '...TQQQQT...', //  1 photoreceptor eyes
    '...TTTTTT...', //  2 head
    '....JJJJ....', //  3 thin neck
    '..TJTTTTJT..', //  4 angular shoulders
    '...TTAATT...', //  5 slim torso + accent
    '..JTTTTTTJ..', //  6 long thin arms
    '..JTTTTTTJ..', //  7
    '..JTTTTTTJ..', //  8
    '...TJJJJT...', //  9 waist joint
    '...T....T...', // 10 thin legs (gap = lanky)
    '...T....T...', // 11
    '...J....J...', // 12 knee joints
    '...T....T...', // 13
    '...T....T...', // 14
    '...T....T...', // 15
    '...J....J...', // 16
    '...T....T...', // 17
    '...T....T...', // 18
    '...T....T...', // 19
    '...T....T...', // 20
    '...J....J...', // 21
    '...T....T...', // 22
    '...T....T...', // 23
    '...T....T...', // 24
    '...T....T...', // 25
    '...T....T...', // 26
    '..JT....TJ..', // 27 feet widen
    '..tt....tt..', // 28 feet
    '..tt....tt..', // 29 feet
  ], {
    walk1: { 25: '...T....TJ..', 26: '...T.....T..', 27: '..JT.....T..', 28: '..tt.....t..', 29: '..tt........' },
    walk2: { 25: '..JT....T...', 26: '..T.....T...', 27: '..T.....TJ..', 28: '..t.....tt..', 29: '........tt..' },
    work:  { 6: '..JTTTTTTTTJ', 7: '..JTTTTTTJ..' },
    stumble: { 25: '...TJ...T...', 27: '..JTt...tJ..', 29: '..t......t..' },
  });

  // ---- Imperial Royal Guard (Tier 1 alternate) ---------------------------
  // The Emperor's crimson guard: a conical red helmet with a dark vertical
  // visor slit, a floor-length red robe (folds shaded with mid/shadow reds, so
  // it GLIDES like Vader/the commander — no legs), and a tall force pike held
  // along the right edge (tip lit silver, and brightened in `work`). Reserved
  // for the SECOND orchestrator when a Vader is already on another floor.
  const GUARD = mk(12, [
    '....ZZZZ...3', //  0 helmet crown + pike tip
    '..ZZZZZZZZ.f', //  1 helmet
    '.ZZZZZZZZZZf', //  2 helmet
    '.ZZ4444ZZZZf', //  3 visor slit (top)
    '.ZZ4444ZZZZf', //  4 visor slit (bottom)
    '.ZZZZZZZZZZf', //  5 helmet cheeks
    '..ZZZZZZZZ.f', //  6 helmet base
    '...ZZZZZZ..f', //  7 neck guard
    'CCCCCCCCCCCf', //  8 shoulder mantle
    'CyCCCCCCCyCf', //  9 robe
    'CCCCCCCCCCCf', // 10 robe
    'CyaCCCCaayCf', // 11 robe folds
    'CCCCCCCCCCCf', // 12 robe
    'CaCCCCCCaaCf', // 13 robe
    'CCCCCCCCCCCf', // 14 robe
    'CyCCCCCCyyCf', // 15 robe folds
    'CCCCCCCCCCCf', // 16 robe
    'CaCCCCCCaaCf', // 17 robe
    'CCCCCCCCCCCf', // 18 robe
    'CyCCCCCCyyCf', // 19 robe
    'CCCCCCCCCCCf', // 20 robe
    'CaCCCCCCaaCf', // 21 robe
    'CCCCCCCCCCCf', // 22 robe
    'CyCCCCCCyyCf', // 23 robe
    'CCCCCCCCCCCf', // 24 robe
    'CaaCCCCaayCf', // 25 robe (pike grip)
    'CCCCCCCCCCC.', // 26 hem (pike ends)
    'yCCCCCCCCCCy', // 27 hem shadow
    'yyyyyyyyyyyy', // 28 hem
    '.yy......yy.', // 29 robe base shadow
  ], {
    walk1: { 27: 'yCCCCCCCCCy.', 28: 'yyyyyyyyyy..', 29: '.yy....yy...' },
    walk2: { 27: '.yCCCCCCCCCy', 28: '..yyyyyyyyyy', 29: '...yy....yy.' },
    work:  { 1: '..ZZZZZZZZ.3', 2: '.ZZZZZZZZZZ3', 8: 'CCCCCCCCCCC3' },
    stumble: { 28: 'yyyyyyy.....', 29: '.yy.........' },
  });

  const SPRITES = {
    trooper: STORMTROOPER,
    officer: OFFICER,
    gunner: GUNNER,
    astromech: ASTROMECH,
    protocol: PROTOCOL,
    mouse: MOUSE,
    commander: COMMANDER,
    vader: VADER,
    guard: GUARD,
    kx: KX,
  };

  const DROID_TYPES = new Set(['astromech', 'mouse']); // roll, not walk

  /**
   * Draw a sprite.
   * @param ctx        offscreen 2D context (logical pixels)
   * @param type       sprite type key
   * @param pose       'idle'|'walk1'|'walk2'|'work'|'stumble'
   * @param blockX     left grid column (in blocks)
   * @param blockY     top grid row (in blocks)
   * @param facing     1 (right) | -1 (left) — flips horizontally
   * @param accent     accent hex for the 'A' pixel
   * @param fx         { eyeRed, errorSpark, bob }
   */
  function drawSprite(ctx, type, pose, blockX, blockY, facing, accent, fx) {
    const def = SPRITES[type] || SPRITES.trooper;
    const rows = def[pose] || def.idle;
    const w = def.w, h = rows.length;
    fx = fx || {};
    const bob = fx.bob || 0;

    for (let r = 0; r < h; r++) {
      const row = rows[r];
      for (let c = 0; c < w; c++) {
        const cc = facing < 0 ? (w - 1 - c) : c;
        const code = row[cc] || '.';
        const col = colorFor(code, accent, fx);
        if (!col) continue;
        ctx.fillStyle = col;
        const gx = (blockX + c) * PX;
        const gy = (blockY + r + bob) * PX;
        ctx.fillRect(gx, gy, PX, PX);
      }
    }
  }

  function spriteHeight(type) { return (SPRITES[type] || SPRITES.trooper).h; }
  function spriteWidth(type)  { return (SPRITES[type] || SPRITES.trooper).w; }
  function isDroid(type)      { return DROID_TYPES.has(type); }

  // Draw a small spark cluster (edit/error fx) at a console. Offsets scale with
  // resolution so the burst stays the right size on screen.
  function drawSparks(ctx, blockX, blockY, red, t) {
    const pts = [[0, 0], [1, -1], [-1, 0], [0, -2], [2, -1], [-1, -2], [2, 0]];
    ctx.fillStyle = red ? C.sparkRed : C.spark;
    for (let i = 0; i < pts.length; i++) {
      if (((t >> 2) + i) % 2 === 0) continue; // flicker
      const [dx, dy] = pts[i];
      ctx.fillRect((blockX + dx * U) * PX, (blockY + dy * U) * PX, PX * U, PX * U);
    }
  }

  window.DSV.sprites = {
    drawSprite, spriteHeight, spriteWidth, isDroid, drawSparks,
    TYPES: Object.keys(SPRITES),
    _defs: SPRITES, // exposed for the dimension validator / debugging
  };
})();
