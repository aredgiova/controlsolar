export default function Loading() {
  return <div aria-busy="true" aria-label="Cargando instalaciones" className="loading-state"><p className="muted">Cargando instalaciones…</p><div className="skeleton skeleton-title" /><div className="skeleton skeleton-summary" /><div className="skeleton skeleton-table" /></div>;
}
