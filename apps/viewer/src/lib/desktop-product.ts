/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ChatUsage } from '@/store';
import { isClerkConfigured } from './llm/clerk-auth';

export type DesktopPlanTier = 'free' | 'pro';

export type DesktopFeature =
  | 'viewer_basic'
  | 'exports'
  | 'ids_validation'
  | 'bcf_issue_management'
  | 'ai_assistant';

interface DesktopFeatureDefinition {
  label: string;
  description: string;
  free: boolean;
}

const DESKTOP_FEATURES: Record<DesktopFeature, DesktopFeatureDefinition> = {
  viewer_basic: {
    label: 'Desktop viewer',
    description: 'Open IFC files, inspect hierarchy and properties, navigate, section, and measure offline.',
    free: true,
  },
  exports: {
    label: 'Exports',
    description: 'IFC export, GLB, CSV, JSON, screenshots, and other native save flows.',
    free: false,
  },
  ids_validation: {
    label: 'IDS validation',
    description: 'Load IDS files, validate models, inspect results, and export validation reports.',
    free: false,
  },
  bcf_issue_management: {
    label: 'BCF issue management',
    description: 'Create, import, edit, and export BCF topics with viewpoints and screenshots.',
    free: false,
  },
  ai_assistant: {
    label: 'AI assistant',
    description: 'Script repair and model generation with the same monthly LLM limits and routing as web.',
    free: false,
  },
};

export function isDesktopBillingEnforced(): boolean {
  return isClerkConfigured();
}

export function getDesktopPlanTier(hasPro: boolean): DesktopPlanTier {
  return hasPro ? 'pro' : 'free';
}

export function hasDesktopFeatureAccess(hasPro: boolean, feature: DesktopFeature): boolean {
  if (!isDesktopBillingEnforced()) {
    return true;
  }
  if (hasPro) {
    return true;
  }
  return DESKTOP_FEATURES[feature].free;
}

export function getDesktopFeatureCatalog(hasPro: boolean) {
  return (Object.entries(DESKTOP_FEATURES) as Array<[DesktopFeature, DesktopFeatureDefinition]>).map(([key, value]) => ({
    key,
    ...value,
    enabled: hasDesktopFeatureAccess(hasPro, key),
  }));
}

export function buildDesktopUpgradeUrl(returnTo?: string): string {
  const fallbackReturnTo = typeof window !== 'undefined'
    ? `${window.location.pathname}${window.location.search}`
    : '/';
  const nextReturnTo = returnTo ?? fallbackReturnTo;
  return `/upgrade?returnTo=${encodeURIComponent(nextReturnTo)}`;
}

export function getDesktopPlanSummary(hasPro: boolean, usage: ChatUsage | null): string {
  if (!isDesktopBillingEnforced()) {
    return 'Auth and billing are not configured in this build.';
  }
  if (hasPro) {
    if (usage) {
      const unit = usage.type === 'credits' ? 'credits' : 'requests';
      return `Pro plan active. AI usage: ${usage.used}/${usage.limit} ${unit}.`;
    }
    return 'Pro plan active. AI assistant limits follow the same monthly quota system as web.';
  }
  return 'Free plan active. The desktop viewer stays available, while Pro unlocks advanced app-wide features.';
}
