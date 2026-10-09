import Link from "next/link";
import { redirect } from "next/navigation";
import { brand } from "@/lib/brand";
import { getAuthenticationStatus, readConfig } from "@/lib/config";
import { getCurrentIdentity } from "@/modules/auth/session";
import { safeReturnTo } from "@/modules/auth/security";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const returnTo = safeReturnTo(typeof params.next === "string" ? params.next : undefined);
  const configuration = readConfig();
  const authentication = getAuthenticationStatus();
  if (!configuration.demoMode && configuration.authDatabaseUrl && await getCurrentIdentity()) redirect(returnTo);
  return <main id="main-content" style={{ maxWidth: 640, paddingTop: 72 }}>
    <header className="page-header"><div><p className="muted">{brand.name}</p><h1>Accede a tu espacio solar</h1><p className="page-description">Consulta los proyectos y empresas a los que tu equipo te ha dado acceso.</p></div></header>
    <section className="panel" aria-labelledby="identity-heading" style={{ padding: 28 }}>
      <h2 id="identity-heading">Inicio de sesión seguro</h2>
      {params.error && <p role="alert" style={{ marginTop: 12 }}>No se completó el inicio de sesión. Puedes volver a intentarlo cuando el servicio esté configurado.</p>}
      {authentication.configured && !configuration.demoMode ? <>
        <p className="page-description">Continúa al formulario de Amazon Cognito para verificar tu identidad.</p>
        <a href={`/auth/login?next=${encodeURIComponent(returnTo)}`} className="button" style={{ marginTop: 20 }}>Continuar con Cognito</a>
      </> : <>
        <p className="page-description">El acceso real está pendiente de configurar Amazon Cognito y la conexión de identidad a PostgreSQL.</p>
        <p className="muted" style={{ marginTop: 12 }}>La implementación local está disponible para preparar y verificar la integración. Todavía no hay un servicio de identidad conectado.</p>
      </>}
      {configuration.demoMode && <p style={{ marginTop: 24 }}><Link href="/dashboard" className="button button-secondary">Explorar la demostración</Link></p>}
    </section>
  </main>;
}
