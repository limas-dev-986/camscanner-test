/*
 * Objects the tool can read. Each object carries its own rules: the reading method, the colour rules
 * (thresholds) and the messages. Selecting an object in the list applies its rules automatically.
 *
 * To add an object, append an entry:
 *   id         short unique code (stored in every log row; never change it once used)
 *   label      shown in the list, in Romanian (generic description, no manufacturer names: this repo is public)
 *   method     'vial'    = one small region on the liquid (+ optional white reference)
 *              'sheet'   = a printed striped pattern, analysed area by area (automatic capture and region)
 *              'patches' = several small indicator fields that must ALL show the end colour
 *   rules      colour rules for this object (start from the method's defaults in colour.js and override)
 *   rulesText  one-line summary of the rules, shown under the list
 *   hint       how the object is read, shown under the list
 *   messages   text shown for pass / fail / uncertain
 *   expected   labels for the tester's "expected result" list
 *   calibration  true = purple/yellow reference buttons are shown (vial method only for now)
 *   autoRegion   true = automatic capture and automatic region (sheet method only for now)
 */
(function (root) {
  'use strict';
  const C = root.Colour;
  root.PRODUCTS = [
    {
      id: 'bi-vial',
      label: 'Indicator biologic – fiolă autonomă (violet → galben / verde)',
      method: 'vial',
      rules: Object.assign({}, C.DEFAULT_THRESHOLDS),
      rulesText: 'Reguli: lichid violet = trecut; galben sau verde = eșuat; orice altă culoare = incert.',
      hint: 'Se citește lichidul din partea de jos a fiolei. Referință de alb opțională: partea albă a etichetei.',
      messages: {
        pass: 'Fără creștere bacteriană - Procesul a avut succes',
        fail: 'Creștere bacteriană - Proces eșuat!',
        uncertain: 'Rezultat incert - Repetați citirea',
      },
      expected: { pass: 'Violet (fără creștere)', fail: 'Galben / verde (creștere)' },
      calibration: true,
    },
    {
      id: 'bd-sheet',
      label: 'Test Bowie & Dick (roz → negru uniform)',
      method: 'sheet',
      rules: Object.assign({}, C.SHEET_DEFAULTS), // pass limits frozen: see the note in colour.js
      rulesText: 'Reguli: toate dungile negre, uniform = trecut; roz rămas sau zone mai deschise = eșuat.',
      hint: 'Se citește întregul model imprimat al testului, zonă cu zonă. Țineți telefonul paralel cu testul; evitați umbrele și reflexiile.',
      messages: {
        pass: 'Virare completă - Test trecut',
        fail: 'Virare incompletă - Test eșuat!',
        uncertain: 'Rezultat incert - Repetați citirea',
      },
      expected: { pass: 'Negru complet, uniform (trecut)', fail: 'Roz rămas / neuniform (eșuat)' },
      calibration: false,
      autoRegion: true,
    },
    {
      id: 't5-strip',
      label: 'Indicator chimic tip 5 – strip autoadeziv, abur (albastru → roz)',
      method: 'patches',
      rules: Object.assign({}, C.PATCH_DEFAULTS, { patches: 3 }),
      rulesText: 'Reguli: toate cele trei triunghiuri roz = trecut; orice triunghi care nu este roz (albastru, violet) = eșuat.',
      hint: 'Se citesc cele trei triunghiuri, fiecare separat. Albul etichetei din jurul lor este folosit automat ca referință de alb. Evitați reflexiile pe folia laminată.',
      messages: {
        pass: 'Virare completă - Test trecut',
        fail: 'Virare incompletă - Test eșuat!',
        uncertain: 'Rezultat incert - Repetați citirea',
      },
      expected: { pass: 'Toate triunghiurile roz (trecut)', fail: 'Albastru / virare incompletă (eșuat)' },
      calibration: false,
    },
  ];
})(window);
