/**
 * Step 3 契約者情報入力画面 (/signup/contract).
 *
 * Sections: 基本情報 / 会社情報 (sole-proprietor/corporate only) / 住所情報.
 * The business block is conditionally RENDERED (not hidden) and its
 * requirements are enforced schema-side only while 契約者種別 != 個人
 * (contractSchema.ts). Sole-proprietor reuses the exact same fields as
 * corporate, just with the 会社名 label swapped for 屋号.
 *
 * 都道府県/性別/居住国 stay NATIVE <select>s on purpose - same reasoning as
 * the display-name control in features/auth/RegisterPage.tsx: the flow
 * tests drive them with userEvent.selectOptions, which needs a real
 * <select>.
 */
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Separator } from '@/components/ui/separator'
import { NATIVE_SELECT_CLASS } from '../../components/nativeSelect'
import { PREFECTURES } from './addressSchema'
import { contractSchema, GENDERS, type ContractFormValues } from './contractSchema'
import {
  NAME_KANA_LABEL,
  NAME_KANA_PLACEHOLDER,
  NAME_LABEL,
  NAME_PLACEHOLDER,
} from './nameRules'
import { SUPPORTED_COUNTRIES } from './countries'
import type { BusinessInfo } from './signupTypes'
import { useSignup } from './useSignup'
import { useSignupGate } from './useSignupGate'

export function SignupContractPage() {
  const gate = useSignupGate('contract')
  const { state, saveContract } = useSignup()
  const navigate = useNavigate()

  const form = useForm<ContractFormValues>({
    resolver: zodResolver(contractSchema),
    defaultValues: {
      accountType: state.data.accountType,
      // 氏名/カナ arrive pre-filled from step 1 and stay editable here.
      name: state.data.name,
      nameKana: state.data.nameKana,
      companyName: state.data.business?.companyName ?? '',
      department: state.data.business?.department ?? '',
      contactPerson: state.data.business?.contactPerson ?? '',
      phoneNumber: state.data.phoneNumber,
      dateOfBirth: state.data.dateOfBirth,
      gender: state.data.gender,
      newsletterOptIn: state.data.newsletterOptIn,
      address: state.data.address,
    },
  })

  const accountType = useWatch({ control: form.control, name: 'accountType' })
  const country = useWatch({ control: form.control, name: 'address.country' })
  const isBusiness = accountType !== 'individual'
  const companyNameLabel = accountType === 'sole-proprietor' ? '屋号' : '会社名'
  const isJapan = country === 'JP'

  if (gate) return gate

  function onSubmit(values: ContractFormValues) {
    const business: BusinessInfo | null = values.accountType === 'individual'
      ? null
      : {
          companyName: values.companyName ?? '',
          department: values.department ?? '',
          contactPerson: values.contactPerson ?? '',
        }
    saveContract({
      accountType: values.accountType,
      name: values.name,
      nameKana: values.nameKana,
      phoneNumber: values.phoneNumber,
      dateOfBirth: values.dateOfBirth,
      gender: values.gender,
      newsletterOptIn: values.newsletterOptIn,
      business,
      address: values.address,
    })
    navigate('/signup/confirm')
  }

  return (
    <Card>
      <CardHeader className="gap-1.5">
        <CardTitle className="text-lg"><h1 className="text-lg font-semibold">契約者情報の入力</h1></CardTitle>
        <CardDescription>サービスのご利用に必要な契約者情報を入力してください。</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={(event) => void form.handleSubmit(onSubmit)(event)} noValidate className="space-y-6">
            <section className="space-y-4" aria-labelledby="signup-basic-heading">
              <h2 id="signup-basic-heading" className="text-sm font-semibold">
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
                <section className="space-y-4" aria-labelledby="signup-company-heading">
                  <h2 id="signup-company-heading" className="text-sm font-semibold">
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

            <section className="space-y-4" aria-labelledby="signup-address-heading">
              <h2 id="signup-address-heading" className="text-sm font-semibold">
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

            <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
              <Button type="button" variant="outline" onClick={() => navigate(-1)}>
                戻る
              </Button>
              <Button type="submit">確認画面へ</Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}
