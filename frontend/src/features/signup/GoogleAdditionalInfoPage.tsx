/**
 * Google additional-info screen (/signup/additional-info).
 *
 * Reached by a Google sign-in user whose Firestore user doc is
 * `pending_additional_info` (loginWithGoogle persisted the pending marker
 * via additionalInfoState.ts and the caller navigated here). This is a
 * SIBLING of the /signup/* wizard, not nested inside it (see the feature's
 * architecture doc §1.3): it never mounts SignupProvider/the stepper, and
 * keeps its own small local form state instead.
 *
 * On submit: submitAdditionalInfo (Callable) writes the full profile and
 * flips the Firestore doc to `active`, then a SECOND sessionLogin round trip
 * actually sets the Cookie (the first sessionLogin, done by loginWithGoogle,
 * deliberately did not - the user had no profile yet).
 */
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { httpsCallable } from 'firebase/functions'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { auth, functions } from '../../firebase/client'
import { mapAuthError, mapCallableError } from '../../firebase/errors'
import { ApiError, isApiError } from '../../api/apiError'
import { issueCsrfToken, sessionLogin } from '../../api/sessionApi'
import { toAddressPayload, toBusinessPayload } from '../../api/signupApi'
import { clearAdditionalInfoPending } from '../../auth/additionalInfoState'
import { useAuth } from '../../auth/useAuth'
import { DEFAULT_AUTHENTICATED_PATH } from '../../config'
import { NATIVE_SELECT_CLASS } from '../../components/nativeSelect'
import { PREFECTURES } from './addressSchema'
import { additionalInfoSchema, GENDERS, type AdditionalInfoFormValues } from './additionalInfoSchema'
import {
  NAME_KANA_LABEL,
  NAME_KANA_PLACEHOLDER,
  NAME_LABEL,
  NAME_PLACEHOLDER,
} from './nameRules'
import { SUPPORTED_COUNTRIES } from './countries'
import type { BusinessInfo } from './signupTypes'

const EMPTY_DEFAULTS: AdditionalInfoFormValues = {
  accountType: 'individual',
  name: '',
  nameKana: '',
  companyName: '',
  department: '',
  contactPerson: '',
  phoneNumber: '',
  dateOfBirth: '',
  gender: 'no_answer',
  newsletterOptIn: false,
  address: { country: 'JP', postalCode: '', prefecture: '', city: '', addressLine: '', building: '' },
}

/**
 * Wrapped in <RequireAdditionalInfo> at the router level (AppRouter.tsx),
 * matching the existing RequireAuth/RequireGuest convention rather than
 * self-guarding.
 */
export function GoogleAdditionalInfoPage() {
  const { recheckSession } = useAuth()
  const navigate = useNavigate()
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const form = useForm<AdditionalInfoFormValues>({
    resolver: zodResolver(additionalInfoSchema),
    defaultValues: EMPTY_DEFAULTS,
  })

  const accountType = useWatch({ control: form.control, name: 'accountType' })
  const country = useWatch({ control: form.control, name: 'address.country' })
  const isBusiness = accountType !== 'individual'
  const companyNameLabel = accountType === 'sole-proprietor' ? '屋号' : '会社名'
  const isJapan = country === 'JP'

  async function onSubmit(values: AdditionalInfoFormValues) {
    setFormError(null)
    setSubmitting(true)
    try {
      const business: BusinessInfo | null = values.accountType === 'individual'
        ? null
        : {
            companyName: values.companyName ?? '',
            department: values.department ?? '',
            contactPerson: values.contactPerson ?? '',
          }
      const { companyName: _companyName, department: _department, contactPerson: _contactPerson, address, ...rest } = values
      const profileInput = { ...rest, address: toAddressPayload(address), business: toBusinessPayload(business) }

      const submitAdditionalInfo = httpsCallable(functions, 'submitAdditionalInfo')
      try {
        await submitAdditionalInfo(profileInput)
      } catch (error) {
        throw mapCallableError(error)
      }

      const idToken = await auth.currentUser?.getIdToken()
      if (!idToken) throw new ApiError({ kind: 'server', status: 0 })

      const { csrfToken } = await issueCsrfToken()
      const result = await sessionLogin({ idToken, csrfToken })
      if (result.status !== 'ok') throw new ApiError({ kind: 'server', status: 0 })

      clearAdditionalInfoPending()
      await recheckSession()
      navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true })
    } catch (error) {
      setSubmitting(false)
      const mapped = error instanceof ApiError ? error : mapAuthError(error)
      setFormError(
        isApiError(mapped) && mapped.kind === 'validation'
          ? mapped.message
          : '登録を完了できませんでした。時間をおいて再度お試しください。',
      )
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-1 py-10">
    <Card>
      <CardHeader className="gap-1.5">
        <CardTitle className="text-lg"><h1 className="text-lg font-semibold">追加情報の入力</h1></CardTitle>
        <CardDescription>サービスのご利用に必要な情報を入力してください。</CardDescription>
      </CardHeader>
      <CardContent>
        {formError ? (
          <Alert variant="destructive" className="mb-4" role="alert">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <Form {...form}>
          <form onSubmit={(event) => void form.handleSubmit(onSubmit)(event)} noValidate className="space-y-6">
            <section className="space-y-4" aria-labelledby="additional-info-basic-heading">
              <h2 id="additional-info-basic-heading" className="text-sm font-semibold">
                基本情報
              </h2>

              <FormField
                control={form.control}
                name="accountType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>契約者種別</FormLabel>
                    <FormControl>
                      <RadioGroup value={field.value} onValueChange={field.onChange} className="flex gap-6 pt-1">
                        <label className="flex items-center gap-2 text-sm">
                          <RadioGroupItem value="individual" />
                          個人
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <RadioGroupItem value="sole-proprietor" />
                          個人事業主
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <RadioGroupItem value="corporate" />
                          法人
                        </label>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{NAME_LABEL}</FormLabel>
                      <FormControl>
                        <Input placeholder={NAME_PLACEHOLDER} autoComplete="name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="nameKana"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{NAME_KANA_LABEL}</FormLabel>
                      <FormControl>
                        <Input placeholder={NAME_KANA_PLACEHOLDER} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="dateOfBirth"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>生年月日</FormLabel>
                      <FormControl>
                        <Input type="date" autoComplete="bday" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="gender"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>性別</FormLabel>
                      <FormControl>
                        <select className={`${NATIVE_SELECT_CLASS} w-full`} {...field}>
                          {GENDERS.map((gender) => (
                            <option key={gender.value} value={gender.value}>
                              {gender.label}
                            </option>
                          ))}
                        </select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <FormField
                control={form.control}
                name="newsletterOptIn"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-start gap-2">
                      <FormControl>
                        <Checkbox checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                      </FormControl>
                      <FormLabel className="font-normal">お知らせメールを受け取る</FormLabel>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </section>

            {isBusiness ? (
              <>
                <Separator />
                <section className="space-y-4" aria-labelledby="additional-info-company-heading">
                  <h2 id="additional-info-company-heading" className="text-sm font-semibold">
                    会社情報
                  </h2>
                  <FormField
                    control={form.control}
                    name="companyName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{companyNameLabel}</FormLabel>
                        <FormControl>
                          <Input
                            placeholder={accountType === 'sole-proprietor' ? '山田商店' : '株式会社サンプル'}
                            autoComplete="organization"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="department"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>部署名（任意）</FormLabel>
                          <FormControl>
                            <Input placeholder="情報システム部" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="contactPerson"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>担当者名</FormLabel>
                          <FormControl>
                            <Input placeholder="山田 太郎" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </section>
              </>
            ) : null}

            <Separator />

            <section className="space-y-4" aria-labelledby="additional-info-address-heading">
              <h2 id="additional-info-address-heading" className="text-sm font-semibold">
                住所情報
              </h2>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="phoneNumber"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>電話番号</FormLabel>
                      <FormControl>
                        <Input type="tel" placeholder="090-1234-5678" autoComplete="tel" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="address.country"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>居住国</FormLabel>
                      <FormControl>
                        <select className={`${NATIVE_SELECT_CLASS} w-full`} {...field}>
                          {SUPPORTED_COUNTRIES.map((option) => (
                            <option key={option.code} value={option.code}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="address.postalCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>郵便番号</FormLabel>
                      <FormControl>
                        <Input
                          inputMode={isJapan ? 'numeric' : 'text'}
                          placeholder={isJapan ? '100-0001' : 'Postal code'}
                          autoComplete="postal-code"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                {isJapan ? (
                  <FormField
                    control={form.control}
                    name="address.prefecture"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>都道府県</FormLabel>
                        <FormControl>
                          <select className={`${NATIVE_SELECT_CLASS} w-full`} {...field}>
                            <option value="">選択してください</option>
                            {PREFECTURES.map((prefecture) => (
                              <option key={prefecture} value={prefecture}>
                                {prefecture}
                              </option>
                            ))}
                          </select>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ) : (
                  <FormField
                    control={form.control}
                    name="address.state"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>州・省（任意）</FormLabel>
                        <FormControl>
                          <Input placeholder="California" autoComplete="address-level1" {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                )}
              </div>

              <FormField
                control={form.control}
                name="address.city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>市区町村</FormLabel>
                    <FormControl>
                      <Input placeholder={isJapan ? '千代田区' : 'City'} autoComplete="address-level2" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {isJapan ? (
                <>
                  <FormField
                    control={form.control}
                    name="address.addressLine"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>番地</FormLabel>
                        <FormControl>
                          <Input placeholder="千代田1-1-1" autoComplete="address-line1" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="address.building"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>建物名（任意）</FormLabel>
                        <FormControl>
                          <Input placeholder="サンプルビル 3F" autoComplete="address-line2" {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              ) : (
                <>
                  <FormField
                    control={form.control}
                    name="address.addressLine1"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>住所1行目</FormLabel>
                        <FormControl>
                          <Input placeholder="123 Main St" autoComplete="address-line1" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="address.addressLine2"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>住所2行目（任意）</FormLabel>
                        <FormControl>
                          <Input placeholder="Apt 4B" autoComplete="address-line2" {...field} value={field.value ?? ''} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}
            </section>

            <div className="flex justify-end pt-2">
              <Button type="submit" size="lg" disabled={submitting}>
                {submitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {submitting ? '登録しています…' : 'この内容で登録する'}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
    </div>
  )
}
