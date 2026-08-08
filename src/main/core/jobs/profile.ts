import { z } from 'zod'
import type { CandidateProfile } from './types'

/**
 * El perfil es input externo igual que cualquier fila de Supabase: vive en un
 * JSON editable a mano en el workspace. Se valida entero acá, una vez, al
 * arrancar — si está roto queremos enterarnos antes de abrir el navegador, no
 * a mitad de un formulario.
 */
export const CandidateProfileSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(6),
  phoneCountryCode: z.string().min(1),
  country: z.string().min(1),
  countryCode: z.string().min(2),
  city: z.string().min(1),
  linkedinUrl: z.string().url(),
  githubUrl: z.string().url(),
  portfolioUrl: z.string().url(),
  headline: z.string().min(1),
  currentCompany: z.string().min(1),
  currentTitle: z.string().min(1),
  yearsExperience: z.record(z.string(), z.number().nonnegative()),
  workAuthorized: z.boolean(),
  requiresSponsorship: z.boolean(),
  willingToRelocate: z.boolean(),
  remoteOnly: z.boolean(),
  expectedSalaryUsdMonthly: z.number().positive(),
  noticePeriodDays: z.number().nonnegative(),
  englishLevel: z.string().min(1),
  spanishLevel: z.string().min(1),
  highestEducation: z.string().min(1),
  cvFileBaseName: z.string().min(1),
  coverFileBaseName: z.string().min(1),
  declineToSelfIdentify: z.string().min(1)
})

export function parseProfile(raw: unknown): CandidateProfile {
  const parsed = CandidateProfileSchema.parse(raw)

  if (parsed.yearsExperience.default === undefined) {
    // Sin `default` la primera pregunta por una tecnología que no está en la
    // tabla queda sin responder. Es un error del JSON, no un caso a manejar.
    throw new Error('yearsExperience necesita una clave "default"')
  }

  return parsed
}
