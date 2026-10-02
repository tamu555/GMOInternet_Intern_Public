/**
 * Account e-mail constraints (spec §3.4).
 *
 * Only the REGISTRATION side of the rule survives here: `/signup`
 * (`features/signup/accountSchema.ts`) still limits new accounts to the demo
 * registries' domains. The login form no longer knows about this list — it
 * takes any well-formed address and lets the 401 answer for the rest
 * (`features/auth/validation.ts`).
 */

/** The only e-mail domains a new account may be registered with (spec §3.4). */
export const ALLOWED_EMAIL_DOMAINS = ['example.com', 'example.net', 'example.org'] as const

export type AllowedEmailDomain = (typeof ALLOWED_EMAIL_DOMAINS)[number]
