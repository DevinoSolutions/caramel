'use client'
// src/lib/analytics/agentSetupEvents.ts
//
// `agent_setup_copied {app, surface, agent}` (fleet agent-onboarding spec
// §1) — fired when the pill's copy affordance is used, or an agent chip is
// opened. Same never-throw guard as growthEvents.ts.
import * as Sentry from '@sentry/nextjs'
import posthog from 'posthog-js'
import { isPosthogActive } from './identity'

export type AgentSetupSurface = 'hero' | 'apps' | 'profile' | 'agent-setup'

export function trackAgentSetupCopied(props: {
    surface: AgentSetupSurface
    /** The agent chip clicked, or `'copy'` for the copy affordance itself. */
    agent: string
}): void {
    if (!isPosthogActive()) return
    try {
        posthog.capture('agent_setup_copied', {
            app: 'caramel',
            surface: props.surface,
            agent: props.agent,
        })
    } catch (error) {
        console.error('[analytics] agent_setup_copied failed', error)
        Sentry.captureException(error, {
            tags: { analytics_operation: 'agent_setup_copied' },
        })
    }
}
