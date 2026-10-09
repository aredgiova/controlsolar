"use client";

export default function ApplicationError({ reset }: { reset: () => void }) {
  return <main className="standalone-state"><h1>No pudimos abrir la demostración</h1><p>Comprueba que APP_ENV=development o staging, DATA_ADAPTER=demo y DEMO_MODE=true estén configurados en el servidor. Este hito solo sirve datos ficticios.</p><button className="button" onClick={reset}>Volver a intentar</button></main>;
}
