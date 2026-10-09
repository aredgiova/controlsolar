import Link from "next/link";

export default function NotFound() {
  return <div className="standalone-state"><h1>No encontramos esta página</h1><p>Revisa la dirección o vuelve a tus proyectos.</p><Link href="/projects" className="button">Ver proyectos</Link></div>;
}
