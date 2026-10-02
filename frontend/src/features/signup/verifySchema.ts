/** Validation schema for step 2 メール認証 (zod v4). */
import { z } from 'zod'

export const VERIFICATION_CODE_LENGTH = 6

export const verifySchema = z.object({
  code: z
    .string()
    .length(VERIFICATION_CODE_LENGTH, `${VERIFICATION_CODE_LENGTH}桁の認証コードを入力してください。`)
    .regex(/^\d+$/, '認証コードは数字で入力してください。'),
})

export type VerifyFormValues = z.infer<typeof verifySchema>
