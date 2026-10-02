/**
 * Read-only profile display (/mypage/profile, default mode).
 *
 * email/authProvider are shown but never editable here (no email/password
 * change in scope - see `ProfileEditForm.tsx`'s doc comment).
 */
import { GENDERS, type ContractFormValues } from '../signup/contractSchema'
import { SUPPORTED_COUNTRIES } from '../signup/countries'
import type { WireAuthProvider, WireUserProfile } from '../../api/profileApi'

const AUTH_PROVIDER_LABELS: Record<WireAuthProvider, string> = {
  password: 'メールアドレスとパスワード',
  'google.com': 'Googleアカウント',
}

const ACCOUNT_TYPE_LABELS: Record<ContractFormValues['accountType'], string> = {
  individual: '個人',
  'sole-proprietor': '個人事業主',
  corporate: '法人',
}

function genderLabel(gender: WireUserProfile['gender']): string {
  return GENDERS.find((option) => option.value === gender)?.label ?? gender
}

function countryLabel(code: string): string {
  return SUPPORTED_COUNTRIES.find((option) => option.code === code)?.label ?? code
}

function formatAddress(address: WireUserProfile['address']): string {
  if (address.country === 'JP') {
    const building = address.building ? ` ${address.building}` : ''
    return `〒${address.postalCode} ${address.prefecture}${address.city}${address.addressLine}${building}`
  }
  const state = address.state ? `${address.state} ` : ''
  const line2 = address.addressLine2 ? ` ${address.addressLine2}` : ''
  return `${countryLabel(address.country)} ${address.postalCode} ${state}${address.city} ${address.addressLine1}${line2}`
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{value}</dd>
    </div>
  )
}

export function ProfileViewSection({
  email,
  authProvider,
  profile,
}: {
  email: string
  authProvider: WireAuthProvider
  profile: WireUserProfile
}) {
  return (
    <dl className="space-y-3">
      <Row label="メールアドレス" value={email} />
      <Row label="ログイン方法" value={AUTH_PROVIDER_LABELS[authProvider]} />
      <Row label="契約者種別" value={ACCOUNT_TYPE_LABELS[profile.accountType]} />
      <Row label="名前（漢字）" value={profile.name} />
      <Row label="名前（カナ）" value={profile.nameKana} />
      <Row label="生年月日" value={profile.dateOfBirth} />
      <Row label="性別" value={genderLabel(profile.gender)} />
      <Row label="お知らせメール" value={profile.newsletterOptIn ? '受け取る' : '受け取らない'} />
      {profile.business ? (
        <>
          <Row
            label={profile.accountType === 'sole-proprietor' ? '屋号' : '会社名'}
            value={profile.business.companyName}
          />
          <Row label="部署名" value={profile.business.department ?? '（未入力）'} />
          <Row label="担当者名" value={profile.business.contactPerson} />
        </>
      ) : null}
      <Row label="電話番号" value={profile.phoneNumber} />
      <Row label="住所" value={formatAddress(profile.address)} />
    </dl>
  )
}
