import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentIdentity } from "@/modules/auth/session";
import { ApiForm } from "@/components/management-form";
import { readConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[a-f0-9]{64}$/.test(token)) notFound();
  const identity = await getCurrentIdentity();
  const demo = readConfig().demoMode;
  return <main className="standalone-state panel"><h1>Invitación a una organización</h1>
    <p>La invitación se acepta con el correo verificado al que fue dirigida. El enlace caduca en siete días y se puede usar una sola vez.</p>
    {demo ? <p>Las invitaciones requieren el entorno con PostgreSQL y Cognito configurados.</p> : identity ? <><p>Sesión de {identity.email}.</p><ApiForm endpoint="/api/v1/invitations/accept" submitLabel="Aceptar invitación" fixed={{ token }} redirectTo="/dashboard?org={organizationId}" /></> : <Link className="button" href={`/login?next=${encodeURIComponent(`/invitations/${token}`)}`}>Iniciar sesión para aceptar</Link>}
  </main>;
}
