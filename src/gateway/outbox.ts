import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { telemetryMessageSchema, telemetryPacketSchema, type TelemetryMessage, type TelemetryPacket } from "../modules/telemetry/protocol";

type Row = { event_id: string; body: string; measured_ms: number; bytes: number };
type LossRow = { report_id: string; from_ms: number; to_ms: number; dropped: number };
type Inflight = { body: string; event_ids: string; report_ids: string };

export class DurableOutbox {
  private readonly db: DatabaseSync;
  constructor(path: string, private readonly limits: { maxSamples: number; maxBytes: number; freshWindowMs?: number }) {
    if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("El gateway requiere Node.js 24.");
    if (!Number.isInteger(limits.maxSamples) || limits.maxSamples < 1 || limits.maxSamples > 1_000_000 || !Number.isInteger(limits.maxBytes) || limits.maxBytes < 1024) throw new Error("Límites del buffer inválidos.");
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=100;
      PRAGMA max_page_count=${Math.ceil((limits.maxBytes * 2 + 262144) / 4096)};
      CREATE TABLE IF NOT EXISTS outbox(event_id TEXT PRIMARY KEY, body TEXT NOT NULL, measured_ms INTEGER NOT NULL, bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS outbox_time ON outbox(measured_ms,event_id);
      CREATE TABLE IF NOT EXISTS losses(report_id TEXT PRIMARY KEY,from_ms INTEGER NOT NULL,to_ms INTEGER NOT NULL,dropped INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inflight(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL,event_ids TEXT NOT NULL,report_ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters(id INTEGER PRIMARY KEY CHECK(id=1),dropped INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO counters(id,dropped) VALUES(1,0);`);
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private current() { return this.db.prepare("SELECT body,event_ids,report_ids FROM inflight WHERE id=1").get() as Inflight | undefined; }
  enqueue(input: TelemetryMessage) {
    const sample = telemetryMessageSchema.parse(input);
    const body = JSON.stringify(sample);
    const bytes = Buffer.byteLength(body);
    if (bytes > 60_000) throw new Error("La observación excede el tamaño permitido.");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT body FROM outbox WHERE event_id=?").get(sample.event_id) as { body: string } | undefined;
      if (existing) { if (existing.body !== body) throw new Error("Identificador de evento reutilizado con otro contenido."); return false; }
      this.db.prepare("INSERT INTO outbox VALUES(?,?,?,?)").run(sample.event_id, body, Date.parse(sample.measured_at), bytes);
      const inflight = this.current();
      const pinned = new Set<string>(inflight ? JSON.parse(inflight.event_ids) : []);
      const pinnedReports = new Set<string>(inflight ? JSON.parse(inflight.report_ids) : []);
      for (;;) {
        const totals = this.stats();
        if (totals.samples <= this.limits.maxSamples && totals.bytes <= this.limits.maxBytes) break;
        const placeholders = [...pinned].map(() => "?").join(",");
        const row = this.db.prepare(`SELECT event_id,measured_ms FROM outbox ${pinned.size ? `WHERE event_id NOT IN (${placeholders})` : ""} ORDER BY measured_ms,event_id LIMIT 1`).get(...pinned) as Pick<Row, "event_id" | "measured_ms"> | undefined;
        if (!row) throw new Error("Buffer lleno con una entrega pendiente; no se eliminó información sin registrarla.");
        const pending = (this.db.prepare("SELECT * FROM losses ORDER BY from_ms").all() as LossRow[]).find((loss) => !pinnedReports.has(loss.report_id));
        if (pending) this.db.prepare("UPDATE losses SET from_ms=?,to_ms=?,dropped=dropped+1 WHERE report_id=?").run(Math.min(pending.from_ms, row.measured_ms), Math.max(pending.to_ms, row.measured_ms), pending.report_id);
        else this.db.prepare("INSERT INTO losses VALUES(?,?,?,1)").run(randomUUID(), row.measured_ms, row.measured_ms);
        this.db.prepare("UPDATE counters SET dropped=dropped+1 WHERE id=1").run();
        this.db.prepare("DELETE FROM outbox WHERE event_id=?").run(row.event_id);
      }
      return true;
    });
  }
  prepare(gatewayId: string, now = new Date(), batchSize = 40): TelemetryPacket | null {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("Tamaño de lote inválido.");
    return this.transaction(() => {
      const current = this.current();
      if (current) return telemetryPacketSchema.parse(JSON.parse(current.body));
      const boundary = now.getTime() - (this.limits.freshWindowMs ?? 60_000);
      const fresh = this.db.prepare("SELECT * FROM outbox WHERE measured_ms>=? ORDER BY measured_ms DESC,event_id LIMIT ?").all(boundary, batchSize) as Row[];
      const backfill = this.db.prepare("SELECT * FROM outbox WHERE measured_ms<? ORDER BY measured_ms,event_id LIMIT ?").all(boundary, batchSize) as Row[];
      const selected: Row[] = [];
      for (let index = 0; index < batchSize; index++) {
        const preferred = index % 4 === 3 ? backfill : fresh;
        const fallback = preferred === fresh ? backfill : fresh;
        const next = preferred.shift() ?? fallback.shift();
        if (!next) break;
        selected.push(next);
      }
      const losses = this.db.prepare("SELECT * FROM losses ORDER BY from_ms LIMIT 2").all() as LossRow[];
      if (!selected.length && !losses.length) return null;
      const packet: TelemetryPacket = { schema_version: "2.0", gateway_id: gatewayId, packet_id: randomUUID(), sent_at: now.toISOString(), samples: [], loss_reports: losses.map((loss) => ({ report_id: loss.report_id, from: new Date(loss.from_ms).toISOString(), to: new Date(loss.to_ms).toISOString(), dropped: loss.dropped, reason: "buffer_capacity" })) };
      for (const row of selected) {
        packet.samples.push(JSON.parse(row.body));
        if (Buffer.byteLength(JSON.stringify(packet)) > 65536) { packet.samples.pop(); break; }
      }
      telemetryPacketSchema.parse(packet);
      this.db.prepare("INSERT INTO inflight VALUES(1,?,?,?)").run(JSON.stringify(packet), JSON.stringify(packet.samples.map((sample) => sample.event_id)), JSON.stringify(packet.loss_reports.map((loss) => loss.report_id)));
      return packet;
    });
  }
  acknowledge(packetId: string) {
    return this.transaction(() => {
      const current = this.current();
      if (!current || JSON.parse(current.body).packet_id !== packetId) return false;
      for (const id of JSON.parse(current.event_ids) as string[]) this.db.prepare("DELETE FROM outbox WHERE event_id=?").run(id);
      for (const id of JSON.parse(current.report_ids) as string[]) this.db.prepare("DELETE FROM losses WHERE report_id=?").run(id);
      this.db.prepare("DELETE FROM inflight WHERE id=1").run();
      return true;
    });
  }
  stats() {
    const rows = this.db.prepare("SELECT count(*) AS samples,coalesce(sum(bytes),0) AS bytes FROM outbox").get() as { samples: number; bytes: number };
    const { dropped } = this.db.prepare("SELECT dropped FROM counters WHERE id=1").get() as { dropped: number };
    return { ...rows, dropped };
  }
  close() { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}
