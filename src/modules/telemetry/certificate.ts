/** AWS IoT principal() for an X.509 MQTT connection: SHA256 over certificate DER. */
export function normalizeCertificateThumbprint(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Huella X.509 inválida: requiere 64 caracteres hexadecimales sin separadores.");
  return value.toLowerCase();
}
