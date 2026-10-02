/**
 * Routing and route guards (docs/api-flow-diagrams.html FIG.8).
 *
 * AuthProvider sits inside BrowserRouter so guards can read both the auth state
 * and the current location; every protected route is wrapped in <RequireAuth>,
 * and the two public auth screens in <RequireGuest>.
 */
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider } from '../auth/AuthProvider'
import { RequireAdditionalInfo } from '../auth/RequireAdditionalInfo'
import { RequireAuth } from '../auth/RequireAuth'
import { RequireGuest } from '../auth/RequireGuest'
import { LoginPage } from '../features/auth/LoginPage'
import { DomainSearchPage } from '../features/domains/DomainSearchPage'
import { DomainDetailPage } from '../features/mypage/DomainDetailPage'
import { MyPage } from '../features/mypage/MyPage'
import { ProfilePage } from '../features/mypage/ProfilePage'
import { TransferInPage } from '../features/transfer/TransferInPage'
import { GoogleAdditionalInfoPage } from '../features/signup/GoogleAdditionalInfoPage'
import { SignupLayout } from '../features/signup/SignupLayout'
import { SignupAccountPage } from '../features/signup/SignupAccountPage'
import { SignupVerifyPage } from '../features/signup/SignupVerifyPage'
import { SignupContractPage } from '../features/signup/SignupContractPage'
import { SignupConfirmPage } from '../features/signup/SignupConfirmPage'
import { SignupCompletePage } from '../features/signup/SignupCompletePage'
import { OrderApplicationPage } from '../features/orders/OrderApplicationPage'
import { OrderStatusPage } from '../features/orders/OrderStatusPage'
import { DnsSetupPage } from '../features/dns/DnsSetupPage'
import { EasyLayout } from '../features/easy/EasyLayout'
import { EasyGoalPage } from '../features/easy/EasyGoalPage'
import { EasyNamePage } from '../features/easy/EasyNamePage'
import { EasyNameResultsPage } from '../features/easy/EasyNameResultsPage'
import { EasyTldPage } from '../features/easy/EasyTldPage'
import { EasyConfirmPage } from '../features/easy/EasyConfirmPage'
import { EasyPaymentPage } from '../features/easy/EasyPaymentPage'
import { EasyDnsPage } from '../features/easy/EasyDnsPage'
import { EasyDonePage } from '../features/easy/EasyDonePage'
import { EasyEntryPage } from '../features/easy/EasyEntryPage'
import { DashboardPage } from '../pages/DashboardPage'
import { NotFoundPage } from '../pages/NotFoundPage'
import { ThirdPartyLicensesPage } from '../pages/ThirdPartyLicensesPage'
import { AppLayout } from './AppLayout'

/**
 * The search screen used to live at /domains (protected); it is now the public
 * top page. Old links keep working via this redirect, query string included.
 */
function DomainsLegacyRedirect() {
  const location = useLocation()
  return <Navigate to={{ pathname: '/', search: location.search }} replace />
}

export function AppRouter() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route element={<AppLayout />}>
            {/* Top page = domain search, PUBLIC on purpose (FIG.1): searching,
                availability, pricing and suggestions never require a login.
                Only the application flow onwards (/domains/new, /orders/…) is
                guarded. */}
            <Route index element={<DomainSearchPage />} />

            <Route
              path="/login"
              element={
                <RequireGuest>
                  <LoginPage />
                </RequireGuest>
              }
            />
            {/* /register is retired in favor of the /signup wizard (full-profile
                registration). Redirect, not a 404, per the feature's risk note
                on external links still pointing at the old path. */}
            <Route path="/register" element={<Navigate to="/signup" replace />} />

            {/* 新規登録ウィザード (アカウント作成 → メール認証 → 契約者情報 →
                内容確認 → 完了). SignupLayout mounts the shared wizard state +
                stepper; per-step prerequisites live in useSignupGate (the
                completed step logs the member in, so a blanket RequireGuest
                would evict the 完了 screen - see useSignupGate.tsx). */}
            <Route element={<SignupLayout />}>
              <Route path="/signup" element={<SignupAccountPage />} />
              <Route path="/signup/verify" element={<SignupVerifyPage />} />
              <Route path="/signup/contract" element={<SignupContractPage />} />
              <Route path="/signup/confirm" element={<SignupConfirmPage />} />
              <Route path="/signup/complete" element={<SignupCompletePage />} />
            </Route>

            {/* Google sign-in additional-info screen: a SIBLING of the wizard
                group above, not nested inside it - a Google user never mounts
                SignupProvider/the stepper (see the feature's architecture
                doc §1.3). Guarded by its own RequireAdditionalInfo, not
                useSignupGate. */}
            <Route
              path="/signup/additional-info"
              element={
                <RequireAdditionalInfo>
                  <GoogleAdditionalInfoPage />
                </RequireAdditionalInfo>
              }
            />

            {/* FIG.9-10: マイページ（保有ドメイン一覧・詳細）。/ (旧 /domains) は
                検索画面のため、一覧は /mypage 配下に置く（frontend/README.md）。 */}
            <Route
              path="/mypage"
              element={
                <RequireAuth>
                  <MyPage />
                </RequireAuth>
              }
            />
            {/* §6.6.2 移管IN: 申請フォーム。進捗はマイページの区画が表示する。 */}
            <Route
              path="/mypage/transfer"
              element={
                <RequireAuth>
                  <TransferInPage />
                </RequireAuth>
              }
            />
            {/* docs/仕様/auth.md §4.8: プロフィール表示・編集 & 退会。FIG.9-10とは
                独立した net-new 画面 (feature codebase research doc §1.2)。 */}
            <Route
              path="/mypage/profile"
              element={
                <RequireAuth>
                  <ProfilePage />
                </RequireAuth>
              }
            />
            <Route
              path="/mypage/domains/:domainName"
              element={
                <RequireAuth>
                  <DomainDetailPage />
                </RequireAuth>
              }
            />
            <Route
              path="/dashboard"
              element={
                <RequireAuth>
                  <DashboardPage />
                </RequireAuth>
              }
            />
            <Route path="/domains" element={<DomainsLegacyRedirect />} />
            <Route
              path="/domains/new"
              element={
                <RequireAuth>
                  <OrderApplicationPage />
                </RequireAuth>
              }
            />
            <Route
              path="/orders/:orderId"
              element={
                <RequireAuth>
                  <OrderStatusPage />
                </RequireAuth>
              }
            />
            <Route
              path="/domains/:domainName/dns"
              element={
                <RequireAuth>
                  <DnsSetupPage />
                </RequireAuth>
              }
            />
            {/* かんたんモード（初心者向けウィザード）。EasyLayout がウィザードの
                状態（EasyProvider）とステップナビゲーションを 1 回だけマウントし、
                各ステップは自分の前提条件を useEasyGate で確認する。

                目的・ドメイン名・末尾の 3 ステップは PUBLIC。検索と同じく、
                ログインなしで試せることに価値があるため。契約内容の確認から先は
                RequireAuth で保護され、未ログインなら returnTo 付きで /login へ
                送られる（FIG.8）。入力内容は localStorage に残るので、ログインや
                新規登録を挟んでも同じステップに戻ってこられる。 */}
            <Route path="/easy" element={<EasyLayout />}>
              <Route index element={<EasyEntryPage />} />
              <Route path="goal" element={<EasyGoalPage />} />
              <Route path="name" element={<EasyNamePage />} />
              {/* 検索結果はステップ2の続き（ステッパー上は「名前」のまま）。
                  easyTypes.ts の EASY_NAME_RESULTS_PATH がこのパスの正。 */}
              <Route path="name/results" element={<EasyNameResultsPage />} />
              <Route path="tld" element={<EasyTldPage />} />
              <Route
                path="confirm"
                element={
                  <RequireAuth>
                    <EasyConfirmPage />
                  </RequireAuth>
                }
              />
              <Route
                path="payment"
                element={
                  <RequireAuth>
                    <EasyPaymentPage />
                  </RequireAuth>
                }
              />
              <Route
                path="dns"
                element={
                  <RequireAuth>
                    <EasyDnsPage />
                  </RequireAuth>
                }
              />
              <Route
                path="done"
                element={
                  <RequireAuth>
                    <EasyDonePage />
                  </RequireAuth>
                }
              />
            </Route>

            {/* §19.2: 公開ページ（未認証でも閲覧可）。Apache-2.0 の NOTICE 保持義務
                （@mlc-ai/web-llm・Qwen3 モデル）を満たすための第三者ライセンス表示。 */}
            <Route path="/legal/third-party-licenses" element={<ThirdPartyLicensesPage />} />

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}
