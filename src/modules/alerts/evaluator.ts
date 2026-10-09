import { createHash } from "node:crypto";
import { communicationPolicySchema, deviceAlarmPolicySchema, generationPolicySchema, invalidDataPolicySchema } from "@/contracts/alerts";
import { bindingMultiplier, topologyConfiguration } from "@/modules/telemetry/energy";
import type { AlertObservation, AlertRuleRecord, AlertState, AlertTransition, WorkerSnapshot } from "./types";

const epoch = (value: Date | string) => new Date(value).getTime();
const iso = (value: Date | string | null) => value === null ? null : new Date(value).toISOString();
function episodeId(rule: string, key: string, at: string) {
  const bytes = createHash("sha256").update(`${rule}|${key}|${at}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function observation(condition: AlertObservation["condition"], title: string, message: string, detail: Record<string, unknown> = {}): AlertObservation { return { dedupKey: "project", condition, title, message, severity: "warning", detail }; }
function currentPoints(snapshot: WorkerSnapshot) {
  const now = snapshot.evaluatedAt.getTime();
  const version = snapshot.topologyVersions.find((entry) => epoch(entry.validFrom) <= now && (!entry.validTo || epoch(entry.validTo) > now));
  const policy = topologyConfiguration(version?.configuration);
  if (!policy) return null;
  const ids = [policy.generationPointId, policy.gridPointId, ...(policy.consumptionPointId ? [policy.consumptionPointId] : [])];
  const points = ids.map((id) => ({ id, binding: snapshot.bindings.find((entry) => entry.measurementPointId === id && epoch(entry.validFrom) <= now && (!entry.validTo || epoch(entry.validTo) > now)) }));
  return points.every((point) => point.binding) ? { policy, points } : null;
}
function latest(snapshot: WorkerSnapshot, pointId: string) { return snapshot.latestSamples.filter((sample) => sample.measurementPointId === pointId).sort((a, b) => epoch(b.measuredAt) - epoch(a.measuredAt))[0]; }
function currentSample(snapshot: WorkerSnapshot, point: NonNullable<ReturnType<typeof currentPoints>>["points"][number]) {
  const sample = latest(snapshot, point.id);
  return sample && sample.bindingId === point.binding!.id && sample.deviceId === point.binding!.deviceId && sample.configurationVersion === point.binding!.configurationVersion ? sample : undefined;
}
function fresh(snapshot: WorkerSnapshot, sample: WorkerSnapshot["latestSamples"][number] | undefined, seconds: number) { return Boolean(sample && Math.max(snapshot.evaluatedAt.getTime() - epoch(sample.measuredAt), snapshot.evaluatedAt.getTime() - epoch(sample.receivedAt)) <= seconds * 1000); }
export function withinGenerationWindow(now: Date, timezone: string, policy: { startLocalTime: string; endLocalTime: string; weekdays: number[] }): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)!.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
  const minutes = Number(part("hour")) * 60 + Number(part("minute"));
  const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = clock(policy.startLocalTime), end = clock(policy.endLocalTime);
  return start < end ? policy.weekdays.includes(weekday) && minutes >= start && minutes < end : minutes >= start ? policy.weekdays.includes(weekday) : minutes < end && policy.weekdays.includes((weekday + 6) % 7);
}

export function observeRule(rule: AlertRuleRecord, snapshot: WorkerSnapshot): AlertObservation[] {
  const states = snapshot.states.filter((state) => state.ruleId === rule.id);
  const unknown = (reason: string) => states.length ? states.map((state) => ({ ...observation("unknown", state.title, state.message, { reason }), dedupKey: state.dedupKey, severity: state.severity })) : [observation("unknown", rule.name, "No hay datos suficientes para evaluar la política.", { reason })];
  if (!rule.enabled) return states.map((state) => ({ ...observation("normal", state.title, "La regla se desactivó explícitamente.", { reason: "rule_disabled" }), dedupKey: state.dedupKey, severity: state.severity, forceResolve: true }));
  if (!snapshot.project.commissionedAt) return unknown("project_not_commissioned");
  if (snapshot.maintenanceWindows.some((window) => !window.cancelledAt && epoch(window.from) <= snapshot.evaluatedAt.getTime() && epoch(window.to) > snapshot.evaluatedAt.getTime())) return unknown("scheduled_maintenance");
  const required = currentPoints(snapshot);
  if (!required) return unknown("incomplete_current_topology");
  if (rule.kind === "communication") {
    const parsed = communicationPolicySchema.safeParse(rule.configuration); if (!parsed.success) return unknown("invalid_rule_configuration");
    let startupGrace = false;
    const missing = required.points.filter((point) => {
      const sample = currentSample(snapshot, point);
      const graceStart = Math.max(epoch(rule.createdAt), epoch(snapshot.project.commissionedAt!), epoch(point.binding!.validFrom));
      if (!sample && snapshot.evaluatedAt.getTime() - graceStart < parsed.data.staleAfterSeconds * 1000) { startupGrace = true; return false; }
      return sample ? !fresh(snapshot, sample, parsed.data.staleAfterSeconds) || sample.quality === "missing" : true;
    });
    if (!missing.length && startupGrace) return unknown("initial_reading_grace");
    return [observation(missing.length ? "abnormal" : "normal", "Sin lecturas recientes", missing.length ? `No llegan lecturas vigentes de ${missing.length} puntos requeridos.` : "Los puntos requeridos tienen lecturas recientes.", { pointIds: missing.map((point) => point.id), staleAfterSeconds: parsed.data.staleAfterSeconds })];
  }
  if (rule.kind === "invalid_data") {
    const parsed = invalidDataPolicySchema.safeParse(rule.configuration); if (!parsed.success) return unknown("invalid_rule_configuration");
    const samples = required.points.map((point) => currentSample(snapshot, point));
    const invalid = samples.filter((sample) => fresh(snapshot, sample, parsed.data.maxMeasurementAgeSeconds) && sample!.quality === "invalid");
    if (invalid.length) return [observation("abnormal", "Dato reportado inválido", "Una o más lecturas recientes están marcadas como inválidas por su origen.", { pointIds: invalid.map((sample) => sample!.measurementPointId) })];
    return samples.every((sample) => fresh(snapshot, sample, parsed.data.maxMeasurementAgeSeconds) && sample!.quality === "measured") ? [observation("normal", "Dato reportado inválido", "Las lecturas recientes recuperaron la calidad medida.")] : unknown("missing_or_stale_quality");
  }
  if (rule.kind === "generation") {
    const parsed = generationPolicySchema.safeParse(rule.configuration); if (!parsed.success) return unknown("invalid_rule_configuration");
    if (!withinGenerationWindow(snapshot.evaluatedAt, snapshot.project.timezone, parsed.data)) return [observation("normal", "Generación bajo mínimo configurado", "Fuera de la ventana horaria configurada.", { reason: "outside_generation_window" })];
    const point = required.points.find((entry) => entry.id === required.policy.generationPointId)!, sample = currentSample(snapshot, point);
    if (!fresh(snapshot, sample, parsed.data.maxMeasurementAgeSeconds) || sample!.quality !== "measured" || sample!.activePower === null) return unknown("generation_not_fresh_measured");
    const powerKw = sample!.activePower! * bindingMultiplier(point.binding!);
    return [observation(powerKw < parsed.data.minimumPowerKw ? "abnormal" : "normal", "Generación bajo mínimo configurado", powerKw < parsed.data.minimumPowerKw ? "La potencia medida está por debajo del umbral y horario configurados; requiere revisión del contexto." : "La potencia medida cumple el mínimo configurado.", { powerKw, minimumPowerKw: parsed.data.minimumPowerKw, measuredAt: iso(sample!.measuredAt), source: sample!.source })];
  }
  const parsed = deviceAlarmPolicySchema.safeParse(rule.configuration); if (!parsed.success) return unknown("invalid_rule_configuration");
  const observations: AlertObservation[] = [];
  for (const point of required.points) {
    const sample = currentSample(snapshot, point), prefix = `${point.id}:alarm:`;
    const old = states.filter((state) => state.dedupKey.startsWith(prefix));
    if (!fresh(snapshot, sample, parsed.data.maxMeasurementAgeSeconds) || sample!.alarms == null || sample!.quality !== "measured") {
      observations.push(...old.map((state) => ({ ...observation("unknown", state.title, state.message, { reason: "device_alarm_report_unavailable" }), dedupKey: state.dedupKey, severity: state.severity }))); continue;
    }
    const reports = sample!.alarms!;
    const codes = new Set([...reports.map((alarm) => alarm.code), ...old.map((state) => decodeURIComponent(state.dedupKey.slice(prefix.length)))]);
    for (const code of codes) {
      const alarm = reports.find((entry) => entry.code === code), key = `${prefix}${encodeURIComponent(code)}`;
      const active = Boolean(alarm?.active && (parsed.data.minimumSeverity === "warning" || alarm.severity === "critical"));
      if (!active && !old.some((state) => state.dedupKey === key)) continue;
      observations.push({ ...observation(active ? "abnormal" : "normal", `Alarma reportada por equipo: ${code}`, active ? "El equipo reportó esta alarma explícitamente." : "El reporte explícito del equipo ya no contiene esta alarma activa.", { pointId: point.id, code, measuredAt: iso(sample!.measuredAt), source: sample!.source }), dedupKey: key, severity: alarm?.severity ?? old.find((state) => state.dedupKey === key)!.severity });
    }
  }
  return observations;
}

/** Unknown evidence interrupts persistence/recovery and never invents a healthy or faulty state. */
export function advanceAlertState(rule: AlertRuleRecord, previous: AlertState | undefined, observation: AlertObservation, now: Date): AlertTransition | null {
  if (previous?.lastEvaluatedAt && epoch(previous.lastEvaluatedAt) >= now.getTime()) return null;
  const at = now.toISOString();
  if (!previous && observation.condition !== "abnormal") return null;
  const result: AlertTransition = { ruleId: rule.id, dedupKey: observation.dedupKey, episodeId: previous?.episodeId ?? episodeId(rule.id, observation.dedupKey, at), status: previous?.status ?? "pending", candidateSince: iso(previous?.candidateSince ?? null), recoverySince: iso(previous?.recoverySince ?? null), activatedAt: iso(previous?.activatedAt ?? null), resolvedAt: iso(previous?.resolvedAt ?? null), lastEvaluatedAt: at, title: observation.title, message: observation.message, severity: observation.severity, detail: observation.detail, event: null };
  if (observation.condition === "abnormal") {
    result.recoverySince = null;
    if (!previous || previous.status === "resolved") { result.episodeId = episodeId(rule.id, observation.dedupKey, at); result.status = "pending"; result.candidateSince = at; result.activatedAt = null; result.resolvedAt = null; }
    if (result.status === "pending" && rule.updatedAt && epoch(rule.updatedAt) > epoch(result.candidateSince!)) { result.candidateSince = at; result.episodeId = episodeId(rule.id, observation.dedupKey, at); }
    if (result.status === "pending" && now.getTime() - epoch(result.candidateSince!) >= rule.persistenceSeconds * 1000) { result.status = "active"; result.activatedAt = at; result.event = "activated"; }
    return result;
  }
  if (result.status === "resolved") return null;
  if (result.status === "pending") { result.status = "resolved"; result.candidateSince = null; result.resolvedAt = at; return result; }
  if (observation.condition === "unknown") { result.recoverySince = null; return result; }
  result.recoverySince ??= at;
  if (rule.updatedAt && epoch(rule.updatedAt) > epoch(result.recoverySince)) result.recoverySince = at;
  if (observation.forceResolve || now.getTime() - epoch(result.recoverySince) >= rule.recoverySeconds * 1000) { result.status = "resolved"; result.resolvedAt = at; result.candidateSince = null; result.recoverySince = null; result.event = "resolved"; }
  return result;
}
export function evaluateProject(snapshot: WorkerSnapshot): AlertTransition[] {
  return snapshot.rules.flatMap((rule) => observeRule(rule, snapshot).flatMap((observation) => {
    const next = advanceAlertState(rule, snapshot.states.find((state) => state.ruleId === rule.id && state.dedupKey === observation.dedupKey), observation, snapshot.evaluatedAt);
    return next ? [next] : [];
  }));
}
