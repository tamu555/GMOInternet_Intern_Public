/**
 * マイページ：プロフィール表示・編集 & 退会 (/mypage/profile, docs/仕様/auth.md §4.8).
 *
 * No FIG.* diagram covers this screen (net-new feature, see the feature's
 * codebase research doc §1.2) - it follows the same load/view/edit/StatusBanner
 * conventions as the rest of マイページ (MyPage.tsx) instead.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Pencil } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBanner } from '../../components/StatusBanner'
import { messageForError } from '../../api/apiError'
import { getMyProfile, profileToFormDefaults, updateMyProfile, type MyProfile } from '../../api/profileApi'
import { useAuth } from '../../auth/useAuth'
import type { ContractFormValues } from '../signup/contractSchema'
import { ACCOUNT_DELETE_SUCCESS_MESSAGE } from './accountMessages'
import { DeleteAccountDialog } from './DeleteAccountDialog'
import { ProfileEditForm } from './ProfileEditForm'
import { ProfileViewSection } from './ProfileViewSection'

function ProfileSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3, 4].map((row) => (
        <Skeleton key={row} className="h-5 w-full max-w-md" />
      ))}
    </div>
  )
}

export function ProfilePage() {
  const { logout } = useAuth()
  const [profile, setProfile] = useState<MyProfile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await getMyProfile()
      if (signal?.aborted) return
      setProfile(result)
      setLoadError(null)
    } catch (error) {
      if (signal?.aborted) return
      setLoadError(messageForError(error))
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // oxlint-disable-next-line react/set-state-in-effect -- fetch-on-mount: every setState happens after an await.
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  async function handleSave(values: ContractFormValues) {
    setSaving(true)
    setSaveError(null)
    try {
      const result = await updateMyProfile(values)
      setProfile(result)
      setEditing(false)
      setNotice('プロフィールを更新しました。')
    } catch (error) {
      setSaveError(messageForError(error))
    } finally {
      setSaving(false)
    }
  }

  function handleAccountDeleted() {
    toast.success(ACCOUNT_DELETE_SUCCESS_MESSAGE)
    // Backend already revoked refresh tokens (account-lifecycle.ts); this
    // just clears local state and navigates to /login, same as any other
    // deliberate logout (AuthProvider.tsx's logout()).
    void logout()
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <Button asChild variant="outline" size="sm" className="self-start">
        <Link to="/mypage">
          <ArrowLeft />
          マイページへ戻る
        </Link>
      </Button>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">プロフィール</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          登録内容の確認・変更や、アカウントの退会ができます。
        </p>
      </header>

      {loadError ? (
        <StatusBanner
          tone="error"
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              再読み込み
            </Button>
          }
        >
          {loadError}
        </StatusBanner>
      ) : null}

      {notice ? <StatusBanner tone="success">{notice}</StatusBanner> : null}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>登録情報</CardTitle>
            <CardDescription>メールアドレス・ログイン方法は変更できません。</CardDescription>
          </div>
          {profile?.profile && !editing ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil />
              編集
            </Button>
          ) : null}
        </CardHeader>
        <CardContent>
          {profile === null && !loadError ? <ProfileSkeleton /> : null}

          {profile?.profile ? (
            editing ? (
              <div className="space-y-4">
                {saveError ? <StatusBanner tone="error">{saveError}</StatusBanner> : null}
                <ProfileEditForm
                  defaultValues={profileToFormDefaults(profile.profile)}
                  submitting={saving}
                  onCancel={() => {
                    setEditing(false)
                    setSaveError(null)
                  }}
                  onSubmit={(values) => void handleSave(values)}
                />
              </div>
            ) : (
              <ProfileViewSection email={profile.email} authProvider={profile.authProvider} profile={profile.profile} />
            )
          ) : null}

          {profile !== null && !profile.profile ? (
            <p className="text-sm text-muted-foreground">
              プロフィール情報がまだ登録されていません。
            </p>
          ) : null}
        </CardContent>
      </Card>

      {profile ? (
        <Card>
          <CardHeader>
            <CardTitle>アカウントの削除（退会）</CardTitle>
            <CardDescription>
              退会すると、このアカウントでのログインやドメインの管理ができなくなります。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => setDeleteDialogOpen(true)}>
              退会する
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {profile ? (
        <DeleteAccountDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          authProvider={profile.authProvider}
          onDeleted={handleAccountDeleted}
        />
      ) : null}
    </div>
  )
}
