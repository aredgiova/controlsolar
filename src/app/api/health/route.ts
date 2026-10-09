export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness only. This endpoint does not assert database or device connectivity.
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
