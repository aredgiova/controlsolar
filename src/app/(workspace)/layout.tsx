import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { readWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const workspace = await readWorkspace();
  return <AppShell organizations={workspace.organizations} isDemo={workspace.isDemo} identity={workspace.identity}>{children}</AppShell>;
}
