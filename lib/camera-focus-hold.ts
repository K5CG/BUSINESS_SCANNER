/**
 * Blocco del fuoco per la durata della cattura JPEG.
 *
 * Il punto di misurazione nativo riparte a ogni cambio di valore: il setter di
 * `meteringPointX`/`meteringPointY` chiama `startFocusMetering()`, che emette
 * ACTIVE_SCAN e rimette in movimento l'obiettivo. Le coordinate però derivano
 * dal layout dell'anteprima, che continua a cambiare mentre lo scatto è in
 * corso. Il risultato è una nuova ricerca nel mezzo dell'esposizione.
 *
 * Qui si tiene l'ultima istantanea delle prop e la si restituisce finché la
 * cattura non è conclusa: il valore inviato al nativo resta identico, quindi
 * nessuna ricerca riparte. Non è un blocco AF/AE prolungato e non introduce
 * attese: è solo l'assenza di comandi durante l'otturatore.
 *
 * Livello condiviso fra biglietto e documenti: riguarda il ciclo di vita della
 * cattura, non la semantica delle due modalità.
 */

export interface FocusHold<TProps> {
  isHeld: () => boolean;
  hold: () => boolean;
  release: () => boolean;
  /** Restituisce le prop correnti, o l'istantanea se la cattura è in corso. */
  stabilize: (props: TProps) => TProps;
}

export function createFocusHold<TProps>(): FocusHold<TProps> {
  let held = false;
  let snapshot: TProps | null = null;

  return {
    isHeld: () => held,
    hold: () => {
      if (held) return false;
      held = true;
      return true;
    },
    release: () => {
      if (!held) return false;
      held = false;
      snapshot = null;
      return true;
    },
    stabilize: (props) => {
      if (!held) {
        snapshot = props;
        return props;
      }
      return snapshot ?? props;
    },
  };
}
