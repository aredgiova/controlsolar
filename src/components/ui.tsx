import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{description && <p className="page-description">{description}</p>}</div>{children && <div className="page-actions">{children}</div>}</header>;
}

const statusLabels = { online: "En línea", stale: "Datos desactualizados", offline: "Sin conexión", missing: "Sin datos recibidos", open: "Abierta", resolved: "Resuelta", critical: "Prioridad alta", warning: "Advertencia", info: "Informativa", pending: "En observación", active: "Activa", in_progress: "En seguimiento", closed: "Cerrada" } as const;

export function StatusBadge({ status }: { status: keyof typeof statusLabels }) {
  return <span className={`status-badge status-${status}`}><span className="status-dot" aria-hidden="true" />{statusLabels[status]}</span>;
}

export function EmptyState({ title, description, href, action }: { title: string; description: string; href?: string; action?: string }) {
  return <div className="empty-state"><h2>{title}</h2><p>{description}</p>{href && <Link href={href} className="button button-secondary">{action ?? "Volver al resumen"}</Link>}</div>;
}

export function Metric({ label, value, unit, note }: { label: string; value: string | number; unit?: string; note?: string }) {
  return <div className="metric"><h2>{label}</h2><p className="metric-value">{value}{unit && <span className="metric-unit"> {unit}</span>}</p>{note && <p className="metric-note">{note}</p>}</div>;
}
