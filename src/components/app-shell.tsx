"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { brand } from "@/lib/brand";
import { Icon } from "./icon";

const navigation = [
  { href: "/dashboard", label: "Resumen", icon: "dashboard" },
  { href: "/projects", label: "Proyectos", icon: "projects" },
  { href: "/alerts", label: "Alertas", icon: "alerts" },
  { href: "/settings", label: "Configuración", icon: "settings" },
] as const;

export function AppShell({ children, organizations, isDemo, identity }: { children: ReactNode; organizations: { id: string; name: string; role?: string }[]; isDemo: boolean; identity: { email: string; displayName: string | null } | null }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const organizationId = organizations.find((organization) => organization.id === params.get("org"))?.id ?? organizations[0]?.id ?? "";
  const organization = organizations.find((item) => item.id === organizationId);
  const canManage = organization?.role === "owner" || organization?.role === "administrator";
  const links: { href: string; label: string; icon: "dashboard" | "projects" | "alerts" | "settings" }[] = [...navigation];
  if (canManage || isDemo) links.splice(2, 0, { href: "/customers", label: "Clientes", icon: "projects" }, { href: "/devices", label: "Dispositivos", icon: "settings" }, { href: "/team", label: "Equipo y accesos", icon: "projects" });
  if (!isDemo) links.splice(links.length - 1, 0, { href: "/portal", label: "Mi portal", icon: "projects" });
  const query = new URLSearchParams({ org: organizationId });
  const scenario = params.get("scenario");
  if (scenario) query.set("scenario", scenario);

  function changeOrganization(id: string) {
    const next = new URLSearchParams({ org: id });
    if (scenario) next.set("scenario", scenario);
    router.push(`${pathname.startsWith("/projects/") ? "/projects" : pathname.startsWith("/alerts/") || pathname.startsWith("/incidents/") ? "/alerts" : pathname}?${next.toString()}`);
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Saltar al contenido</a>
    <aside className="sidebar">
      <Link href={`/dashboard?${query}`} className="wordmark"><span className="brand-symbol"><Icon name="sun" size={24} /></span><span>{brand.name}</span></Link>
      <div className="organization-control"><label htmlFor="organization">{isDemo ? "Empresa de demostración" : "Organización"}</label><select id="organization" value={organizationId} onChange={(event) => changeOrganization(event.target.value)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}</select></div>
      <nav aria-label="Navegación principal" className="main-nav">{links.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`) || (item.href === "/alerts" && pathname.startsWith("/incidents/"));
        return <Link key={item.href} href={`${item.href}?${query}`} className={`nav-link${active ? " active" : ""}`} aria-current={active ? "page" : undefined}><Icon name={item.icon} /><span>{item.label}</span></Link>;
      })}</nav>
      <div className="sidebar-foot">{isDemo ? <><span className="demo-indicator" /> Entorno de demostración<p>Datos simulados · Solo lectura</p></> : <><span>{identity?.displayName || identity?.email}</span><p>{organization?.role === "owner" ? "Titular de organización" : organization?.role === "administrator" ? "Administrador" : organization?.role === "technician" ? "Técnico" : "Propietario del sitio"}</p><form action="/auth/logout" method="post"><button className="logout-button" type="submit">Cerrar sesión</button></form></>}</div>
    </aside>
    <div className="workspace">
      <div className="workspace-topbar"><span>Centro de operación</span><span className="topbar-context">Instalaciones conectadas a red</span></div>
      <div className={isDemo ? "demo-banner" : "demo-banner persistent-banner"}><span><strong>{isDemo ? "Demostración con datos simulados" : "Monitoreo de instalaciones"}</strong><span className="demo-banner-detail">{isDemo ? " · Información ficticia, sin equipos conectados." : " · Consulta el origen y la cobertura de las lecturas en cada proyecto."}</span></span><Link href={`/settings?${query}`}>Ver alcance <Icon name="arrow" size={16} /></Link></div>
      <main id="main-content" tabIndex={-1}>{children}</main>
      <footer className="workspace-footer"><span>{brand.name} · {isDemo ? "Base de demostración" : "Gestión de instalaciones"}</span><span>Fechas según la zona horaria del registro</span></footer>
    </div>
  </div>;
}

