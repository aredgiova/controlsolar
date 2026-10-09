import { pathToFileURL } from "node:url";

const expected = { APP_ENV: "staging", DATA_ADAPTER: "demo", DEMO_MODE: "true" };
const privateConfiguration = /^(?:.*DATABASE_URL|DATABASE_MIGRATION_URL|COGNITO_.*|AUTH_SECRET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|REPORT_S3_.*|INGEST_DATABASE_SECRET_ARN|BACKUP_.*)$/;

export function checkVercelDemoEnvironment(environment) {
  const invalid = Object.entries(expected).filter(([key, value]) => environment[key] !== value).map(([key]) => key);
  const privateKeys = Object.keys(environment).filter((key) => privateConfiguration.test(key) && environment[key]);
  if (invalid.length) throw new Error(`Configura la demo de Vercel: APP_ENV=staging, DATA_ADAPTER=demo y DEMO_MODE=true. Revisa: ${invalid.join(", ")}.`);
  if (privateKeys.length) throw new Error(`El proyecto Vercel de demostración no admite configuración privada de servicios reales. Retira: ${privateKeys.join(", ")}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkVercelDemoEnvironment(process.env);
    console.log("Configuración Vercel demo válida: fixtures de consulta, sin servicios reales.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
