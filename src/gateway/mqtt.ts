import { readFile, stat } from "node:fs/promises";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import type { GatewayConfiguration } from "./config";
import type { TelemetryPacket } from "../modules/telemetry/protocol";

export interface PacketPublisher { publish(packet: TelemetryPacket): Promise<void>; close(): Promise<void> }

export async function createMqttPublisher(configuration: GatewayConfiguration): Promise<PacketPublisher> {
  const keyInfo = await stat(configuration.privateKeyPath);
  if (process.platform !== "win32" && (keyInfo.mode & 0o077) !== 0) throw new Error("La clave privada requiere permisos 0600.");
  const [cert, key, ca] = await Promise.all([readFile(configuration.certificatePath), readFile(configuration.privateKeyPath), readFile(configuration.caPath)]);
  const options: IClientOptions & { minVersion: "TLSv1.2" } = {
    clientId: configuration.clientId, cert, key, ca, rejectUnauthorized: true, minVersion: "TLSv1.2",
    clean: true, protocolVersion: 4, reconnectPeriod: 5000, connectTimeout: 10000, keepalive: 60,
    queueQoSZero: false, resubscribe: false,
  };
  const client: MqttClient = mqtt.connect(`mqtts://${configuration.endpoint}:8883`, options);
  // Errors are observed without printing certificate material, packet contents, or endpoints.
  client.on("error", () => {});
  let pending = false;
  return {
    async publish(packet) {
      if (!client.connected) throw new Error("El enlace MQTT todavía no está disponible.");
      // A timed-out QoS1 operation may still live in MQTT's retransmit store.
      // Keep at most one there until its callback; SQLite owns all other data.
      if (pending) throw new Error("La publicación MQTT anterior sigue pendiente.");
      pending = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No se confirmó la publicación MQTT.")), 15000);
        client.publish(configuration.topic, JSON.stringify(packet), { qos: 1, retain: false }, (error) => {
          pending = false;
          clearTimeout(timer);
          if (error) reject(new Error("No se confirmó la publicación MQTT.")); else resolve();
        });
      });
    },
    async close() { await client.endAsync(true); },
  };
}
