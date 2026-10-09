"use client";

import { useSearchParams } from "next/navigation";

export default function WorkspaceError({ reset }: { reset: () => void }) {
  const params = useSearchParams();
  const query = new URLSearchParams(params.toString());
  query.delete("scenario");
  return <div role="alert" className="panel empty-state"><h1>No pudimos cargar los datos</h1><p>La vista no está disponible. Puedes volver a intentarlo o regresar al resumen.</p><div className="form-actions"><button className="button" onClick={reset}>Reintentar</button><a href={`/dashboard?${query}`} className="button button-secondary">Volver al resumen</a></div></div>;
}
