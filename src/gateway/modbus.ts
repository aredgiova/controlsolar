import { createConnection } from "node:net";

export class ModbusError extends Error {
  constructor(public readonly code: "TIMEOUT" | "NETWORK" | "FRAME" | "EXCEPTION" | "VALUE") {
    super(`Lectura Modbus no disponible (${code}).`);
    this.name = "ModbusError";
  }
}

export type ModbusTarget = { host: string; port: number; unitId: number; timeoutMs?: number };

// Read-only FC04 through an Ethernet <-> RS485 Modbus TCP/RTU gateway.
export async function readInputRegisters(target: ModbusTarget, address: number, count: number): Promise<Buffer> {
  if (!target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535 ||
      !Number.isInteger(target.unitId) || target.unitId < 1 || target.unitId > 247 ||
      !Number.isInteger(address) || address < 0 || address > 65535 || !Number.isInteger(count) || count < 2 || count > 80 || address + count > 65536) throw new ModbusError("FRAME");
  const transaction = Math.floor(Math.random() * 65536);
  const request = Buffer.alloc(12);
  request.writeUInt16BE(transaction, 0); request.writeUInt16BE(0, 2); request.writeUInt16BE(6, 4);
  request[6] = target.unitId; request[7] = 4;
  request.writeUInt16BE(address, 8); request.writeUInt16BE(count, 10);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.host, port: target.port });
    let received: Buffer = Buffer.alloc(0);
    let done = false;
    const finish = (error?: ModbusError, data?: Buffer) => {
      if (done) return;
      done = true; socket.destroy();
      if (error) reject(error); else resolve(data!);
    };
    socket.setTimeout(Math.max(100, Math.min(target.timeoutMs ?? 2000, 10_000)), () => finish(new ModbusError("TIMEOUT")));
    socket.once("error", () => finish(new ModbusError("NETWORK")));
    socket.once("close", () => { if (!done) finish(new ModbusError("FRAME")); });
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > 260) return finish(new ModbusError("FRAME"));
      if (received.length < 7) return;
      const length = received.readUInt16BE(4);
      if (length < 3 || length > 254 || received.readUInt16BE(0) !== transaction || received.readUInt16BE(2) !== 0 || received[6] !== target.unitId) return finish(new ModbusError("FRAME"));
      if (received.length < 6 + length) return;
      if (received.length !== 6 + length) return finish(new ModbusError("FRAME"));
      if (received[7] === 0x84) return finish(new ModbusError("EXCEPTION"));
      if (received[7] !== 4 || received[8] !== count * 2 || length !== count * 2 + 3) return finish(new ModbusError("FRAME"));
      finish(undefined, received.subarray(9));
    });
  });
}

export type WordOrder = "high-first" | "low-first";
export function float32(registers: Buffer, byteOffset: number, order: WordOrder = "high-first") {
  if (byteOffset < 0 || byteOffset + 4 > registers.length) throw new ModbusError("FRAME");
  const data = Buffer.from(registers.subarray(byteOffset, byteOffset + 4));
  if (order === "low-first") { const high = data.readUInt16BE(0); data.writeUInt16BE(data.readUInt16BE(2), 0); data.writeUInt16BE(high, 2); }
  const value = data.readFloatBE();
  if (!Number.isFinite(value)) throw new ModbusError("VALUE");
  return value;
}

export type MeterReading = {
  values: { active_power: number; import_energy: number; export_energy: number };
  phases: { phase: "A" | "B" | "C"; voltage_v: number; current_a: number; active_power_kw: number }[];
};

// Exact SDM630MCT, protocol v1.7, normal float32 order. Not a generic SDM family map.
export function decodeSdm630Mct(phaseRegisters: Buffer, powerRegisters: Buffer, energyRegisters: Buffer, options: { wordOrder?: WordOrder; powerSign?: 1 | -1 } = {}): MeterReading {
  const order = options.wordOrder ?? "high-first";
  const sign = options.powerSign ?? 1;
  if (phaseRegisters.length !== 36 || powerRegisters.length !== 4 || energyRegisters.length !== 8) throw new ModbusError("FRAME");
  const phases = (["A", "B", "C"] as const).map((phase, index) => ({
    phase, voltage_v: float32(phaseRegisters, index * 4, order),
    current_a: float32(phaseRegisters, 12 + index * 4, order),
    active_power_kw: sign * float32(phaseRegisters, 24 + index * 4, order) / 1000,
  }));
  const imported = float32(energyRegisters, 0, order);
  const exported = float32(energyRegisters, 4, order);
  if (imported < 0 || exported < 0 || phases.some((phase) => phase.voltage_v < 0 || phase.current_a < 0)) throw new ModbusError("VALUE");
  return { values: { active_power: sign * float32(powerRegisters, 0, order) / 1000, import_energy: sign === 1 ? imported : exported, export_energy: sign === 1 ? exported : imported }, phases };
}

export async function readSdm630Mct(target: ModbusTarget, options: { wordOrder?: WordOrder; powerSign?: 1 | -1 } = {}) {
  const phases = await readInputRegisters(target, 0, 18);
  const power = await readInputRegisters(target, 52, 2);
  const energy = await readInputRegisters(target, 72, 4);
  return decodeSdm630Mct(phases, power, energy, options);
}
