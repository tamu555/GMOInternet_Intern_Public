/**
 * 退会（アカウント削除）確認ダイアログ (docs/仕様/auth.md §4.8).
 *
 * Two steps, mirroring RetireDialog.tsx's "explain the impact, then a
 * separate destructive confirm step" pattern (DESIGN_SYSTEM.md):
 *   1. 'explain' - impact + 30-day grace period, must be shown before any
 *      destructive action is offered.
 *   2. 'confirm' - provider-specific re-authentication, immediately followed
 *      by the matching deletion Callable:
 *        password -> reauthenticateWithCredential -> deleteAccountWithPassword
 *        google.com -> reauthenticateWithPopup -> deleteAccountWithGoogle
 *      (auth/reauth.ts + api/profileApi.ts). A wrong password (or a failed
 *      Google re-auth) stops here - the deletion Callable is never called.
 *
 * Like RetireDialog, the step lives in the mounted-while-open body component:
 * Radix unmounts DialogContent while closed, so every open starts fresh at
 * 'explain' with no reset effect needed.
 */
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { z } from 'zod'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { StatusBanner } from '../../components/StatusBanner'
import { isApiError } from '../../api/apiError'
import { fetchMyDomains } from '../../api/myDomainsApi'
import { deleteAccountWithGoogle, deleteAccountWithPassword, type WireAuthProvider } from '../../api/profileApi'
import { reauthenticateWithGoogle, reauthenticateWithPassword } from '../../auth/reauth'
import {
  accountDeleteDomainsOwnedMessage,
  ACCOUNT_DELETE_GRACE_EXPLANATION,
  ACCOUNT_DELETE_IMPACT_WARNING,
  ACCOUNT_DELETE_PASSWORD_LABEL,
  ACCOUNT_DELETE_PASSWORD_PLACEHOLDER,
  ACCOUNT_DELETE_PROVIDER_MISMATCH_MESSAGE,
  ACCOUNT_DELETE_REAUTH_FAILED_MESSAGE,
  ACCOUNT_DELETE_SESSION_EXPIRED_MESSAGE,
  ACCOUNT_DELETE_WRONG_PASSWORD_MESSAGE,
} from './accountMessages'

const passwordFormSchema = z.object({
  password: z.string().min(1, `${ACCOUNT_DELETE_PASSWORD_LABEL}を入力してください。`),
})

type PasswordFormValues = z.infer<typeof passwordFormSchema>

export type DeleteAccountDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  authProvider: WireAuthProvider
  /** Runs after the deletion Callable succeeded - the caller signs the browser out and navigates away. */
  onDeleted: () => void
}

/** Firebase Auth SDK reauth failures -> Japanese wording (mapAuthError's own message is Firebase's raw English string). */
function reauthErrorMessage(error: unknown): string {
  if (isApiError(error) && error.kind === 'unauthorized') return ACCOUNT_DELETE_WRONG_PASSWORD_MESSAGE
  return ACCOUNT_DELETE_REAUTH_FAILED_MESSAGE
}

/**
 * deleteAccountWithPassword/deleteAccountWithGoogle failures (via invoke(),
 * callable.ts's CODE_MAP).
 *
 * `'domainsOwned'` is the backend's own domain-ownership guard firing after
 * this dialog's own `listDomains` pre-check either let the request through
 * (0 domains at open, one created in the meantime) or itself failed to load
 * (see `useDomainOwnershipCheck` below) — same wording either way, so the
 * member sees one consistent explanation regardless of which check caught it.
 */
function deleteErrorMessage(error: unknown): string {
  if (isApiError(error) && error.kind === 'domainsOwned') {
    return accountDeleteDomainsOwnedMessage(error.domainCount ?? 0)
  }
  if (isApiError(error) && error.kind === 'validation') return ACCOUNT_DELETE_SESSION_EXPIRED_MESSAGE
  if (isApiError(error) && error.kind === 'forbidden') return ACCOUNT_DELETE_PROVIDER_MISMATCH_MESSAGE
  return ACCOUNT_DELETE_REAUTH_FAILED_MESSAGE
}

/** Result of the dialog-open domain-ownership pre-check. */
type DomainOwnershipCheck =
  | { status: 'checking' }
  | { status: 'clear' }
  | { status: 'blocked'; count: number }

/**
 * Runs `listDomains` once per dialog open (the body remounts fresh every
 * open, per the module doc comment) and reports whether the member still
 * owns any domain right now.
 *
 * Excludes `lifecycle === 'gone'` domains (a completed outbound transfer, or
 * a deletion whose redemption window already closed) from the count, same
 * as the backend guard (`functions/src/auth/account-lifecycle.ts`'s
 * `countOwnedDomainsInTransaction`): a member who properly retired or
 * transferred away every domain must still be able to reach the confirm
 * step, or this dialog's own "先にドメインを廃止または移管してください"
 * guidance would be a dead end. `MyDomainSummary.lifecycle` already carries
 * this bucket (`api/myDomainsApi.ts`'s `summaryFromListItem`), so no
 * separate derivation is needed here.
 *
 * Fails open on a load error: this is a defense-in-depth UX nicety, not the
 * authoritative check - `prepareDeletion` on the backend re-checks inside
 * the same transaction that would commit the deletion, so a member is never
 * able to delete an account they truly still own domains under just because
 * this pre-check could not load.
 *
 * @return {DomainOwnershipCheck} The live pre-check result.
 */
function useDomainOwnershipCheck(): DomainOwnershipCheck {
  const [check, setCheck] = useState<DomainOwnershipCheck>({ status: 'checking' })

  useEffect(() => {
    const controller = new AbortController()
    fetchMyDomains(controller.signal)
      .then(({ domains }) => {
        if (controller.signal.aborted) return
        const owned = domains.filter((domain) => domain.lifecycle !== 'gone')
        setCheck(owned.length > 0 ? { status: 'blocked', count: owned.length } : { status: 'clear' })
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setCheck({ status: 'clear' })
      })
    return () => controller.abort()
  }, [])

  return check
}

export function DeleteAccountDialog({ open, onOpenChange, ...bodyProps }: DeleteAccountDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DeleteAccountDialogBody onOpenChange={onOpenChange} {...bodyProps} />
      </DialogContent>
    </Dialog>
  )
}

function DeleteAccountDialogBody({
  onOpenChange,
  authProvider,
  onDeleted,
}: Omit<DeleteAccountDialogProps, 'open'>) {
  const [step, setStep] = useState<'explain' | 'confirm'>('explain')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const domainCheck = useDomainOwnershipCheck()

  const form = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { password: '' },
  })

  async function handlePasswordSubmit(values: PasswordFormValues) {
    setBusy(true)
    setError(null)
    try {
      await reauthenticateWithPassword(values.password)
    } catch (reauthError) {
      setBusy(false)
      setError(reauthErrorMessage(reauthError))
      return
    }
    try {
      await deleteAccountWithPassword()
    } catch (deleteError) {
      setBusy(false)
      setError(deleteErrorMessage(deleteError))
      return
    }
    setBusy(false)
    onOpenChange(false)
    onDeleted()
  }

  async function handleGoogleDelete() {
    setBusy(true)
    setError(null)
    try {
      await reauthenticateWithGoogle()
    } catch (reauthError) {
      setBusy(false)
      // A closed popup / a second popup racing the first (mapAuthError's
      // 'unknown' kind) is not a failure worth surfacing - the member can
      // just press the button again.
      if (isApiError(reauthError) && reauthError.kind === 'unknown') return
      setError(reauthErrorMessage(reauthError))
      return
    }
    try {
      await deleteAccountWithGoogle()
    } catch (deleteError) {
      setBusy(false)
      setError(deleteErrorMessage(deleteError))
      return
    }
    setBusy(false)
    onOpenChange(false)
    onDeleted()
  }

  if (step === 'explain') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>退会しますか？</DialogTitle>
          <DialogDescription>退会する前に、影響と猶予期間をご確認ください。</DialogDescription>
        </DialogHeader>

        {domainCheck.status === 'blocked' ? (
          <StatusBanner
            tone="error"
            action={
              <Button asChild variant="outline" size="sm">
                <Link to="/mypage">ドメイン一覧へ</Link>
              </Button>
            }
          >
            {accountDeleteDomainsOwnedMessage(domainCheck.count)}
          </StatusBanner>
        ) : null}

        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{ACCOUNT_DELETE_IMPACT_WARNING}</AlertTitle>
          <AlertDescription>
            <p>{ACCOUNT_DELETE_GRACE_EXPLANATION}</p>
          </AlertDescription>
        </Alert>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            キャンセル
          </Button>
          <Button
            variant="destructive"
            disabled={domainCheck.status !== 'clear'}
            onClick={() => setStep('confirm')}
          >
            次へ
          </Button>
        </DialogFooter>
      </>
    )
  }

  if (authProvider === 'google.com') {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Googleで本人確認して退会します</DialogTitle>
          <DialogDescription>
            確認のため、もう一度 Google アカウントでログインしてください。
          </DialogDescription>
        </DialogHeader>

        {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => setStep('explain')}>
            戻る
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void handleGoogleDelete()}>
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {busy ? '退会しています…' : 'Googleで再認証して退会する'}
          </Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>パスワードを入力して退会します</DialogTitle>
        <DialogDescription>確認のため、現在のパスワードを入力してください。</DialogDescription>
      </DialogHeader>

      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

      <Form {...form}>
        <form
          onSubmit={(event) => void form.handleSubmit(handlePasswordSubmit)(event)}
          noValidate
          className="space-y-4"
        >
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{ACCOUNT_DELETE_PASSWORD_LABEL}</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete="current-password"
                    placeholder={ACCOUNT_DELETE_PASSWORD_PLACEHOLDER}
                    disabled={busy}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setStep('explain')}>
              戻る
            </Button>
            <Button type="submit" variant="destructive" disabled={busy}>
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {busy ? '退会しています…' : '退会する'}
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </>
  )
}
