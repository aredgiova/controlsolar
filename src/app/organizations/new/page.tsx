import Link from "next/link";
import { ApiForm } from "@/components/management-form";
import { requireIdentity } from "@/modules/auth/session";
import { readConfig } from "@/lib/config";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";
export default async function NewOrganizationPage() {
  if (readConfig().demoMode) redirect("/dashboard");
  const identity = await requireIdentity("/organizations/new");
  return <main className="standalone-state panel"><h1>Crea tu organización</h1><p>Sesión de {identity.email}. Registra la empresa para comenzar a administrar clientes e instalaciones. Serás su titular.</p>
    <ApiForm endpoint="/api/v1/organizations" submitLabel="Crear organización" redirectTo="/dashboard?org={id}" fields={[
      { name: "name", label: "Nombre de la organización", required: true },
      { name: "slug", label: "Identificador de la organización", required: true, hint: "Solo letras minúsculas, números y guiones; al menos 3 caracteres." },
      { name: "timezone", label: "Zona horaria", defaultValue: "America/Bogota", required: true },
    ]} /><Link href="/dashboard" className="inline-link">Volver al panel</Link></main>;
}
