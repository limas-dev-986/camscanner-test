/*
 * Objects the tool can read. To add one, append an entry:
 *   id        short unique code (stored in every log row; never change it once used)
 *   label     shown in the list (generic description, no manufacturer names: this repo is public)
 *   method    'vial'  = one small region on the liquid (+ optional white reference)
 *             'sheet' = a rectangle over a printed test pattern, analysed area by area
 *   messages  text shown for pass / fail / uncertain
 *   expected  labels for the tester's "expected result" list
 *   calibration  true = purple/yellow reference buttons are shown (vial method only for now)
 */
(function (root) {
  'use strict';
  root.PRODUCTS = [
    {
      id: 'bi-vial',
      label: 'Biological indicator – self-contained vial (purple → yellow / green)',
      method: 'vial',
      messages: {
        pass: 'Fără creștere bacteriană - Procesul a avut succes',
        fail: 'Creștere bacteriană - Proces eșuat!',
        uncertain: 'Rezultat incert - Repetați citirea',
      },
      expected: { pass: 'Purple (no growth)', fail: 'Yellow / green (growth)' },
      calibration: true,
    },
    {
      id: 'bd-sheet',
      label: 'Bowie & Dick test sheet (pink → uniform black)',
      method: 'sheet',
      messages: {
        pass: 'Virare completă la negru - Test trecut',
        fail: 'Virare incompletă - Test eșuat!',
        uncertain: 'Rezultat incert - Repetați citirea',
      },
      expected: { pass: 'All black, uniform (pass)', fail: 'Pink left / uneven (fail)' },
      calibration: false,
    },
  ];
})(window);
