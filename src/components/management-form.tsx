"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export type ManagementField = {
  name: string; label: string; type?: "text" | "number" | "email" | "datetime-local" | "select" | "multiselect" | "textarea";
  options?: { value: string; label: string }[]; required?: boolean; defaultValue?: string | string[]; step?: string; hint?: string;
  min?: number; max?: number; blankValue?: null;
};

function assignPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

export function ApiForm({ endpoint, method = "POST", title, submitLabel, fields = [], fixed = {}, redirectTo }: {
  endpoint: string; method?: "POST" | "PATCH" | "DELETE"; title?: string; submitLabel: string;
  fields?: ManagementField[]; fixed?: Record<string, unknown>; redirectTo?: string;
}) {
  const router = useRouter();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [invitationPath, setInvitationPath] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true); setMessage(""); setFailed(false); setInvitationPath(null);
    try {
      const data = new FormData(form);
      const body = structuredClone(fixed);
      for (const field of fields) {
        const value = String(data.get(field.name) ?? "");
        if (!value && !field.required && field.type !== "multiselect") {
          if (field.blankValue === null) assignPath(body, field.name, null);
          continue;
        }
        if (field.type === "datetime-local" && !Number.isFinite(new Date(value).getTime())) throw new Error("Revisa la fecha y hora indicadas.");
        assignPath(body, field.name, field.type === "multiselect" ? data.getAll(field.name).map(String) :
          field.type === "number" ? Number(value) : field.type === "datetime-local" ? new Date(value).toISOString() : value);
      }
      const response = await fetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || result.message || "No se pudo guardar. Revisa los campos y tus permisos.");
      setMessage("Cambios guardados.");
      const item = result.data ?? result;
      if (typeof item.invitationPath === "string" && /^\/invitations\/[a-f0-9]{64}$/.test(item.invitationPath)) setInvitationPath(item.invitationPath);
      if (redirectTo) router.push(redirectTo.replace("{id}", encodeURIComponent(item.id ?? "")).replace("{organizationId}", encodeURIComponent(item.organizationId ?? "")));
      router.refresh();
    } catch (error) {
      setFailed(true); setMessage(error instanceof Error ? error.message : "No se pudo guardar. Inténtalo nuevamente.");
    } finally { setBusy(false); }
  }
  return <form className="management-form" onSubmit={submit}>
    {title && <h3>{title}</h3>}
    {fields.length > 0 && <div className="form-grid">{fields.map((field) => {
      const fieldId = `${id}-${field.name}`;
      const props = { id: fieldId, name: field.name, required: field.required, defaultValue: field.defaultValue, "aria-describedby": field.hint ? `${fieldId}-hint` : undefined };
      return <label className="field" key={field.name} htmlFor={fieldId}><span>{field.label}{field.required ? " *" : ""}</span>
        {field.type === "select" || field.type === "multiselect" ? <select {...props} multiple={field.type === "multiselect"}>{field.type === "select" && (!field.defaultValue || !field.required) && <option value="">Selecciona una opción</option>}{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : field.type === "textarea" ? <textarea {...props} rows={3} /> : <input {...props} type={field.type ?? "text"} min={field.min} max={field.max} step={field.step ?? (field.type === "number" ? "any" : undefined)} />}
        {field.hint && <span className="field-hint" id={`${fieldId}-hint`}>{field.hint}</span>}</label>;
    })}</div>}
    <div className="form-actions"><button type="submit" className={`button${method === "DELETE" ? " button-secondary" : ""}`} disabled={busy}>{busy ? "Guardando…" : submitLabel}</button></div>
    {message && <p className={`form-result${failed ? " form-error" : ""}`} role={failed ? "alert" : "status"}>{message}</p>}
    {invitationPath && <div className="notice"><p>Guarda este enlace y compártelo con la persona invitada. Caduca en siete días y solo se muestra una vez.</p><Link className="invitation-link" href={invitationPath}>{typeof window === "undefined" ? invitationPath : `${window.location.origin}${invitationPath}`}</Link></div>}
  </form>;
}
