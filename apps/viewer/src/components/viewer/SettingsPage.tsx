/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { SignInButton, SignedIn, SignedOut, UserButton, useAuth, useUser } from '@clerk/clerk-react';
import { ArrowLeft, Check, CreditCard, FolderOpen, LayoutPanelTop, Lock, Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { useViewerStore } from '@/store';
import { buildDesktopUpgradeUrl, getDesktopFeatureCatalog, getDesktopPlanSummary, getDesktopPlanTier, isDesktopBillingEnforced } from '@/lib/desktop-product';
import { isClerkConfigured } from '@/lib/llm/clerk-auth';
import { navigateToPath } from '@/services/app-navigation';
import {
  getDesktopPreferences,
  subscribeDesktopPreferences,
  updateDesktopPreferences,
} from '@/services/desktop-preferences';

export function SettingsPage() {
  const clerkEnabled = isClerkConfigured();
  const chatHasPro = useViewerStore((s) => s.chatHasPro);
  const chatUsage = useViewerStore((s) => s.chatUsage);
  const [preferences, setPreferences] = useState(() => getDesktopPreferences());
  const returnTo = (() => {
    const params = new URLSearchParams(window.location.search);
    const candidate = params.get('returnTo');
    return candidate && candidate.startsWith('/') ? candidate : '/';
  })();
  useEffect(() => subscribeDesktopPreferences(() => {
    setPreferences(getDesktopPreferences());
  }), []);

  const updatePreference = (updates: Partial<typeof preferences>) => {
    setPreferences(updateDesktopPreferences(updates));
  };
  const planTier = getDesktopPlanTier(chatHasPro);
  const planSummary = getDesktopPlanSummary(chatHasPro, chatUsage);
  const featureCatalog = getDesktopFeatureCatalog(chatHasPro);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-4xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigateToPath(returnTo, { replace: true })}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Viewer
          </Button>
        </div>

        <div className="space-y-6">
          <section className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="mb-5 flex items-center gap-3">
              <Settings2 className="h-5 w-5" />
              <div>
                <h1 className="text-2xl font-semibold">Desktop Settings</h1>
                <p className="text-sm text-muted-foreground">
                  Local preferences for startup behavior and account access.
                </p>
              </div>
            </div>

              <div className="space-y-5">
              <div className="flex items-start justify-between gap-4 rounded-md border p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <FolderOpen className="h-4 w-4" />
                    Reopen last model on launch
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Automatically load the most recently used IFC file when the desktop app starts.
                  </p>
                </div>
                <Switch
                  checked={preferences.reopenLastModelOnLaunch}
                  onCheckedChange={(checked) => updatePreference({ reopenLastModelOnLaunch: checked })}
                />
              </div>

              <div className="flex items-start justify-between gap-4 rounded-md border p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-medium">
                    <LayoutPanelTop className="h-4 w-4" />
                    Restore workspace layout
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Restore panel visibility, camera view, sectioning, and other saved workspace state on launch.
                  </p>
                </div>
                <Switch
                  checked={preferences.restoreWorkspaceLayoutOnLaunch}
                  onCheckedChange={(checked) => updatePreference({ restoreWorkspaceLayoutOnLaunch: checked })}
                />
              </div>
            </div>
          </section>

          <section className="rounded-lg border bg-card p-6 shadow-sm">
              <div className="mb-5 flex items-center gap-3">
                <CreditCard className="h-5 w-5" />
                <div>
                  <h2 className="text-xl font-semibold">Account & Billing</h2>
                  <p className="text-sm text-muted-foreground">
                  Desktop billing is app-wide. The viewer stays available on Free, while Pro unlocks advanced desktop features and full AI access.
                  </p>
                </div>
              </div>

            <div className="mb-5 rounded-md border p-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium capitalize">{planTier} plan</div>
                  <p className="text-sm text-muted-foreground">{planSummary}</p>
                </div>
                {isDesktopBillingEnforced() && !chatHasPro && (
                  <Button onClick={() => navigateToPath(buildDesktopUpgradeUrl('/settings'))}>
                    Upgrade to Pro
                  </Button>
                )}
              </div>
            </div>

            <div className="mb-5 grid gap-3">
              {featureCatalog.map((feature) => (
                <div key={feature.key} className="flex items-start justify-between gap-4 rounded-md border p-4">
                  <div>
                    <div className="font-medium">{feature.label}</div>
                    <p className="text-sm text-muted-foreground">{feature.description}</p>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    {feature.enabled ? (
                      <>
                        <Check className="h-4 w-4 text-emerald-500" />
                        Included
                      </>
                    ) : (
                      <>
                        <Lock className="h-4 w-4 text-amber-500" />
                        Pro
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {!clerkEnabled ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                Auth and billing are not configured in this build. Set `VITE_CLERK_PUBLISHABLE_KEY` to enable sign-in and subscription flows.
              </div>
            ) : (
              <SettingsAccountSection />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function SettingsAccountSection() {
  const { has, isSignedIn } = useAuth();
  const { user } = useUser();
  const hasPro = isSignedIn && (has?.({ plan: 'pro' }) ?? has?.({ feature: 'pro_models' }) ?? false);

  return (
    <div className="space-y-4">
      <SignedOut>
        <div className="rounded-md border p-4">
          <p className="mb-3 text-sm text-muted-foreground">
            Sign in to manage your plan and unlock paid AI models.
          </p>
          <SignInButton mode="modal" forceRedirectUrl="/settings" fallbackRedirectUrl="/settings">
            <Button>Sign in</Button>
          </SignInButton>
        </div>
      </SignedOut>

      <SignedIn>
        <div className="flex items-center justify-between gap-4 rounded-md border p-4">
          <div>
            <div className="font-medium">
              {user?.primaryEmailAddress?.emailAddress ?? user?.username ?? 'Signed in'}
            </div>
            <p className="text-sm text-muted-foreground">
              Plan: {hasPro ? 'Pro' : 'Free'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <UserButton afterSignOutUrl="/" />
            <Button onClick={() => navigateToPath(buildDesktopUpgradeUrl('/settings'))}>
              {hasPro ? 'Manage Plan' : 'Upgrade to Pro'}
            </Button>
          </div>
        </div>
      </SignedIn>
    </div>
  );
}
