import { z } from "zod";
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => { const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value; }, "La fecha local no es válida.");
export const reportRequestSchema = z.strictObject({ startDate: localDate, endDate: localDate, idempotencyKey: z.uuid() }).refine((value) => { const days = (Date.parse(value.endDate) - Date.parse(value.startDate)) / 86400000; return days >= 0 && days < 31; }, "Selecciona entre 1 y 31 días inclusivos.");
export const reportDownloadTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export type ReportRequest = z.infer<typeof reportRequestSchema>;
